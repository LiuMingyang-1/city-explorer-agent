import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseSchedule, availabilityOnDate } from "./schedule.ts";
import type { EventRepository } from "./repository.ts";
import { ensureEventsSchema } from "./schema.ts";
import type { Event, SearchEventsInput } from "./types.ts";

/**
 * 活动库的 SQLite repository。表结构与迁移见 ./schema.ts（EVENTS_TABLE_DDL
 * 与 ensureEventsSchema 经此转发，seed 等既有引用保持不变）。
 * 实现使用 Node 内置 node:sqlite 的 DatabaseSync（>=22.13 无需 flag），无原生依赖。
 */
export { EVENTS_TABLE_DDL, ensureEventsSchema } from "./schema.ts";

/** search 无条件时的返回上限；有条件时同样生效，防止把整库塞给模型。 */
const SEARCH_LIMIT = 100;

/** 地球半径（公里），haversine 球面距离用。 */
const EARTH_RADIUS_KM = 6371;

type EventRow = {
  time_note?: string | null; time_status?: "complete" | "partial" | "unknown" | "conflicting";
  record_type?: "activity" | "attraction"; city?: string; amap_poi_id?: string | null; valid_from?: string | null; valid_to?: string | null; schedule_json?: string | null; status?: string; source_published_at?: string | null; source_updated_at?: string | null; fetched_at?: string | null; updated_at?: string | null;
  id: string;
  title: string;
  description: string;
  category: string;
  venue_name: string;
  address: string;
  latitude: number;
  longitude: number;
  start_at: string | null;
  end_at: string | null;
  suggested_duration_minutes: number | null;
  budget_min: number | null;
  budget_max: number | null;
  currency: string;
  budget_note: string | null;
  guide_url: string | null;
  thumbnail_url: string | null;
  image_urls: string;
};

/**
 * image_urls 读边界检查：CHECK 已保证列值是 JSON 数组，这里再确认元素
 * 都是字符串；库内数据损坏时报错而不是静默丢图。
 */
function parseImageUrls(raw: string): string[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`events.image_urls 必须是 JSON 字符串数组，得到 ${raw}`);
  }
  return value;
}

function toEvent(row: EventRow): Event {
  return {
    ...(row.record_type === "attraction" || row.schedule_json || row.valid_from || row.valid_to || row.fetched_at || row.status && row.status !== "unknown" ? {
      recordType: row.record_type ?? "activity", coordinateSystem: "GCJ-02" as const, city: row.city, amapPoiId: row.amap_poi_id,
      timeNote: row.time_note ?? null, timeStatus: row.time_status ?? "unknown",
      validFrom: row.valid_from ?? null, validTo: row.valid_to ?? null, schedule: parseSchedule(row.schedule_json), status: row.status,
      sourcePublishedAt: row.source_published_at ?? null, sourceUpdatedAt: row.source_updated_at ?? null, fetchedAt: row.fetched_at ?? null, updatedAt: row.updated_at ?? null,
    } : {}),
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    venueName: row.venue_name,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    startAt: row.start_at,
    endAt: row.end_at,
    suggestedDurationMinutes: row.suggested_duration_minutes,
    budgetMin: row.budget_min,
    budgetMax: row.budget_max,
    currency: row.currency,
    budgetNote: row.budget_note,
    guideUrl: row.guide_url,
    thumbnailUrl: row.thumbnail_url,
    imageUrls: parseImageUrls(row.image_urls),
  };
}

/** LIKE 关键字转义，配合 ESCAPE '\' 使用。 */
function escapeLike(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 两经纬度点间的球面距离（haversine），返回公里数。 */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/** 打开（必要时创建）SQLite 活动库，返回 EventRepository 实现。 */
export function createSqliteEventRepository(dbPath: string, options: { readOnly?: boolean; isAvailable?: (id: string) => boolean } = {}): EventRepository {
  if (dbPath !== ":memory:" && !options.readOnly) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath, { readOnly: options.readOnly ?? false });
  try {
    if (!options.readOnly) ensureEventsSchema(db);
    if (options.isAvailable) db.function("collection_available", id => options.isAvailable!(String(id)) ? 1 : 0);
  } catch (error) { db.close(); throw error; }

  return {
    search(input: SearchEventsInput): Promise<Event[]> {
      // Collection candidates may have NULL coordinates; they are not published events.
      const clauses: string[] = ["latitude IS NOT NULL", "longitude IS NOT NULL"];
      if (options.isAvailable) clauses.push("collection_available(id) = 1");
      const params: string[] = [];
      if (input.recordType) { clauses.push("record_type = ?"); params.push(input.recordType); }
      clauses.push("status NOT IN ('paused','cancelled','ended')");
      if (input.category) {
        clauses.push("category = ?");
        params.push(input.category);
      }
      if (input.keyword) {
        const pattern = `%${escapeLike(input.keyword)}%`;
        clauses.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
        params.push(pattern, pattern);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      // Resolve all date rules before LIMIT so closed early rows cannot hide an open one.
      const rows = db.prepare(`SELECT * FROM events ${where} ORDER BY start_at, id`).all(...params) as EventRow[];
      let events = rows.map(toEvent);
      if (input.date) {
        events = events.flatMap(event => {
          const availability = availabilityOnDate(event, input.date!);
          if (availability.state === "closed") return [];
          if (!event.recordType && availability.state === "unknown") return [];
          const one = availability.windows.length === 1 ? availability.windows[0] : null;
          return [{ ...event, ...(event.recordType ? { availableWindows: availability.windows, availability: availability.state,
            startAt: one?.startAt ?? null, endAt: one?.endAt ?? null } : {}) }];
        });
      }
      if (input.near) {
        const { lat, lng } = input.near;
        let distances = events.map(event => ({ event, distance: haversineKm(lat, lng, event.latitude, event.longitude) }));
        if (input.radiusKm != null) distances = distances.filter(e => e.distance <= input.radiusKm!);
        distances.sort((a,b) => a.distance-b.distance);
        return Promise.resolve(distances.slice(0, SEARCH_LIMIT).map(({event,distance}) => ({...event,distanceKm:Math.round(distance*100)/100})));
      }
      return Promise.resolve(events.slice(0, SEARCH_LIMIT));
    },

    getByIds(ids: string[]): Promise<Map<string, Event>> {
      const result = new Map<string, Event>();
      if (ids.length === 0) return Promise.resolve(result);
      const marks = ids.map(() => "?").join(", ");
      const rows = db
        .prepare(`SELECT * FROM events WHERE id IN (${marks}) AND latitude IS NOT NULL AND longitude IS NOT NULL`)
        .all(...ids) as EventRow[];
      for (const row of rows) result.set(row.id, toEvent(row));
      return Promise.resolve(result);
    },

    close(): void {
      db.close();
    },
  };
}

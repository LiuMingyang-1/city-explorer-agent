import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  id: string;
  title: string;
  description: string;
  category: string;
  venue_name: string;
  address: string;
  latitude: number;
  longitude: number;
  start_at: string;
  end_at: string;
  suggested_duration_minutes: number;
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
export function createSqliteEventRepository(dbPath: string): EventRepository {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  ensureEventsSchema(db);

  return {
    search(input: SearchEventsInput): Promise<Event[]> {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (input.date) {
        // 活动时间窗与当日有交集即可参加（窗口可跨多日）。
        clauses.push("substr(start_at, 1, 10) <= ? AND substr(end_at, 1, 10) >= ?");
        params.push(input.date, input.date);
      }
      // from/to 是同一交集判定的两半：窗口终点不早于 from、起点不晚于 to。
      // 可单独给（开区间），与 date 叠加时按 AND 收窄。
      if (input.from) {
        clauses.push("substr(end_at, 1, 10) >= ?");
        params.push(input.from);
      }
      if (input.to) {
        clauses.push("substr(start_at, 1, 10) <= ?");
        params.push(input.to);
      }
      if (input.bbox) {
        clauses.push("longitude >= ? AND longitude <= ? AND latitude >= ? AND latitude <= ?");
        params.push(
          input.bbox.minLng,
          input.bbox.maxLng,
          input.bbox.minLat,
          input.bbox.maxLat,
        );
      }
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
      // limit 为 API 查询能力扩展；工具路径不传时仍走 SEARCH_LIMIT，
      // 防御性下限 1（LIMIT 0/-1 在 SQLite 里分别是空集/无限制，都不该是
      // 调用方能打出的语义）。
      const limit =
        input.limit !== undefined && Number.isFinite(input.limit)
          ? Math.max(1, Math.floor(input.limit))
          : SEARCH_LIMIT;
      const { near, radiusKm } = input;
      if (near) {
        // 距离是查询派生值：SQL 只做原条件过滤（不排序），取出后在 JS 侧
        // 算球面距离。radiusKm 过滤与升序排序都用未取整的原始距离——
        // 先取整会放宽半径边界、并列值还会丢掉真实次序；输出的
        // distanceKm 才保留两位小数。截断到 SEARCH_LIMIT 在排序后。
        const rows = db
          .prepare(`SELECT * FROM events ${where}`)
          .all(...params) as EventRow[];
        let events = rows.map((row) => ({
          event: toEvent(row),
          distance: haversineKm(near.lat, near.lng, row.latitude, row.longitude),
        }));
        if (radiusKm != null) {
          events = events.filter((e) => e.distance <= radiusKm);
        }
        events.sort((a, b) => a.distance - b.distance);
        return Promise.resolve(
          events.slice(0, limit).map(({ event, distance }) => ({
            ...event,
            distanceKm: Math.round(distance * 100) / 100,
          })),
        );
      }
      // 无 near 时单独传的 radiusKm 被忽略，维持原排序与上限。
      const rows = db
        .prepare(`SELECT * FROM events ${where} ORDER BY start_at, id LIMIT ?`)
        .all(...params, limit) as EventRow[];
      return Promise.resolve(rows.map(toEvent));
    },

    getByIds(ids: string[]): Promise<Map<string, Event>> {
      const result = new Map<string, Event>();
      if (ids.length === 0) return Promise.resolve(result);
      const marks = ids.map(() => "?").join(", ");
      const rows = db
        .prepare(`SELECT * FROM events WHERE id IN (${marks})`)
        .all(...ids) as EventRow[];
      for (const row of rows) result.set(row.id, toEvent(row));
      return Promise.resolve(result);
    },

    close(): void {
      db.close();
    },
  };
}

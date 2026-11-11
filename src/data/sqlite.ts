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
      const params: string[] = [];
      if (input.date) {
        // 活动时间窗与当日有交集即可参加（窗口可跨多日）。
        clauses.push("substr(start_at, 1, 10) <= ? AND substr(end_at, 1, 10) >= ?");
        params.push(input.date, input.date);
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
      const rows = db
        .prepare(`SELECT * FROM events ${where} ORDER BY start_at, id LIMIT ?`)
        .all(...params, SEARCH_LIMIT) as EventRow[];
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

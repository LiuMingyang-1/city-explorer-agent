import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureEventsSchema } from "./schema.ts";
import { eventExtras } from "./seed-extras.ts";
import { TEMPLATES, VENUES } from "./seed-templates.ts";
import type { Event } from "./types.ts";

/**
 * 模拟活动种子数据：默认城市为西安，场地、地址、活动均为虚构 mock 数据，
 * 不是真实活动。生成对基准日期确定：同一 baseDate 结果完全一致，可重复测试。
 * 覆盖基准日起共 SEED_DAYS 天（含当天），每天混合时间窗活动与固定场次。
 * 费用、攻略与图片字段由模板 extras 确定性填充（见 seed-templates/seed-extras）。
 */

export const SEED_DAYS = 7;

function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** 生成基准日起 7 天的全部模拟活动；同一 baseDate 输出完全一致。 */
export function generateSeedEvents(baseDate: string): Event[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(baseDate)) {
    throw new Error(`baseDate must be YYYY-MM-DD, got: ${baseDate}`);
  }
  const base = parseDay(baseDate);
  if (formatDay(base) !== baseDate) {
    throw new Error(`baseDate is not a real calendar date: ${baseDate}`);
  }
  const events: Event[] = [];
  for (const t of TEMPLATES) {
    const [name, address, latitude, longitude] = VENUES[t.venue];
    for (const offset of t.days) {
      const day = formatDay(addDays(base, offset));
      const start = (t.at ?? t.open)!;
      const end = t.close ?? addMinutes(start, t.run ?? 0);
      const id = `evt_${String(events.length + 1).padStart(3, "0")}`;
      events.push({
        id,
        title: t.title,
        description: `${t.detail}（模拟数据，非真实活动）`,
        category: t.category,
        venueName: name,
        address,
        latitude,
        longitude,
        startAt: `${day}T${start}`,
        endAt: `${day}T${end}`,
        suggestedDurationMinutes: t.suggested,
        ...eventExtras(id, t),
      });
    }
  }
  return events;
}

const INSERT_EVENT = `INSERT INTO events (
  id, title, description, category, venue_name, address,
  latitude, longitude, start_at, end_at, suggested_duration_minutes,
  budget_min, budget_max, currency, budget_note, guide_url, thumbnail_url, image_urls
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * 把种子写入已打开的库：先清空再整体重插，重复执行条数不变。
 * 写入前经 ensureEventsSchema 补齐结构，v0 旧库缺新列时先迁移再插入。
 */
export function seedEvents(db: DatabaseSync, baseDate: string): number {
  ensureEventsSchema(db);
  const events = generateSeedEvents(baseDate);
  const insert = db.prepare(INSERT_EVENT);
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM events");
    for (const e of events) {
      insert.run(
        e.id, e.title, e.description, e.category, e.venueName, e.address,
        e.latitude, e.longitude, e.startAt, e.endAt, e.suggestedDurationMinutes,
        e.budgetMin, e.budgetMax, e.currency, e.budgetNote, e.guideUrl,
        e.thumbnailUrl, JSON.stringify(e.imageUrls),
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return events.length;
}

/** 打开（必要时创建）dbPath 并写入种子，完成后关闭连接，返回写入条数。 */
export function seedDatabase(dbPath: string, baseDate: string = formatDay(new Date())): number {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  try {
    return seedEvents(db, baseDate);
  } finally {
    db.close();
  }
}

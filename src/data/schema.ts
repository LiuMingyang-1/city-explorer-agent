import type { DatabaseSync } from "node:sqlite";

/**
 * events 表结构定义与幂等迁移。
 * 建表与 ALTER TABLE 共用同一份列定义（COLUMN_DEFS），保证新库一次建齐、
 * 旧库按需补列后两者结构一致。
 */

/** v0 既有列，对应 docs/database-design.md 的活动数据库字段。 */
const BASE_EVENT_COLUMNS: readonly string[] = [
  "id TEXT PRIMARY KEY",
  "title TEXT NOT NULL",
  "description TEXT NOT NULL",
  "category TEXT NOT NULL",
  "venue_name TEXT NOT NULL",
  "address TEXT NOT NULL",
  "latitude REAL NOT NULL",
  "longitude REAL NOT NULL",
  "start_at TEXT NOT NULL",
  "end_at TEXT NOT NULL",
  "suggested_duration_minutes INTEGER NOT NULL",
];

/**
 * v1 追加列：预算、攻略与图片链接，只存地址不存图片本体。
 * budget_min/budget_max 为每人预计费用（单位分；NULL=未知，0=免费），
 * 约束为非负整数且 min<=max（NULL 放行）。image_urls 是按展示顺序的
 * JSON 字符串数组：CHECK 保证列值为 JSON 数组，元素均为字符串由
 * repository 读边界检查（CHECK 内不能遍历 json_each）。
 */
export const ADDED_EVENT_COLUMNS: ReadonlyArray<{ name: string; definition: string }> = [
  {
    name: "budget_min",
    definition:
      "budget_min INTEGER CHECK (budget_min IS NULL OR (typeof(budget_min) = 'integer' AND budget_min >= 0))",
  },
  {
    name: "budget_max",
    definition:
      "budget_max INTEGER CHECK (budget_max IS NULL OR (typeof(budget_max) = 'integer' AND budget_max >= 0)) CHECK (budget_min IS NULL OR budget_max IS NULL OR budget_min <= budget_max)",
  },
  { name: "currency", definition: "currency TEXT NOT NULL DEFAULT 'CNY'" },
  { name: "budget_note", definition: "budget_note TEXT" },
  { name: "guide_url", definition: "guide_url TEXT" },
  { name: "thumbnail_url", definition: "thumbnail_url TEXT" },
  {
    name: "image_urls",
    definition:
      "image_urls TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(image_urls) AND json_type(image_urls) = 'array')",
  },
];

/** 完整建表语句：新库一次建齐 v0 + v1 全部列。 */
export const EVENTS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS events (
  ${[...BASE_EVENT_COLUMNS, ...ADDED_EVENT_COLUMNS.map((c) => c.definition)].join(",\n  ")}
)`;

/**
 * 保证 db 内 events 表具备完整 v1 结构：表不存在则建表，已存在则
 * 按 PRAGMA table_info 只补齐缺失列（ALTER TABLE ADD COLUMN，默认值
 * 回填既有行）。不清表、不改写已有记录；幂等，单事务执行。
 * repository 打开时调用，也供 seed 写入前复用。
 */
export function ensureEventsSchema(db: DatabaseSync): void {
  db.exec("BEGIN");
  try {
    db.exec(EVENTS_TABLE_DDL);
    const existing = new Set(
      (db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    for (const { name, definition } of ADDED_EVENT_COLUMNS) {
      if (!existing.has(name)) {
        db.exec(`ALTER TABLE events ADD COLUMN ${definition}`);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

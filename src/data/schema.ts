import type { DatabaseSync } from "node:sqlite";
import { CATEGORIES, SCENIC_LEVELS } from "./categories.ts";

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
  "latitude REAL DEFAULT NULL",
  "longitude REAL DEFAULT NULL",
  "start_at TEXT DEFAULT NULL",
  "end_at TEXT DEFAULT NULL",
  "suggested_duration_minutes INTEGER DEFAULT NULL",
];

/**
 * v1 追加列：预算、攻略与图片链接，只存地址不存图片本体。
 * budget_min/budget_max 为每人预计费用（单位分；NULL=未知，0=免费），
 * 约束为非负整数且 min<=max（NULL 放行）。image_urls 是按展示顺序的
 * JSON 字符串数组：CHECK 保证列值为 JSON 数组，元素均为字符串由
 * repository 读边界检查（CHECK 内不能遍历 json_each）。
 */
export const ADDED_EVENT_COLUMNS: ReadonlyArray<{ name: string; definition: string }> = [
  { name: "record_type", definition: "record_type TEXT NOT NULL DEFAULT 'activity' CHECK(record_type IN ('activity','attraction'))" },
  { name: "city", definition: "city TEXT NOT NULL DEFAULT '西安市'" },
  { name: "amap_poi_id", definition: "amap_poi_id TEXT DEFAULT NULL" },
  { name: "valid_from", definition: "valid_from TEXT DEFAULT NULL" },
  { name: "valid_to", definition: "valid_to TEXT DEFAULT NULL" },
  { name: "time_note", definition: "time_note TEXT DEFAULT NULL" },
  { name: "time_status", definition: "time_status TEXT NOT NULL DEFAULT 'unknown' CHECK(time_status IN ('complete','partial','unknown','conflicting'))" },
  { name: "schedule_json", definition: "schedule_json TEXT DEFAULT NULL CHECK(schedule_json IS NULL OR json_valid(schedule_json))" },
  { name: "status", definition: "status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('active','paused','cancelled','ended','unknown'))" },
  { name: "source_published_at", definition: "source_published_at TEXT DEFAULT NULL" },
  { name: "source_updated_at", definition: "source_updated_at TEXT DEFAULT NULL" },
  { name: "fetched_at", definition: "fetched_at TEXT DEFAULT NULL" },
  { name: "updated_at", definition: "updated_at TEXT DEFAULT NULL" },

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
const COLLECTION_CHECK = `CONSTRAINT events_collection_v4 CHECK (
  ${["id", "title", "description", "category", "venue_name", "address"].map(name => `${name} IS NOT NULL AND length(trim(${name}, char(9)||char(10)||char(13)||' ')) > 0`).join(" AND ")}
  AND ((record_type='activity' AND category IN (${CATEGORIES.map(value => `'${value}'`).join(",")})) OR (record_type='attraction' AND category IN (${SCENIC_LEVELS.map(value => `'${value}'`).join(",")})))
  AND ((latitude IS NULL AND longitude IS NULL) OR (
    latitude IS NOT NULL AND longitude IS NOT NULL
    AND typeof(latitude) IN ('real','integer') AND latitude BETWEEN -90 AND 90
    AND typeof(longitude) IN ('real','integer') AND longitude BETWEEN -180 AND 180))
  AND (suggested_duration_minutes IS NULL OR
    (typeof(suggested_duration_minutes)='integer' AND suggested_duration_minutes BETWEEN 1 AND 1440))
)`;

export const EVENTS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS events (
  ${[...BASE_EVENT_COLUMNS, ...ADDED_EVENT_COLUMNS.map((c) => c.definition), COLLECTION_CHECK].join(",\n  ")}
)`;

/** Remove the old final CHECK without discarding custom columns/indexes/triggers. */
function removeOldCollectionCheck(sql: string): string {
  const at = sql.indexOf("CONSTRAINT events_collection_v3");
  if (at < 0) return sql;
  const open = sql.indexOf("(", at); let depth = 0, end = open;
  for (; end < sql.length; end++) { if (sql[end] === "(") depth++; else if (sql[end] === ")" && --depth === 0) { end++; break; } }
  let tail = end; while (/\s/.test(sql[tail] ?? "") && tail < sql.length) tail++;
  if (sql[tail] === ",") return sql.slice(0, at) + sql.slice(tail + 1);
  let begin = at - 1; while (begin >= 0 && /\s/.test(sql[begin])) begin--;
  return sql.slice(0, sql[begin] === "," ? begin : at) + sql.slice(end);
}

/**
 * 保证 db 内 events 表具备完整 v1 结构：表不存在则建表，已存在则
 * 按 PRAGMA table_info 只补齐缺失列（ALTER TABLE ADD COLUMN，默认值
 * 回填既有行）。不清表、不改写已有记录；幂等，单事务执行。
 * repository 打开时调用，也供 seed 写入前复用。
 */
/** SQLite cannot DROP NOT NULL directly: rebuild only when one of the three
 * legacy columns still has the constraint, preserving rows, custom columns,
 * explicit indexes/triggers and the caller's foreign-key setting.
 */
export function ensureEventsSchema(db: DatabaseSync): void {
  if (db.isTransaction) throw new Error("ensureEventsSchema requires an outer transaction boundary");
  const foreignKeys = Number(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys);
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(EVENTS_TABLE_DDL);
      let columns = db.prepare("PRAGMA table_info(events)").all() as Array<{name: string; notnull: number}>;
      const existing = new Set(columns.map(c => c.name));
      for (const {name,definition} of ADDED_EVENT_COLUMNS) if (!existing.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${definition}`);
      columns = db.prepare("PRAGMA table_info(events)").all() as Array<{name: string; notnull: number}>;
      const nullable = ["latitude", "longitude", "start_at", "end_at", "suggested_duration_minutes"];
      const currentSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='events'").get()!.sql as string;
      const defaults = db.prepare("PRAGMA table_info(events)").all() as Array<{name:string;notnull:number;dflt_value:string|null}>;
      if (!currentSql.includes("CONSTRAINT events_collection_v4") || defaults.some(c => nullable.includes(c.name) && (c.notnull === 1 || c.dflt_value?.toUpperCase() !== "NULL"))) {
        const temporary = "events__nullable_migration";
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(temporary)) throw new Error("Migration temporary table already exists");
        const schema = removeOldCollectionCheck(currentSql);
        const unknown = db.prepare(`SELECT id FROM events WHERE category IS NULL OR (record_type='activity' AND category NOT IN (${CATEGORIES.map(() => "?").join(",")})) OR (record_type='attraction' AND category NOT IN (${SCENIC_LEVELS.map(() => "?").join(",")})) LIMIT 1`).get(...CATEGORIES, ...SCENIC_LEVELS);
        if (unknown) throw new Error("UNSUPPORTED_EXISTING_CATEGORY: migration stopped without changing rows");
        const extras = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='events' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as {sql: string}[];
        let replacement = schema.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"events"|`events`|\[events\]|events)(?=\s*\()/i, `CREATE TABLE "${temporary}"`);
        for (const name of nullable) {
          const declaration = new RegExp(`((?:"${name}"|${name})\\s+(?:TEXT|INTEGER|REAL))(?:\\s+NOT\\s+NULL)?(?:\\s+DEFAULT\\s+(?:NULL|[-+]?\\d+(?:\\.\\d+)?|'(?:[^']|'')*'))?`, "i");
          if (!declaration.test(replacement)) throw new Error(`Unsupported legacy column declaration: ${name}`);
          replacement = replacement.replace(declaration, "$1 DEFAULT NULL");
        }
        if (!replacement.includes("CONSTRAINT events_collection_v4")) {
          const closing = replacement.lastIndexOf(")");
          replacement = replacement.slice(0, closing) + ",\n" + COLLECTION_CHECK + replacement.slice(closing);
        }
        db.exec(replacement);
        const migrated = db.prepare(`PRAGMA table_info("${temporary}")`).all() as Array<{name:string;notnull:number;dflt_value:string|null}>;
        if (migrated.some(c => nullable.includes(c.name) && (c.notnull === 1 || c.dflt_value?.toUpperCase() !== "NULL"))) throw new Error("Unsupported legacy column declaration");
        const names = columns.map(c => `"${c.name.replaceAll('"','""')}"`).join(",");
        db.exec(`INSERT INTO "${temporary}" (${names}) SELECT ${names} FROM events`);
        db.exec(`DROP TABLE events`);
        db.exec(`ALTER TABLE "${temporary}" RENAME TO events`);
        for (const extra of extras) db.exec(extra.sql);
        if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Foreign key violation after events migration");
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`); }
}

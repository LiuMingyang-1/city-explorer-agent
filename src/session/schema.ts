import type { DatabaseSync } from "node:sqlite";

/**
 * 会话库表结构：users / sessions / session_records / runs / user_memory
 * 五表一次建齐，语义见 docs/users-and-sessions.md。全部 CREATE IF NOT
 * EXISTS，幂等；不做列迁移。
 *
 * 约束要点：
 * - kind='main' 是用户面对话会话（每用户可有多个，对话即 main）；
 *   kind='child' 专职表示子 Agent 派生的任务会话。
 * - sessions 自洽：main 无父、child 必有父；current_itinerary_record_id 仅 main。
 * - session_records: (session_id,seq)、(session_id,message_seq 仅 message)、
 *   (session_id,dedupe_key 非空) 三个唯一；message_seq 与 type 联动 CHECK；
 *   payload CHECK json_valid。
 * - runs: root_run_id 自引用（根 run 指自身），parent/reply_to 的跨用户
 *   校验在仓库层（FK 只保证存在性）。
 * - user_memory: 每用户一行长期记忆文档 + 蒸馏游标（through_message_seq）。
 */
export const SESSION_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  kind TEXT NOT NULL CHECK (kind IN ('main', 'child')),
  parent_session_id TEXT REFERENCES sessions(session_id),
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  current_itinerary_record_id TEXT REFERENCES session_records(record_id),
  lease_owner TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind = 'main' AND parent_session_id IS NULL) OR
    (kind = 'child' AND parent_session_id IS NOT NULL)
  ),
  CHECK (kind = 'main' OR current_itinerary_record_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_sessions_parent
  ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_activity
  ON sessions(user_id, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS session_records (
  record_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('message', 'compaction')),
  message_seq INTEGER,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  run_id TEXT REFERENCES runs(run_id),
  source_run_id TEXT REFERENCES runs(run_id),
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  CHECK ((type = 'message') = (message_seq IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_records_seq
  ON session_records(session_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_message_seq
  ON session_records(session_id, message_seq) WHERE type = 'message';
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_dedupe
  ON session_records(session_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  parent_run_id TEXT REFERENCES runs(run_id),
  root_run_id TEXT NOT NULL REFERENCES runs(run_id),
  reply_to_session_id TEXT REFERENCES sessions(session_id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  input TEXT NOT NULL CHECK (json_valid(input)),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_runs_user ON runs(user_id, created_at);

CREATE TABLE IF NOT EXISTS user_memory (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id),
  content TEXT NOT NULL,
  source_session_id TEXT,
  through_message_seq INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;

/**
 * 幂等建齐五表与索引；单事务，失败回滚。
 * 老库兼容：历史版本在 sessions(user_id) WHERE kind='main' 上有
 * idx_sessions_main 部分唯一索引（且 users 带 main_session_id 死列，
 * SQLite 不易 DROP COLUMN，保留无害、代码不再引用）；这里 DROP 掉
 * 旧索引，使老库升级后可建第二个 kind='main' 对话会话。
 */
export function ensureSessionSchema(db: DatabaseSync): void {
  db.exec("BEGIN");
  try {
    db.exec(SESSION_SCHEMA_DDL);
    db.exec("DROP INDEX IF EXISTS idx_sessions_main");
    // 老库补 version 列：PUT/DELETE/蒸馏的版本 CAS 依赖它。
    const memoryCols = db.prepare("PRAGMA table_info(user_memory)").all() as {
      name: string;
    }[];
    if (!memoryCols.some((col) => col.name === "version")) {
      db.exec("ALTER TABLE user_memory ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

import { afterResource } from "./resource-cleanup-fixture.ts";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ensureSessionSchema } from "../src/session/schema.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";
import {
  assistantMessage,
  makeUser,
  mustAcquire,
  openMemoryRepo,
  tempDbPath,
  userMessage,
} from "./session-fixture.ts";

test("schema is idempotent and persists across reopen on a file database", async (t) => {
  const dbPath = tempDbPath(t);
  const repo1 = createSqliteSessionRepository(dbPath);
  const { main } = await makeUser(repo1, "u-persist");
  const writer = await mustAcquire(repo1, "u-persist", main.sessionId);
  await repo1.appendMessage(writer, "u-persist", main.sessionId, {
    payload: { message: userMessage("你好") },
  });
  await repo1.appendMessage(writer, "u-persist", main.sessionId, {
    payload: { message: assistantMessage("回复") },
  });
  repo1.close();

  // 同一库文件重开：schema 重复执行无副作用，数据完整。
  const repo2 = createSqliteSessionRepository(dbPath);
  afterResource(t, () => repo2.close());
  const session = await repo2.getSession("u-persist", main.sessionId);
  assert.equal(session?.kind, "main");
  // 租约状态同样持久化（写入连接持有的租约在库里有记录）。
  assert.equal(session?.leaseOwner, "worker-1");
  assert.equal(session?.leaseEpoch, 1);
  const records = await repo2.listRecords("u-persist", main.sessionId);
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => r.seq),
    [1, 2],
  );
  assert.deepEqual(
    records.map((r) => r.messageSeq),
    [1, 2],
  );
});

test("ensureSessionSchema creates all five tables and can run twice", (t) => {
  const db = new DatabaseSync(":memory:");
  afterResource(t, () => db.close());
  ensureSessionSchema(db);
  ensureSessionSchema(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  assert.deepEqual(
    tables.map((row) => row.name),
    ["runs", "session_records", "sessions", "user_memory", "users"],
  );
});

test("foreign keys and CHECK constraints are enforced at the database layer", async (t) => {
  const dbPath = tempDbPath(t);
  const repo = createSqliteSessionRepository(dbPath);
  const { main } = await makeUser(repo, "u-fk");
  repo.close();

  const db = new DatabaseSync(dbPath);
  afterResource(t, () => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  // session_records.session_id 必须存在。
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO session_records (record_id, session_id, seq, type, message_seq, payload, created_at)
           VALUES ('r-x', 'no-such-session', 1, 'message', 1, '{"message":{}}', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    /FOREIGN KEY/,
  );
  // payload 必须是合法 JSON。
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO session_records (record_id, session_id, seq, type, message_seq, payload, created_at)
           VALUES ('r-y', ?, 1, 'message', 1, 'not-json', '2026-01-01T00:00:00Z')`,
        )
        .run(main.sessionId),
    /CHECK|json/,
  );
  // kind='main' 不再唯一：同一用户可有多条对话会话（对话即 main）。
  db.prepare(
    `INSERT INTO sessions (session_id, user_id, kind, status, last_activity_at, created_at, updated_at)
     VALUES ('s-dup', 'u-fk', 'main', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
});

test("legacy database with unique main index upgrades: a second main conversation can be created", async (t) => {
  const dbPath = tempDbPath(t);
  // 模拟老库：users 带 main_session_id 死列 + idx_sessions_main 部分唯一索引。
  // 只建最小两张表（其余表由 ensureSessionSchema 补齐），故先关 FK 检查。
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    CREATE TABLE users (
      user_id TEXT PRIMARY KEY,
      main_session_id TEXT REFERENCES sessions(session_id),
      display_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
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
    CREATE UNIQUE INDEX idx_sessions_main ON sessions(user_id) WHERE kind = 'main';
  `);
  const now = "2026-01-01T00:00:00Z";
  db.prepare(
    "INSERT INTO users (user_id, display_name, created_at, updated_at) VALUES ('u-legacy', NULL, ?, ?)",
  ).run(now, now);
  db.prepare(
    `INSERT INTO sessions (session_id, user_id, kind, status, last_activity_at, created_at, updated_at)
     VALUES ('s-old', 'u-legacy', 'main', 'active', ?, ?, ?)`,
  ).run(now, now, now);
  db.prepare("UPDATE users SET main_session_id = 's-old' WHERE user_id = 'u-legacy'").run();
  db.close();

  // 打开仓库触发 ensureSessionSchema：旧唯一索引被 DROP，老会话就地变成普通历史对话。
  const repo = createSqliteSessionRepository(dbPath);
  t.after(() => repo.close());
  const old = await repo.getSession("u-legacy", "s-old");
  assert.equal(old?.kind, "main");

  const second = await repo.createConversation("u-legacy");
  assert.equal(second.kind, "main");
  assert.equal(second.parentSessionId, null);
  const sessions = await repo.listSessions("u-legacy");
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((s) => s.kind === "main"));
});

test("session database file is independent from the events database path", async (t) => {
  // :memory: 与文件库互不影响；文件库落在自己的路径下。
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-mem");
  assert.equal(main.userId, "u-mem");
  const dbPath = tempDbPath(t);
  const fileRepo = createSqliteSessionRepository(dbPath);
  afterResource(t, () => fileRepo.close());
  assert.equal(await fileRepo.getSession("u-mem", main.sessionId), undefined);
});

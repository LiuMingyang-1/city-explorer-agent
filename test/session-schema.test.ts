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
  t.after(() => repo2.close());
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

test("ensureSessionSchema creates all four tables and can run twice", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  ensureSessionSchema(db);
  ensureSessionSchema(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  assert.deepEqual(
    tables.map((row) => row.name),
    ["runs", "session_records", "sessions", "users"],
  );
});

test("foreign keys and CHECK constraints are enforced at the database layer", async (t) => {
  const dbPath = tempDbPath(t);
  const repo = createSqliteSessionRepository(dbPath);
  const { main } = await makeUser(repo, "u-fk");
  repo.close();

  const db = new DatabaseSync(dbPath);
  t.after(() => db.close());
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
  // 每用户唯一 main 会话由部分唯一索引保证。
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO sessions (session_id, user_id, kind, status, last_activity_at, created_at, updated_at)
           VALUES ('s-dup', 'u-fk', 'main', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        )
        .run(),
    /UNIQUE/,
  );
});

test("session database file is independent from the events database path", async (t) => {
  // :memory: 与文件库互不影响；文件库落在自己的路径下。
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-mem");
  assert.equal(main.userId, "u-mem");
  const dbPath = tempDbPath(t);
  const fileRepo = createSqliteSessionRepository(dbPath);
  t.after(() => fileRepo.close());
  assert.equal(await fileRepo.getSession("u-mem", main.sessionId), undefined);
});

import { afterResource } from "./resource-cleanup-fixture.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { ensureEventsSchema } from "../src/data/schema.ts";

/**
 * scripts/seed.ts 防呆：目标库带 _collection_metadata（采集交付标记）时拒绝执行，
 * --force 显式放行；无标记的 mock/新库行为不变。整脚本级验证（spawn 真入口）。
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = "2026-11-11";

function runSeed(dbPath: string, args: string[] = []) {
  return spawnSync(process.execPath, ["scripts/seed.ts", `--date=${BASE}`, ...args], {
    cwd: ROOT,
    env: { EXPLORER_DB_PATH: dbPath },
    encoding: "utf8",
    timeout: 30_000,
  });
}

/** 带 _collection_metadata 与一条"真实"事件的采集交付库。 */
function collectionDb(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "explorer-seed-guard-"));
  afterResource(t, () => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "events.db");
  const db = new DatabaseSync(dbPath);
  ensureEventsSchema(db);
  db.exec(
    "CREATE TABLE _collection_metadata (key TEXT PRIMARY KEY NOT NULL," +
      " value TEXT NOT NULL CHECK(json_valid(value)))",
  );
  db.prepare("INSERT INTO _collection_metadata (key, value) VALUES ('database_id', '{}')").run();
  db.prepare(
    `INSERT INTO events (id, title, description, category, venue_name, address,
       latitude, longitude, start_at, end_at, suggested_duration_minutes)
     VALUES ('real_001', '真实采集活动', 'd', '展览', 'v', 'a',
       34.0, 108.9, '${BASE}T10:00', '${BASE}T12:00', 60)`,
  ).run();
  db.close();
  return dbPath;
}

function eventIds(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT id FROM events").all().map((r) => String(r.id));
  } finally {
    db.close();
  }
}

test("seed refuses a collection delivery database without --force", (t) => {
  const dbPath = collectionDb(t);
  const denied = runSeed(dbPath);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /_collection_metadata/);
  assert.match(denied.stderr, /--force/);
  assert.deepEqual(eventIds(dbPath), ["real_001"]); // 真实数据未被清空
});

test("seed --force replaces a collection delivery database with mock data", (t) => {
  const dbPath = collectionDb(t);
  const forced = runSeed(dbPath, ["--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /Seeded \d+ mock events/);
  const ids = eventIds(dbPath);
  assert.ok(ids.length > 0 && !ids.includes("real_001"));
});

test("seed still runs on a plain mock database without --force", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "explorer-seed-guard-"));
  afterResource(t, () => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "events.db");
  const db = new DatabaseSync(dbPath);
  ensureEventsSchema(db);
  db.close();
  const seeded = runSeed(dbPath);
  assert.equal(seeded.status, 0, seeded.stderr);
  assert.match(seeded.stdout, /Seeded \d+ mock events/);
  assert.ok(eventIds(dbPath).length > 0);
});

import { afterResource } from "./resource-cleanup-fixture.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ensureEventsSchema } from "../src/data/schema.ts";
import { createSqliteEventRepository } from "../src/data/sqlite.ts";

/** v0 老库建表语句：只有 plan 的 11 列，无预算/攻略/图片列。 */
const V0_EVENTS_DDL = `CREATE TABLE events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  address TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  suggested_duration_minutes INTEGER NOT NULL
)`;

const BASE_COLUMNS = `id, title, description, category, venue_name, address,
  latitude, longitude, start_at, end_at, suggested_duration_minutes`;
const ALL_COLUMNS = `${BASE_COLUMNS},
  budget_min, budget_max, currency, budget_note, guide_url, thumbnail_url, image_urls`;

function tmpDbPath(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "explorer-schema-"));
  afterResource(t, () => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "events.db");
}

function baseArgs(id: string): (string | number)[] {
  return [
    id, "自定义活动", "旧库里的用户记录", "展览", "老场地", "老地址",
    31.0, 121.0, "2026-11-14T10:00", "2026-11-14T18:00", 60,
  ];
}

test("v0 database migrates in place, twice, keeping custom rows and defaults", async (t) => {
  const dbPath = tmpDbPath(t);

  const db = new DatabaseSync(dbPath);
  db.exec(V0_EVENTS_DDL);
  db.prepare(`INSERT INTO events (${BASE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(...baseArgs("evt_custom"));
  ensureEventsSchema(db);
  ensureEventsSchema(db); // 幂等：列已存在，不再 ALTER
  const columns = new Set(
    (db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const name of [
    "budget_min", "budget_max", "currency", "budget_note",
    "guide_url", "thumbnail_url", "image_urls",
  ]) {
    assert.ok(columns.has(name), `missing column ${name}`);
  }
  db.close();

  const repo = createSqliteEventRepository(dbPath);
  afterResource(t, () => repo.close());
  const all = await repo.search({});
  assert.equal(all.length, 1); // 不清表、不重新 seed，自定义记录保留
  const ev = all[0];
  assert.equal(ev.title, "自定义活动"); // 原字段不变
  assert.equal(ev.budgetMin, null); // 追加列回填默认值
  assert.equal(ev.budgetMax, null);
  assert.equal(ev.currency, "CNY");
  assert.equal(ev.budgetNote, null);
  assert.equal(ev.guideUrl, null);
  assert.equal(ev.thumbnailUrl, null);
  assert.deepEqual(ev.imageUrls, []);
  assert.equal((await repo.getByIds(["evt_custom"])).get("evt_custom")?.id, "evt_custom");
});

test("new fields round-trip via search and getByIds; image order preserved", async (t) => {
  const dbPath = tmpDbPath(t);
  const db = new DatabaseSync(dbPath);
  ensureEventsSchema(db); // 新库一次建齐全部列
  db.prepare(`INSERT INTO events (${ALL_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      ...baseArgs("evt_paid"),
      5000, 8000, "CNY", "学生票半价", "https://example.com/guide",
      "https://example.com/t.jpg", '["https://img/2.jpg","https://img/1.jpg"]',
    );
  db.close();

  const repo = createSqliteEventRepository(dbPath);
  afterResource(t, () => repo.close());
  const [ev] = await repo.search({ date: "2026-11-14" });
  assert.equal(ev.budgetMin, 5000);
  assert.equal(ev.budgetMax, 8000);
  assert.equal(ev.currency, "CNY");
  assert.equal(ev.budgetNote, "学生票半价");
  assert.equal(ev.guideUrl, "https://example.com/guide");
  assert.equal(ev.thumbnailUrl, "https://example.com/t.jpg");
  assert.deepEqual(ev.imageUrls, ["https://img/2.jpg", "https://img/1.jpg"]);

  const byId = (await repo.getByIds(["evt_paid"])).get("evt_paid");
  assert.equal(byId?.budgetMin, 5000);
  assert.deepEqual(byId?.imageUrls, ["https://img/2.jpg", "https://img/1.jpg"]);
});

test("free (0) vs unknown (null) budgets; omitted columns take defaults", async (t) => {
  const dbPath = tmpDbPath(t);
  const db = new DatabaseSync(dbPath);
  ensureEventsSchema(db);
  db.prepare(`INSERT INTO events (${ALL_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(...baseArgs("evt_free"), 0, 0, "CNY", null, null, null, "[]");
  db.prepare(`INSERT INTO events (${BASE_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(...baseArgs("evt_plain")); // 未给新列 → 默认值
  db.close();

  const repo = createSqliteEventRepository(dbPath);
  afterResource(t, () => repo.close());
  const byId = await repo.getByIds(["evt_free", "evt_plain"]);
  const free = byId.get("evt_free");
  assert.equal(free?.budgetMin, 0); // 免费是 0，不是 null
  assert.equal(free?.budgetMax, 0);
  const plain = byId.get("evt_plain");
  assert.equal(plain?.budgetMin, null); // 未知费用
  assert.equal(plain?.budgetMax, null);
  assert.equal(plain?.currency, "CNY");
  assert.deepEqual(plain?.imageUrls, []);
});

test("constraints reject negative/reversed/non-integer budgets and non-array image_urls", (t) => {
  const dbPath = tmpDbPath(t);
  const db = new DatabaseSync(dbPath);
  afterResource(t, () => db.close());
  ensureEventsSchema(db);
  const insert = db.prepare(
    `INSERT INTO events (${ALL_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const run = (id: string, min: number | null, max: number | null, images: string) =>
    insert.run(...baseArgs(id), min, max, "CNY", null, null, null, images);

  assert.throws(() => run("evt_neg", -100, null, "[]"));
  assert.throws(() => run("evt_rev", 9000, 5000, "[]"));
  assert.throws(() => run("evt_real", 10.5, null, "[]"));
  for (const [i, bad] of ["not json", "{}", '"x"'].entries()) {
    assert.throws(() => run(`evt_img_${i}`, null, null, bad), bad);
  }
  run("evt_ok", null, null, "[]"); // 合法行照常写入
});

test("image_urls elements must be strings, enforced at the read boundary", async (t) => {
  // DB CHECK 保证值是 JSON 数组；[1,"x"] 能通过 CHECK，但读出 Event 时报错。
  const dbPath = tmpDbPath(t);
  const db = new DatabaseSync(dbPath);
  ensureEventsSchema(db);
  db.prepare(`INSERT INTO events (${ALL_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(...baseArgs("evt_badimg"), null, null, "CNY", null, null, null, '[1,"x"]');
  db.close();

  const repo = createSqliteEventRepository(dbPath);
  afterResource(t, () => repo.close());
  assert.throws(() => repo.search({}), /image_urls/);
});

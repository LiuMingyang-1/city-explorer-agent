import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { generateSeedEvents, seedEvents } from "../src/data/seed.ts";
import { createSqliteEventRepository } from "../src/data/sqlite.ts";
import { BASE, seededRepo } from "./data-fixture.ts";

test("seed fills budget/media fields: free, paid-range and unknown samples", () => {
  const events = generateSeedEvents(BASE);
  for (const e of events) {
    assert.equal(e.currency, "CNY");
    assert.ok(Array.isArray(e.imageUrls));
    if (e.budgetMin !== null) {
      assert.ok(e.budgetMin >= 0);
      assert.ok(e.budgetMax !== null && e.budgetMin <= e.budgetMax, `${e.id} bad range`);
    } else {
      assert.equal(e.budgetMax, null, `${e.id} max set while min unknown`);
    }
    for (const url of [e.guideUrl, e.thumbnailUrl, ...e.imageUrls]) {
      if (url !== null) assert.ok(url.startsWith("https://"), `${e.id} bad url: ${url}`);
    }
  }
  // 免费（0/0）、付费区间、费用未知（null）三类都有样例。
  assert.ok(events.some((e) => e.budgetMin === 0 && e.budgetMax === 0), "no free sample");
  assert.ok(events.some((e) => e.budgetMin !== null && e.budgetMin > 0), "no paid sample");
  assert.ok(events.some((e) => e.budgetMin === null && e.budgetMax === null), "no unknown sample");
  // 0 / 1 / 多图，以及无攻略、无缩略图样例都有。
  const counts = new Set(events.map((e) => e.imageUrls.length));
  assert.ok(counts.has(0) && counts.has(1), `image counts: ${[...counts]}`);
  assert.ok([...counts].some((n) => n > 1), "no multi-image sample");
  assert.ok(events.some((e) => e.guideUrl === null) && events.some((e) => e.guideUrl !== null));
  assert.ok(events.some((e) => e.thumbnailUrl === null) && events.some((e) => e.thumbnailUrl !== null));
});

test("seeded new fields round-trip via repo: image order, 0 vs null", async (t) => {
  const { repo } = seededRepo(t);
  const expected = generateSeedEvents(BASE);
  const found = await repo.getByIds(expected.map((e) => e.id));
  assert.equal(found.size, expected.length);
  // 每条都完整往返（含攻略/缩略图/图片地址、分单位费用与 CNY）。
  for (const e of expected) assert.deepEqual(found.get(e.id), e, e.id);
  // 显式点样：多图顺序保留；免费是 0 而非 null；未知保持 null。
  const multi = expected.find((e) => e.imageUrls.length > 1);
  assert.ok(multi && found.get(multi.id)?.imageUrls.length === multi.imageUrls.length);
  assert.deepEqual(found.get(multi.id)?.imageUrls, multi.imageUrls);
  const free = expected.find((e) => e.budgetMin === 0);
  assert.equal(found.get(free!.id)?.budgetMin, 0);
  const unknown = expected.find((e) => e.budgetMin === null);
  assert.equal(found.get(unknown!.id)?.budgetMin, null);
  assert.equal(found.get(unknown!.id)?.budgetMax, null);
});

test("seedEvents migrates a v0 database before writing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "explorer-data-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "events.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE events (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
    category TEXT NOT NULL, venue_name TEXT NOT NULL, address TEXT NOT NULL,
    latitude REAL NOT NULL, longitude REAL NOT NULL,
    start_at TEXT NOT NULL, end_at TEXT NOT NULL,
    suggested_duration_minutes INTEGER NOT NULL)`);
  db.prepare(
    `INSERT INTO events (id, title, description, category, venue_name, address,
      latitude, longitude, start_at, end_at, suggested_duration_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("evt_legacy", "旧活动", "旧库记录", "展览", "旧场地", "旧地址",
    31.0, 121.0, "2026-11-14T10:00", "2026-11-14T12:00", 60);
  const inserted = seedEvents(db, BASE);
  db.close();
  assert.equal(inserted, 119); // 重 seed 仍是替换语义
  const repo = createSqliteEventRepository(dbPath);
  t.after(() => repo.close());
  assert.equal((await repo.getByIds(["evt_legacy"])).size, 0);
  const sample = (await repo.search({ date: BASE, category: "展览" }))[0];
  assert.ok("budgetMin" in sample && "imageUrls" in sample);
});

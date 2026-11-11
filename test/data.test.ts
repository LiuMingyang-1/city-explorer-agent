import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateSeedEvents, SEED_DAYS, seedDatabase } from "../src/data/seed.ts";
import { createSqliteEventRepository } from "../src/data/sqlite.ts";
import { BASE, dayOf, LAST_DAY, seededRepo } from "./data-fixture.ts";

test("seed produces ~100 unique events covering 7 days from base date", () => {
  const events = generateSeedEvents(BASE);
  assert.ok(events.length >= 100 && events.length <= 120, `got ${events.length}`);
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
  for (const e of events) {
    assert.ok(dayOf(e) >= BASE && dayOf(e) <= LAST_DAY, `${e.id} on ${dayOf(e)}`);
    assert.ok(e.endAt > e.startAt, `${e.id} has empty window`);
    assert.ok(e.suggestedDurationMinutes > 0);
  }
  // 覆盖要求的几个大类。
  for (const category of ["展览", "书店活动", "市集", "演出"]) {
    assert.ok(events.some((e) => e.category === category), `missing ${category}`);
  }
  // 时间窗活动（窗口长于建议停留）与固定场次（窗口等于时长）都存在。
  const spanMinutes = (e: { startAt: string; endAt: string }) => {
    const toMin = (hhmmss: string) => Number(hhmmss.slice(11, 13)) * 60 + Number(hhmmss.slice(14, 16));
    return toMin(e.endAt) - toMin(e.startAt);
  };
  assert.ok(events.some((e) => spanMinutes(e) > e.suggestedDurationMinutes));
  assert.ok(events.some((e) => spanMinutes(e) === e.suggestedDurationMinutes));
});

test("seed is deterministic for a fixed base date", () => {
  assert.deepEqual(generateSeedEvents(BASE), generateSeedEvents(BASE));
});

test("seed rejects malformed or nonexistent base dates", () => {
  for (const bad of ["2026-02-30", "2026-11-31", "2026-13-01", "11-11-2026", "2026/11/11"]) {
    assert.throws(() => generateSeedEvents(bad), /baseDate/, `accepted ${bad}`);
  }
});

// 文档主样例“周六下午 13:00–18:00 看展、逛书店”：每天该时段内要既能看展，
// 又有 >=2 个不同书店活动可选（支撑“第二个换一个”），且建议停留能完整排进时段。
test("every day has an exhibition and >=2 bookshop options within 13:00-18:00", () => {
  const events = generateSeedEvents(BASE);
  const toMin = (iso: string) => Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
  const fits = (e: (typeof events)[number]) =>
    Math.min(toMin(e.endAt), 18 * 60) - Math.max(toMin(e.startAt), 13 * 60) >= e.suggestedDurationMinutes;
  for (let i = 0; i < SEED_DAYS; i++) {
    const day = `2026-11-${String(11 + i).padStart(2, "0")}`;
    const attendable = events.filter((e) => dayOf(e) === day && fits(e));
    assert.ok(attendable.some((e) => e.category === "展览"), `no afternoon exhibition on ${day}`);
    const bookshops = new Set(
      attendable.filter((e) => e.category === "书店活动").map((e) => e.title),
    );
    assert.ok(bookshops.size >= 2, `expected >=2 afternoon bookshop options on ${day}, got ${bookshops.size}`);
  }
});

test("re-seeding replaces instead of appending", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "explorer-data-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "events.db");
  const first = seedDatabase(dbPath, BASE);
  const second = seedDatabase(dbPath, BASE);
  assert.equal(second, first);

  const repo = createSqliteEventRepository(dbPath);
  t.after(() => repo.close());
  let total = 0;
  for (let i = 0; i < SEED_DAYS; i++) {
    const day = `2026-11-${String(11 + i).padStart(2, "0")}`;
    total += (await repo.search({ date: day })).length;
  }
  assert.equal(total, first);
});

test("search by date returns only events attendable that day", async (t) => {
  const { repo } = seededRepo(t);
  const events = await repo.search({ date: "2026-11-12" });
  assert.ok(events.length > 0);
  for (const e of events) {
    assert.ok(e.startAt.slice(0, 10) <= "2026-11-12" && e.endAt.slice(0, 10) >= "2026-11-12");
  }
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i - 1].startAt <= events[i].startAt, "results ordered by start_at");
  }
  assert.equal((await repo.search({ date: "2026-11-25" })).length, 0);
});

test("search by category and keyword", async (t) => {
  const { repo } = seededRepo(t);

  const exhibitions = await repo.search({ category: "展览" });
  assert.ok(exhibitions.length > 0);
  assert.ok(exhibitions.every((e) => e.category === "展览"));

  const markets = await repo.search({ keyword: "手作" });
  assert.ok(markets.length > 0);
  assert.ok(
    markets.every((e) => e.title.includes("手作") || e.description.includes("手作")),
  );

  const combined = await repo.search({
    date: BASE,
    category: "书店活动",
    keyword: "诗歌",
  });
  assert.ok(combined.length > 0);
  for (const e of combined) {
    assert.equal(e.category, "书店活动");
    assert.equal(dayOf(e), BASE);
    assert.ok(e.title.includes("诗歌") || e.description.includes("诗歌"));
  }

  assert.equal((await repo.search({ keyword: "不存在的关键词" })).length, 0);
});

test("getByIds returns found events and skips missing ids", async (t) => {
  const { repo } = seededRepo(t);
  const some = await repo.search({ date: BASE, category: "演出" });
  assert.ok(some.length >= 2);
  const ids = [some[0].id, "evt_missing", some[1].id];
  const found = await repo.getByIds(ids);
  assert.equal(found.size, 2);
  assert.equal(found.get(some[0].id)?.title, some[0].title);
  assert.equal(found.get(some[0].id)?.venueName, some[0].venueName);
  assert.ok(!found.has("evt_missing"));
  assert.equal((await repo.getByIds([])).size, 0);
});

test("empty search returns all events within the limit", async (t) => {
  const { repo, inserted } = seededRepo(t);
  const all = await repo.search({});
  assert.equal(all.length, Math.min(inserted, 100));
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { generateSeedEvents, SEED_DAYS, seedDatabase } from "../src/data/seed.ts";
import { createSqliteEventRepository, ensureEventsSchema } from "../src/data/sqlite.ts";
import type { EventRepository } from "../src/data/repository.ts";
import { BASE, dayOf, LAST_DAY, seededRepo } from "./data-fixture.ts";

/**
 * 自定义坐标活动库：near=(0,0) 时把"距赤道原点 km 公里"换算成纬度
 * （赤道上纬度 θ 度的球面距离恰为 km），lng 恒 0。供半径边界/排序
 * 用例精确放置活动，不依赖种子数据的具体坐标。
 */
function distanceRepo(t: TestContext, points: Array<readonly [id: string, km: number]>) {
  const dir = mkdtempSync(join(tmpdir(), "explorer-data-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "events.db");
  const db = new DatabaseSync(dbPath);
  ensureEventsSchema(db);
  const insert = db.prepare(
    `INSERT INTO events (id, title, description, category, venue_name, address,
       latitude, longitude, start_at, end_at, suggested_duration_minutes)
     VALUES (?, ?, 'd', '展览', ?, 'a', ?, 0, ?, ?, 60)`,
  );
  const latFor = (km: number) => (km / 6371) * (180 / Math.PI);
  for (const [id, km] of points) {
    insert.run(id, `t${id}`, `v${id}`, latFor(km), `${BASE}T10:00`, `${BASE}T12:00`);
  }
  db.close();
  const repo: EventRepository = createSqliteEventRepository(dbPath);
  t.after(() => repo.close());
  return repo;
}

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

test("search with near sorts by distance and annotates distanceKm", async (t) => {
  const { repo } = seededRepo(t);
  // 参考点取西岸美术馆（模拟）坐标：同场地活动距离为 0，其余场馆按球面距离递增。
  const near = { lat: 31.1895, lng: 121.4702 };
  // 独立复算 haversine 期望值，验证 repository 的距离值与取整。
  const expectedKm = (lat: number, lng: number) => {
    const rad = Math.PI / 180;
    const a =
      Math.sin(((lat - near.lat) * rad) / 2) ** 2 +
      Math.cos(near.lat * rad) * Math.cos(lat * rad) * Math.sin(((lng - near.lng) * rad) / 2) ** 2;
    return Math.round(2 * 6371 * Math.asin(Math.sqrt(a)) * 100) / 100;
  };
  const events = await repo.search({ date: BASE, near });
  assert.ok(events.length > 0);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    assert.equal(typeof e.distanceKm, "number");
    // 距离保留两位小数。
    assert.match(String(e.distanceKm), /^\d+(\.\d{1,2})?$/);
    assert.equal(e.distanceKm, expectedKm(e.latitude, e.longitude));
    if (i > 0) {
      assert.ok(events[i - 1].distanceKm! <= e.distanceKm!, "results ordered by distance");
    }
  }
  assert.equal(events[0].distanceKm, 0);
});

test("search with near and radiusKm filters by distance", async (t) => {
  const { repo } = seededRepo(t);
  const near = { lat: 31.1895, lng: 121.4702 };
  const within = await repo.search({ near, radiusKm: 1 });
  assert.ok(within.length > 0);
  assert.ok(within.every((e) => e.distanceKm! <= 1));
  // 参考点 1km 内只有西岸美术馆、余德耀美术馆、钟书阁徐汇店三处场地的活动。
  assert.deepEqual(
    new Set(within.map((e) => e.venueName)),
    new Set(["西岸美术馆（模拟）", "余德耀美术馆（模拟）", "钟书阁徐汇店（模拟）"]),
  );
});

test("search with near and radiusKm filters by raw distance (rounding must not widen radius)", async (t) => {
  // evt_edge 原始 1.004km > 1：取整后显示 1.00 也不许混进半径结果；
  // evt_in 原始 0.996km < 1：取整后同样显示 1.00 且在半径内。
  const repo = distanceRepo(t, [
    ["evt_in", 0.996],
    ["evt_edge", 1.004],
    ["evt_far", 3.5],
  ]);
  const near = { lat: 0, lng: 0 };
  const within = await repo.search({ near, radiusKm: 1 });
  assert.deepEqual(
    within.map((e) => e.id),
    ["evt_in"],
  );
  assert.equal(within[0].distanceKm, 1); // 0.996 → 展示两位小数为 1

  // 不带 radiusKm 时 evt_edge 正常返回，distanceKm 仍是取整展示值。
  const all = await repo.search({ near });
  assert.equal(all.find((e) => e.id === "evt_edge")?.distanceKm, 1);
});

test("search with near sorts by raw distance when rounded values tie", async (t) => {
  // 两条取整后都是 1.00：排序必须按原始距离（1.001 在 1.004 前），
  // 不能按取整值（会让次序退化成插入顺序）。
  const repo = distanceRepo(t, [
    ["evt_b", 1.004],
    ["evt_a", 1.001],
  ]);
  const events = await repo.search({ near: { lat: 0, lng: 0 } });
  assert.deepEqual(
    events.map((e) => e.id),
    ["evt_a", "evt_b"],
  );
  assert.ok(events.every((e) => e.distanceKm === 1));
});

test("search without near returns no distanceKm; radiusKm alone is ignored", async (t) => {
  const { repo, inserted } = seededRepo(t);
  const plain = await repo.search({ date: BASE });
  assert.ok(plain.length > 0);
  for (const e of plain) assert.equal(e.distanceKm, undefined);

  // 只传 radiusKm 没有 near：按原逻辑处理，结果与空查询一致且无距离字段。
  const radiusOnly = await repo.search({ radiusKm: 0.5 });
  assert.deepEqual(radiusOnly, await repo.search({}));
  assert.equal(radiusOnly.length, Math.min(inserted, 100));
  assert.ok(radiusOnly.every((e) => e.distanceKm === undefined));
});

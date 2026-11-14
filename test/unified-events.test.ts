import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { availabilityOnDate, scheduleProblems } from "../src/data/schedule.ts";
import type { Schedule } from "../src/data/schedule.ts";
import { ensureEventsSchema } from "../src/data/schema.ts";
import { createSqliteEventRepository } from "../src/data/sqlite.ts";
import { validateItinerary } from "../src/itinerary/validation.ts";
import { processCollection } from "../src/collection/pipeline.ts";
import { createGeocoder } from "../src/collection/geocoding.ts";
import { publishRelease, inspectRelease, createReleasedRepository } from "../src/collection/releases.ts";
import { assessFreshness } from "../src/collection/freshness.ts";
import { FACT_EXTRACTION_PROMPT, extractActivities } from "../src/collection/extraction.ts";
import { extractionFixture } from "./collection-downstream-fixture.ts";

const weekly: Schedule = { timezone: "Asia/Shanghai", mode: "weekly", weekly: [{ weekdays: [2,3,4,5,6,7], windows: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "17:30", last_entry: "16:30" }] }], exceptions: [{ date: "2026-11-15", closed: true }] };
test("weekly dates honor Monday closure, lunch, last entry and date exceptions", () => {
  const input = { validFrom: "2026-11-14", validTo: "2026-11-29", schedule: weekly };
  assert.equal(availabilityOnDate(input, "2026-11-13").state, "closed");
  assert.equal(availabilityOnDate(input, "2026-11-14").windows.length, 2);
  assert.equal(availabilityOnDate(input, "2026-11-14").windows[1].lastEntryAt, "2026-11-14T16:30");
  assert.equal(availabilityOnDate(input, "2026-11-15").state, "closed");
  assert.equal(availabilityOnDate(input, "2026-11-16").state, "closed");
  assert.equal(availabilityOnDate(input, "2026-12-01").state, "closed");
});
test("specified dates remain separate daily windows; overnight availability is carried into next day", () => {
  const schedule: Schedule = { timezone: "Asia/Shanghai", mode: "dates", dates: [
    { date: "2026-11-28", windows: [{ start: "09:30", end: "17:00" }] },
    { date: "2026-11-29", windows: [{ start: "09:30", end: "17:00" }] },
    { date: "2026-11-30", windows: [{ start: "22:00", end: "02:00", end_day_offset: 1 }] },
  ] };
  assert.deepEqual(scheduleProblems(schedule), []);
  assert.equal(availabilityOnDate({ schedule }, "2026-11-28").windows[0].endAt, "2026-11-28T17:00");
  assert.equal(availabilityOnDate({ schedule }, "2026-11-29").windows[0].startAt, "2026-11-29T09:30");
  assert.equal(availabilityOnDate({ schedule }, "2026-12-01").windows[0].startAt, "2026-11-30T22:00");
  assert.equal(availabilityOnDate({ schedule: null }, "2026-11-14").state, "unknown");
  assert(scheduleProblems({ ...schedule, dates: [{ date: "2026-02-30", windows: [{ start: "17:00", end: "09:00" }] }] }).length >= 2);
});

test("seasonal hours are not used before their effective date or after expiration", () => {
  const schedule: Schedule = { timezone: "Asia/Shanghai", mode: "weekly", weekly: [{ weekdays: [2,3,4,5,6,7], valid_from: "2026-11-15", valid_to: "2027-03-14", windows: [{ start: "09:00", end: "17:30" }] }] };
  assert.equal(availabilityOnDate({ recordType: "attraction", schedule }, "2026-11-14").state, "unknown");
  assert.equal(availabilityOnDate({ recordType: "attraction", schedule }, "2026-11-15").state, "open");
  assert.equal(availabilityOnDate({ recordType: "attraction", schedule }, "2026-11-16").state, "closed");
  assert.equal(availabilityOnDate({ recordType: "attraction", schedule }, "2027-03-16").state, "unknown");
});

test("a prepared batch can be published later without timestamp witness mismatch", async () => {
  const { locatedFixture } = await import("./collection-downstream-fixture.ts");
  const { prepareCollection } = await import("../src/collection/preparation.ts");
  const { item, asOf } = await locatedFixture(); const folder = mkdtempSync(join(tmpdir(), "unified-clock-"));
  try {
    const prepared = prepareCollection([item], { asOf, baseDate: "2026-11-12" }).prepared;
    await publishRelease(folder, prepared, { batchId: "later", asOf: "2026-11-12T03:00:02Z" });
    assert.equal(inspectRelease(folder).sidecar.events[prepared.dataset.events[0].id].provenance.source_url, item.document.url);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("unified SQL differentiates activity classifications and scenic A levels; migration is idempotent", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureEventsSchema(db); ensureEventsSchema(db);
    assert.equal(db.prepare("PRAGMA table_info(events)").all().length, 31);
    const insert = db.prepare("INSERT INTO events(id,title,description,category,venue_name,address,record_type) VALUES(?,?,?,?,?,?,?)");
    insert.run("a", "景区", "介绍", "5A", "景区", "西安市地址", "attraction");
    assert.throws(() => insert.run("b", "景区", "介绍", "展览", "景区", "西安市地址", "attraction"));
    assert.throws(() => insert.run("c", "展览", "介绍", "5A", "场馆", "西安市地址", "activity"));
  } finally { db.close(); }
});

test("an existing v3 CHECK is replaced atomically without changing legacy coordinates or custom data", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE events(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,
      venue_name TEXT NOT NULL,address TEXT NOT NULL,latitude REAL,longitude REAL,start_at TEXT,end_at TEXT,suggested_duration_minutes INTEGER,
      custom_note TEXT,CONSTRAINT events_collection_v3 CHECK(category IN ('展览')));
      INSERT INTO events VALUES('old','t','d','展览','v','西安市地址',34.23,108.95,NULL,NULL,NULL,'keep');
      CREATE INDEX custom_idx ON events(title);`);
    ensureEventsSchema(db); ensureEventsSchema(db);
    const old = db.prepare("SELECT * FROM events WHERE id='old'").get()!;
    assert.equal(old.custom_note, "keep"); assert.equal(old.latitude, 34.23); assert.equal(old.longitude, 108.95);
    db.exec("INSERT INTO events(id,title,description,category,venue_name,address,record_type) VALUES('new','t','d','5A','v','a','attraction')");
    assert(db.prepare("SELECT sql FROM sqlite_master WHERE name='custom_idx'").get());
  } finally { db.close(); }
});

test("new prompts collect activity and attraction schedules without mistaking visitor memories or comments for closure", () => {
  for (const text of ["record_type", "schedule_json", "暂无评级", "评论", "游客", "不添加tags"]) assert(FACT_EXTRACTION_PROMPT.includes(text));
  assert(!FACT_EXTRACTION_PROMPT.includes("日常开放规则暂不展开"));
});

test("compatibility defaults never mutate a caller's new structured input", async () => {
  const { facts, document, asOf } = extractionFixture();
  const { start_at, end_at, confirmed_start_date, confirmed_end_date, schedule_type, ...modern } = facts;
  const input = { activities: [{ ...modern, record_type: "activity", valid_from: "2026-11-14", valid_to: "2026-11-29", schedule_json: weekly }] };
  const before = structuredClone(input);
  const result = await extractActivities(document, { asOf, structured: input });
  assert.equal(result.activities[0].check.valid, true); assert.deepEqual(input, before);
});

test("fourteen days is no longer a storage rejection rule", async () => {
  const { facts, document, asOf } = extractionFixture();
  facts.start_at = facts.end_at = null; facts.confirmed_start_date = "2026-12-01"; facts.confirmed_end_date = "2026-12-02";
  const map = createGeocoder({ key: "key", now: () => asOf, fetch: async () => Response.json({ status: "1", count: "1", pois: [{ id: "B_TEST", name: facts.venue_name, address: "文化路1号", cityname: "西安市", adname: "雁塔区", adcode: "610113", location: "108.95,34.23" }] }) });
  const result = await processCollection([{ document, structured: { activities: [facts] } }], { asOf, baseDate: "2026-11-12", geocoder: map });
  assert.deepEqual(result.rejected, []); assert.equal(result.prepared.dataset.events.length, 1);
});

test("model -> GCJ map -> SQLite release -> dated search -> itinerary validation works for both record types", async () => {
  const folder = mkdtempSync(join(tmpdir(), "unified-events-"));
  const { document, asOf } = extractionFixture();
  document.published_at = "2020-01-01T00:00:00Z";
  document.text = "示例景区为5A，长期开放，游客去年到访。文化展于2026年11月14日至11月29日举办，周二至周日开放。";
  const shared = { description: "测试资料的概括", address: null, city: null, suggested_duration_minutes: 60, budget_min: null, budget_max: null, budget_note: null, status: "active", conflicts: [] };
  const payload = { activities: [
    { ...shared, record_type: "attraction", title: "历史景点", venue_name: "景区", category: "5A", valid_from: null, valid_to: null, schedule_json: weekly },
    { ...shared, record_type: "activity", title: "文化展", venue_name: "展厅", category: "展览", valid_from: "2026-11-14", valid_to: "2026-11-29", schedule_json: weekly },
  ] };
  const map = createGeocoder({ key: "offline-key", now: () => asOf, fetch: async url => {
    const name = new URL(String(url)).searchParams.get("keywords")!;
    return Response.json({ status: "1", count: "1", pois: [{ id: "B_" + name, name, cityname: "西安市", adcode: "610113", adname: "雁塔区", address: "文化路1号", location: "108.95,34.23", entr_location: "108.95,34.23" }] });
  } });
  try {
    const result = await processCollection([{ document }], { asOf, baseDate: "2026-11-12", invoke: async () => JSON.stringify(payload), geocoder: map });
    assert.deepEqual(result.rejected, []); assert.equal(result.prepared.dataset.events.length, 2);
    for (const event of result.prepared.dataset.events) { assert.equal(event.latitude, 34.23); assert.equal(event.longitude, 108.95); assert.equal(event.guide_url, document.url); }
    assert.equal(result.prepared.dataset.provenance[0].coordinates.system, "GCJ-02");
    await publishRelease(folder, result.prepared, { batchId: "new-data", asOf });
    const release = inspectRelease(folder), reader = createSqliteEventRepository(release.database, { readOnly: true });
    try {
      const events = await reader.search({ date: "2026-11-14" }); assert.equal(events.length, 2);
      assert.equal(events[0].availableWindows?.length, 2); assert.equal(events[0].startAt, null);
      assert.equal((await reader.search({ date: "2026-11-16" })).length, 0);
      assert.equal((await reader.search({ recordType: "attraction", category: "5A" })).length, 1);
      const id = events[0].id, byIds = await reader.getByIds([id]);
      const plan = (arrival: string, leave: string) => validateItinerary({ date: "2026-11-14", summary: "游览", stops: [{ event_id: id, arrive_at: arrival, leave_at: leave, reason: "感兴趣" }] }, { date: "2026-11-14" }, byIds);
      assert.equal(plan("09:30", "10:30").ok, true);
      assert.equal(plan("11:30", "13:30").ok, false);
      assert.equal(plan("17:00", "17:20").ok, false);
    } finally { reader.close(); }
    const released = createReleasedRepository(folder, () => asOf);
    try { assert.equal((await released.search({ date: "2026-11-14" })).length, 2); } finally { released.close(); }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("attractions do not expire merely because they have no end date or an old publication", () => {
  const result = assessFreshness({ start_at: null, end_at: null, record_type: "attraction", schedule_json: weekly }, {
    recordType: "attraction", firstSeenAt: "2026-01-01T00:00:00Z", lastVerifiedAt: "2026-11-01T00:00:00Z", sourcePublishedAt: "2020-01-01T00:00:00Z", confirmedEndDate: null, status: "active",
  }, "2026-11-12T03:00:00Z");
  assert.equal(result.includeInDiscovery, true); assert.equal(result.allowPlanning, true);
});

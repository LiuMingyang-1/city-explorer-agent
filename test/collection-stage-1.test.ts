import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATEGORIES } from "../src/data/categories.ts";
import { ensureEventsSchema, EVENTS_TABLE_DDL } from "../src/data/schema.ts";
import { createSqliteEventRepository } from "../src/data/sqlite.ts";
import { normalizeCandidate } from "../src/collection/contracts.ts";
import { validateDataset } from "../src/collection/validate.ts";
import { eventId } from "../src/collection/identity.ts";
import { collectionFixture } from "./collection-fixture.ts";

test("all 12 categories agree across SQL and the standalone JSON contract", () => {
  const schema = JSON.parse(readFileSync(new URL("../src/collection/dataset.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.events.items.properties.category.enum, [...CATEGORIES]);
  const db = new DatabaseSync(":memory:");
  try {
    ensureEventsSchema(db);
    const insert = db.prepare("INSERT INTO events(id,title,description,category,venue_name,address) VALUES(?,?,?,?,?,?)");
    for (const category of CATEGORIES) insert.run(category, "标题", "介绍", category, "场馆", "西安市地址");
    for (const category of ["其他", "看展", "", " "]) assert.throws(() => insert.run(category, "标题", "介绍", category, "场馆", "地址"));
    assert.equal(db.prepare("SELECT count(*) n FROM events").get()!.n, 12);
  } finally { db.close(); }
});

test("omitted optional fields use SQL defaults while invalid location, duration and blank facts fail", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureEventsSchema(db);
    db.exec("INSERT INTO events(id,title,description,category,venue_name,address) VALUES('e','t','d','展览','v','a')");
    const e = db.prepare("SELECT * FROM events").get()!;
    for (const name of ["latitude", "longitude", "start_at", "end_at", "suggested_duration_minutes"]) assert.equal(e[name], null);
    assert.equal(e.currency, "CNY"); assert.equal(e.image_urls, "[]");
    for (const update of ["latitude=34", "latitude=100,longitude=108", "latitude=34,longitude=200", "latitude='unknown',longitude=108", "suggested_duration_minutes=0", "suggested_duration_minutes=1.5", "title=char(9)||char(10)"]) {
      assert.throws(() => db.exec(`UPDATE events SET ${update}`), update);
    }
  } finally { db.close(); }
});

test("unsupported legacy categories roll back schema changes and preserve rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE events(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,venue_name TEXT NOT NULL,address TEXT NOT NULL,latitude REAL NOT NULL,longitude REAL NOT NULL,start_at TEXT NOT NULL,end_at TEXT NOT NULL,suggested_duration_minutes INTEGER NOT NULL);
      INSERT INTO events VALUES('old','t','d','历史未知类别','v','a',34,108,'2026-11-14T10:00','2026-11-14T11:00',60);
      PRAGMA foreign_keys=ON;`);
    const before = db.prepare("SELECT sql FROM sqlite_master WHERE name='events'").get()!.sql;
    assert.throws(() => ensureEventsSchema(db), /UNSUPPORTED_EXISTING_CATEGORY/);
    assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='events'").get()!.sql, before);
    assert.equal(db.prepare("SELECT category FROM events").get()!.category, "历史未知类别");
    assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test("candidate normalization materializes unknowns without approving publication or mutating input", () => {
  const { dataset, options } = collectionFixture();
  const input = { ...dataset.events[0] } as Record<string, unknown>;
  for (const name of ["latitude", "longitude", "start_at", "end_at", "suggested_duration_minutes", "currency", "image_urls"]) delete input[name];
  const before = structuredClone(input);
  const result = normalizeCandidate(input);
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.candidate.latitude, null); assert.equal(result.candidate.start_at, null);
  assert.equal(result.candidate.currency, "CNY"); assert.deepEqual(result.candidate.image_urls, []);
  assert.deepEqual(input, before);
  assert.equal(validateDataset({ ...dataset, events: [result.candidate] }, options).valid, false);
  assert.equal(normalizeCandidate({ ...input, latitude: 34 }).valid, false);
  assert.equal(normalizeCandidate({ ...input, category: null }).valid, false);
  assert.equal(normalizeCandidate({ ...input, surprise: "extra" }).valid, false);
  assert.equal(normalizeCandidate({ ...input, title: "\t" }).valid, false);
});

test("published v3 rejects v2 and estimates masquerading as confirmed durations", () => {
  const { dataset, options } = collectionFixture();
  assert.equal(validateDataset({ ...dataset, schema_version: "xian-events/2" }, options).valid, false);
  const invalid = structuredClone(dataset);
  (invalid.provenance[0] as any).duration_basis = "estimated";
  assert.equal(validateDataset(invalid, options).valid, false);
  invalid.provenance[0].duration_basis = "unknown";
  assert(validateDataset(invalid, options).issues.some(i => i.code === "DURATION_BASIS_MISMATCH"));
});

test("time completion retains the registered slot identity; new slots differ", () => {
  const { dataset, options } = collectionFixture();
  const e = dataset.events[0], p = dataset.provenance[0];
  p.slot_key = "unscheduled";
  e.id = p.event_id = eventId(p.source_event_key, p.venue_key, p.slot_key);
  e.start_at = e.end_at = null; e.suggested_duration_minutes = null;
  p.duration_basis = "unknown"; p.schedule_type = "unknown";
  assert.equal(validateDataset(dataset, options).valid, true);
  const id = e.id;
  e.start_at = "2026-11-14T10:00"; e.end_at = "2026-11-14T17:00"; p.schedule_type = "window";
  assert.equal(validateDataset(dataset, options).valid, true);
  assert.equal(e.id, id);
  assert.notEqual(eventId(p.source_event_key, p.venue_key, "confirmed-second-slot"), id);
});

test("runtime never exposes records lacking coordinates in search, near search or ID lookup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "events-stage1-"));
  const path = join(directory, "events.db");
  let repo: ReturnType<typeof createSqliteEventRepository> | undefined;
  try {
    const db = new DatabaseSync(path);
    db.exec(EVENTS_TABLE_DDL);
    db.exec("INSERT INTO events(id,title,description,category,venue_name,address) VALUES('incomplete','t','d','展览','v','a')");
    db.close();
    repo = createSqliteEventRepository(path);
    assert.deepEqual(await repo.search({}), []);
    assert.deepEqual(await repo.search({ near: { lat: 34, lng: 108 } }), []);
    assert.equal((await repo.getByIds(["incomplete"])).size, 0);
  } finally { repo?.close(); rmSync(directory, { recursive: true, force: true }); }
});

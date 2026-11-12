import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { locatedFixture } from "./collection-downstream-fixture.ts";
import { prepareCollection } from "../src/collection/preparation.ts";
import { registerSlot } from "../src/collection/identity.ts";
import { createReleasedRepository, inspectRelease, publishRelease } from "../src/collection/releases.ts";
import type { PreparedCollection } from "../src/collection/preparation.ts";
import { createSqliteEventRepository } from "../src/data/sqlite.ts";
import { ensureEventsSchema } from "../src/data/schema.ts";

const root = () => mkdtempSync(join(tmpdir(), "events-release-"));
async function fixture() {
  const { item, asOf } = await locatedFixture();
  const { prepared, rejected } = prepareCollection([item], { asOf, baseDate: "2026-11-12" });
  assert.deepEqual(rejected, []); assert.equal(prepared.dataset.events.length, 1);
  return { item, asOf, prepared };
}

test("preparation accepts original posts but rejects coordinates not bound to the exact venue query", async () => {
  const { item, asOf } = await locatedFixture(); item.document.authority = "unverified";
  assert.equal(prepareCollection([item], { asOf, baseDate: "2026-11-12" }).prepared.dataset.provenance[0].source_kind, "unverified");
  item.document.authority = "publisher"; item.location.longitude += .01;
  assert(prepareCollection([item], { asOf, baseDate: "2026-11-12" }).rejected[0].reasons.includes("LOCATION_NOT_VERIFIED_OR_NOT_BOUND"));
});

test("unknown time completion reuses an immutable registry ID and multiple occurrences fail closed", () => {
  const unknown = registerSlot([], "edition", "venue", null);
  const completed = registerSlot(unknown.state, "edition", "venue", "2026-11-14T10:00");
  assert.equal(completed.entry.event_id, unknown.entry.event_id); assert.equal(unknown.state[0].aliases.length, 1);
  const another = registerSlot(completed.state, "edition", "venue", "2026-11-14T15:00");
  assert.throws(() => registerSlot(another.state, "edition", "venue", null), /AMBIGUOUS_OCCURRENCE_IDENTITY/);
});

test("publish and repeat update keep one row, all 29 migration-compatible columns, stable ID and historical firstSeen", async () => {
  const folder = root();
  try {
    const { prepared, item, asOf } = await fixture();
    await publishRelease(folder, prepared, { batchId: "first", asOf });
    const before = inspectRelease(folder);
    const next = prepareCollection([item], { asOf, baseDate: "2026-11-12", identities: before.sidecar.identities }).prepared;
    next.metadata[next.dataset.events[0].id].firstSeenAt = "2026-11-12T02:30:00Z";
    await publishRelease(folder, next, { batchId: "second", asOf });
    const release = inspectRelease(folder), db = new DatabaseSync(release.database, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) n FROM events").get()!.n, 1);
      assert.equal(db.prepare("PRAGMA table_info(events)").all().length, 29);
      assert.equal(db.prepare("SELECT guide_url FROM events").get()!.guide_url, item.document.url);
      assert.equal(release.sidecar.events[next.dataset.events[0].id].freshness.firstSeenAt, item.first_seen_at);
    } finally { db.close(); }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("failure before pointer switch leaves previous database readable and releases writer lock", async () => {
  const folder = root();
  try {
    const { prepared, asOf } = await fixture();
    await publishRelease(folder, prepared, { batchId: "good", asOf });
    await assert.rejects(publishRelease(folder, prepared, { batchId: "interrupted", asOf, beforeSwitch: () => { throw new Error("simulated interruption"); } }), /simulated interruption/);
    assert.equal(readFileSync(join(folder, "CURRENT"), "utf8").trim(), "good");
    assert.equal(existsSync(join(folder, "publication.lock")), false);
    const reader = createReleasedRepository(folder, () => asOf);
    try { assert.equal((await reader.search({})).length, 1); } finally { reader.close(); }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("empty source failure, invalid data and concurrent writer locks cannot replace a good batch", async () => {
  const folder = root();
  try {
    const { prepared, asOf } = await fixture(); await publishRelease(folder, prepared, { batchId: "good", asOf });
    const empty = structuredClone(prepared); empty.dataset.events = []; empty.dataset.provenance = [];
    await assert.rejects(publishRelease(folder, empty, { batchId: "empty", asOf }), /EMPTY_OR_INVALID/);
    const broken = structuredClone(prepared); (broken.dataset.events[0] as any).latitude = null;
    await assert.rejects(publishRelease(folder, broken, { batchId: "broken", asOf }), /INVALID_PUBLICATION/);
    writeFileSync(join(folder, "publication.lock"), "owned by another writer", { flag: "wx" });
    await assert.rejects(publishRelease(folder, prepared, { batchId: "locked", asOf }), /PUBLICATION_LOCKED/);
    unlinkSync(join(folder, "publication.lock"));
    assert.equal(inspectRelease(folder).batch, "good");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("reader switches batches, preserves history, and excludes expired/stale events", async () => {
  const folder = root(); let time = "2026-11-12T03:00:00Z";
  const reader = createReleasedRepository(folder, () => time);
  try {
    const { prepared, asOf } = await fixture(); await publishRelease(folder, prepared, { batchId: "first", asOf });
    const id = prepared.dataset.events[0].id;
    assert.equal((await reader.search({ date: "2026-11-14" })).length, 1);
    await publishRelease(folder, prepared, { batchId: "second", asOf });
    assert.equal((await reader.getByIds([id])).size, 1); assert.equal(reader.getStatus(id)!.allowPlanning, true);
    time = "2026-11-13T16:00:00Z";
    assert.equal((await reader.search({})).length, 0); assert.equal((await reader.getByIds([id])).size, 1);
    time = "2026-11-14T10:00:00Z";
    assert.equal(reader.getStatus(id)!.reason, "expired");
  } finally { reader.close(); rmSync(folder, { recursive: true, force: true }); }
});

test("corrupt new release does not replace a previously opened reader", async () => {
  const folder = root(); const { prepared, asOf } = await fixture();
  const reader = createReleasedRepository(folder, () => asOf);
  try {
    await publishRelease(folder, prepared, { batchId: "good", asOf }); await reader.search({});
    await publishRelease(folder, prepared, { batchId: "corrupt", asOf });
    appendFileSync(join(folder, "releases/corrupt/provenance.json"), "tampered");
    assert.throws(() => inspectRelease(folder), /INTEGRITY_FAILED/);
    assert.equal((await reader.search({})).length, 1);
  } finally { reader.close(); rmSync(folder, { recursive: true, force: true }); }
});

test("cancellation-only updates hide current results, keep history and cannot be undone by an old post", async () => {
  const folder = root(); const { prepared, asOf, item } = await fixture();
  const reader = createReleasedRepository(folder, () => asOf);
  try {
    await publishRelease(folder, prepared, { batchId: "active", asOf });
    const id = prepared.dataset.events[0].id, empty: PreparedCollection = structuredClone(prepared);
    empty.dataset.events = []; empty.dataset.provenance = [];
    const quote = "文化展厅的秋日文化展已取消";
    await publishRelease(folder, empty, { batchId: "cancelled", asOf, cancellations: [{ event_id: id, source_event_key: item.source_event_key, document: { ...item.document, text: quote }, quote }] });
    assert.equal((await reader.search({})).length, 0); assert.equal((await reader.getByIds([id])).size, 1);
    assert.equal(reader.getStatus(id)!.reason, "cancelled");
    await assert.rejects(publishRelease(folder, prepared, { batchId: "old-repost", asOf }), /NO_ELIGIBLE_UPDATES/);
  } finally { reader.close(); rmSync(folder, { recursive: true, force: true }); }
});

test("NULL-time activities stay discoverable and remain unplannable", async () => {
  const folder = root(); const { item, asOf } = await locatedFixture();
  item.facts.start_at = item.facts.end_at = null; item.facts.suggested_duration_minutes = null;
  const { prepared, rejected } = prepareCollection([item], { asOf, baseDate: "2026-11-12" });
  assert.deepEqual(rejected, []);
  const reader = createReleasedRepository(folder, () => asOf);
  try {
    await publishRelease(folder, prepared, { batchId: "unknown-time", asOf });
    assert.equal((await reader.search({})).length, 1); assert.equal((await reader.search({ date: "2026-11-14" })).length, 1);
    assert.equal(reader.getStatus(prepared.dataset.events[0].id)!.allowPlanning, false);
  } finally { reader.close(); rmSync(folder, { recursive: true, force: true }); }
});

test("availability filtering happens before the 100-row search limit", async () => {
  const folder = root(), path = join(folder, "filter.db");
  let reader: ReturnType<typeof createSqliteEventRepository> | undefined;
  try {
    const db = new DatabaseSync(path); ensureEventsSchema(db);
    const insert = db.prepare("INSERT INTO events(id,title,description,category,venue_name,address,latitude,longitude) VALUES(?,'t','d','展览','v','a',34,108)");
    for (let i = 0; i < 101; i++) insert.run("a_hidden_" + i.toString().padStart(3, "0"));
    insert.run("z_visible"); db.close();
    reader = createSqliteEventRepository(path, { readOnly: true, isAvailable: id => id === "z_visible" });
    assert.deepEqual((await reader.search({})).map(e => e.id), ["z_visible"]);
  } finally { reader?.close(); rmSync(folder, { recursive: true, force: true }); }
});

test("unchanged content cannot refresh verification and stale rows do not block other new events", async () => {
  const folder = root();
  try {
    const { prepared, asOf, item } = await fixture();
    await publishRelease(folder, prepared, { batchId: "first", asOf });
    const later = "2026-11-13T16:00:00Z";
    item.document.fetched_at = later;
    const fresh = structuredClone(item);
    fresh.source_event_key = "new-edition";
    fresh.facts.title = "冬日文化展";
    fresh.document.text = fresh.document.text.replaceAll("秋日文化展", "冬日文化展");
    for (const key of Object.keys(fresh.facts.evidence)) fresh.facts.evidence[key] = fresh.facts.evidence[key].replaceAll("秋日文化展", "冬日文化展");
    const next = prepareCollection([item, fresh], { asOf: later, baseDate: "2026-11-12", identities: inspectRelease(folder).sidecar.identities });
    assert.deepEqual(next.rejected, []);
    const report = await publishRelease(folder, next.prepared, { batchId: "mixed", asOf: later });
    assert.equal(report.written_events, 1); assert.equal(report.discarded.length, 1);
    const state = inspectRelease(folder).sidecar.events[prepared.dataset.events[0].id];
    assert.equal(state.freshness.lastVerifiedAt, asOf);
    const reader = createReleasedRepository(folder, () => later);
    try { assert.deepEqual((await reader.search({})).map(e => e.title), ["冬日文化展"]); } finally { reader.close(); }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("an unverified cancellation cannot change availability", async () => {
  const folder = root();
  try {
    const { prepared, asOf, item } = await fixture();
    await publishRelease(folder, prepared, { batchId: "active", asOf });
    const empty = structuredClone(prepared); empty.dataset.events = []; empty.dataset.provenance = [];
    const quote = "文化展厅的秋日文化展已取消";
    await assert.rejects(publishRelease(folder, empty, { batchId: "bad-cancellation", asOf, cancellations: [{
      event_id: prepared.dataset.events[0].id, source_event_key: item.source_event_key,
      document: { ...item.document, authority: "unverified", text: quote }, quote,
    }] }), /INVALID_CANCELLATION_NOTICE/);
    assert.equal(inspectRelease(folder).batch, "active");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("a field mutated after preparation cannot bypass original fact validation", async () => {
  const folder = root();
  try {
    const { prepared, asOf } = await fixture();
    prepared.dataset.events[0].budget_min = 1000; // Structurally valid but unsupported by its source.
    await assert.rejects(publishRelease(folder, prepared, { batchId: "tampered", asOf }), /WITNESS_MISMATCH/);
    assert.equal(existsSync(join(folder, "CURRENT")), false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

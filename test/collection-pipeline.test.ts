import { test } from "node:test";
import assert from "node:assert/strict";
import { extractionFixture, locatedFixture } from "./collection-downstream-fixture.ts";
import { processCollection, createDeepSeekExtractor } from "../src/collection/pipeline.ts";
import { geocodingKey } from "../src/collection/config.ts";

test("offline pipeline turns trusted facts plus a bound mocked map response into 18 publication fields", async () => {
  const { item, asOf } = await locatedFixture();
  let model = 0;
  const result = await processCollection([{ document: item.document, structured: { activities: [item.facts] } }], {
    asOf, baseDate: "2026-11-12", invoke: async () => { model++; return "{}"; },
    geocoder: { resolve: async () => ({ ok: true, location: item.location, cached: false }) },
  });
  assert.deepEqual(result.rejected, []); assert.equal(model, 0);
  assert.equal(result.prepared.dataset.events.length, 1);
  assert.equal(Object.keys(result.prepared.dataset.events[0]).length, 18);
});

test("unverified posts never consume map requests or become published facts without corroboration", async () => {
  const { facts, document, asOf } = extractionFixture(); document.authority = "unverified";
  let maps = 0;
  const result = await processCollection([{ document, structured: { activities: [facts] } }], { asOf, baseDate: "2026-11-12", requirePrimary: true, geocoder: { resolve: async () => { maps++; return { ok: false, reason: "unexpected" }; } } });
  assert.equal(maps, 0); assert.equal(result.prepared.dataset.events.length, 0);
  assert(result.rejected.some(r => r.reasons.includes("PRIMARY_SOURCE_REQUIRED")));
});

test("primary corroboration is bounded and field conflicts cause rejection", async () => {
  const { facts, document, asOf } = extractionFixture(); document.authority = "unverified";
  let lookups = 0, maps = 0;
  const result = await processCollection([{ document, structured: { activities: [facts] } }], {
    asOf, baseDate: "2026-11-12", requirePrimary: true, corroborate: async () => { lookups++; return { ...document, authority: "publisher" }; },
    invoke: async () => JSON.stringify({ activities: [{ ...facts, venue_name: "错误场馆" }] }),
    geocoder: { resolve: async () => { maps++; return { ok: false, reason: "unexpected" }; } },
  });
  assert.equal(lookups, 1); assert.equal(maps, 0);
  assert(result.rejected.some(r => r.reasons.includes("PRIMARY_SOURCE_CONFLICT_OR_AMBIGUITY")));
});

test("map failures discard rows and model budget prevents unbounded calls", async () => {
  const { facts, document, asOf } = extractionFixture(); let calls = 0;
  const result = await processCollection([{ document }, { document }], {
    asOf, baseDate: "2026-11-12", modelBudget: 1,
    invoke: async () => { calls++; return JSON.stringify({ activities: [facts] }); },
    geocoder: { resolve: async () => ({ ok: false, reason: "MAP_KEY_MISSING" }) },
  });
  assert.equal(calls, 1); assert.equal(result.prepared.dataset.events.length, 0);
  assert(result.rejected.some(r => r.reasons.includes("MAP_KEY_MISSING")));
});

test("DeepSeek extraction adapter shares the search key and uses flash JSON without thinking", async () => {
  const { facts, document } = extractionFixture();
  const invoke = createDeepSeekExtractor({ deepseekKey: "offline-api-key", extractLimit: 1, record: () => {}, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "deepseek-flash"); assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.response_format.type, "json_object");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ activities: [facts] }) } }] });
  } });
  assert.equal(JSON.parse(await invoke("system", { text: document.text, source_url: document.url, schema: {} as any })).activities.length, 1);
});

test("map configuration is independent of model keys and rejects multiline credentials", () => {
  assert.throws(() => geocodingKey({ DEEPSEEK_API_KEY: "model-only" }), /AMAP_WEB_KEY/);
  assert.equal(geocodingKey({ AMAP_WEB_KEY: " map-key " }), "map-key");
  assert.throws(() => geocodingKey({ AMAP_WEB_KEY: "map\nkey" }), /INVALID_COLLECTION_CONFIG/);
});

test("live clocks advance across primary-source and map IO without treating new evidence as future data", async () => {
  const { item, asOf } = await locatedFixture();
  const original = { ...item.document, authority: "unverified" as const };
  let current = asOf;
  const result = await processCollection([{ document: original, structured: { activities: [item.facts] } }], {
    asOf, baseDate: "2026-11-12", requirePrimary: true, now: () => current,
    corroborate: async () => { current = "2026-11-12T03:01:00Z"; return { ...item.document, fetched_at: current }; },
    invoke: async () => { current = "2026-11-12T03:02:00Z"; return JSON.stringify({ activities: [item.facts] }); },
    geocoder: { resolve: async () => { current = "2026-11-12T03:03:00Z"; return { ok: true, location: { ...item.location, verified_at: current }, cached: false }; } },
  });
  assert.deepEqual(result.rejected, []); assert.equal(result.prepared.dataset.events.length, 1);
});

test("missing activity validity may be completed from fresh primary facts, never from a model guess", async () => {
  const { item, asOf } = await locatedFixture();
  const partial = structuredClone(item.facts);
  partial.start_at = partial.end_at = null; partial.confirmed_end_date = null;
  partial.suggested_duration_minutes = null;
  const result = await processCollection([{ document: { ...item.document, authority: "unverified" }, structured: { activities: [partial] } }], {
    asOf, baseDate: "2026-11-12", requirePrimary: true, corroborate: async () => item.document,
    invoke: async () => JSON.stringify({ activities: [item.facts] }),
    geocoder: { resolve: async () => ({ ok: true, location: item.location, cached: false }) },
  });
  assert.deepEqual(result.rejected, []); assert.equal(result.prepared.dataset.events[0].end_at, item.facts.end_at);
});

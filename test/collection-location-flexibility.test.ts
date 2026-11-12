import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeActivityTime } from "../src/collection/time-normalization.ts";
import { extractActivities } from "../src/collection/extraction.ts";
import { createGeocoder, venueSearchLabel } from "../src/collection/geocoding.ts";
import { extractionFixture } from "./collection-downstream-fixture.ts";

test("time normalization accepts seconds, offsets and UTC without inventing dates or hours", () => {
  for (const [input, expected] of [
    ["2026-11-14T15:00:00+08:00", "2026-11-14T15:00"],
    ["2026-11-13T18:18:00+08:00", "2026-11-13T18:18"],
    ["2026-11-14T16:00:00+09:00", "2026-11-14T15:00"],
    ["2026-11-13T18:00:00Z", "2026-11-14T02:00"],
    ["2026-11-14 15:00:12.123", "2026-11-14T15:00"],
    ["2026-02-30T15:00:00+08:00", "2026-02-30T15:00:00+08:00"],
    ["2026-11-14", "2026-11-14"],
    ["2026-11-14T25:00", "2026-11-14T25:00"],
  ]) assert.equal(normalizeActivityTime(input), expected);
  assert.equal(normalizeActivityTime(null), null);
});

test("both model and structured extraction normalize valid timestamps before slot validation", async () => {
  const { facts, document, asOf } = extractionFixture();
  facts.start_at += ":00+08:00"; facts.end_at += ":00+08:00";
  for (const options of [
    { structured: { activities: [facts] } },
    { invoke: async () => JSON.stringify({ activities: [facts] }) },
  ]) {
    const result = await extractActivities(document, { asOf, ...options });
    assert.equal(result.activities[0].facts.start_at, "2026-11-14T10:00");
    assert.equal(result.activities[0].check.valid, true);
  }
});

test("venue search separates floors, stages and doors while retaining the original branch", () => {
  assert.equal(venueSearchLabel("星悦MALL 1F东区通道"), "星悦MALL");
  assert.equal(venueSearchLabel("星悦MALL 1F舞台"), "星悦MALL");
  assert.equal(venueSearchLabel("鸟剑居酒屋（西安高新万达店）1号门前"), "鸟剑居酒屋(西安高新万达店)");
  assert.equal(venueSearchLabel("陕西省文化馆（曲江馆五楼展厅）"), "陕西省文化馆(曲江馆)");
  assert.equal(venueSearchLabel("陕西历史博物馆第七展厅"), "陕西历史博物馆");
  assert.equal(venueSearchLabel("陕西历史博物馆东展厅负一层"), "陕西历史博物馆");
});

const now = "2026-11-12T03:00:00Z";
const poi = { id: "B_OFFLINE", name: "鸟剑居酒屋(高新万达店)", cityname: "西安市", adcode: "610113", adname: "雁塔区", address: "新路1号", location: "108.95,34.23" };
test("shortened fallback finds a matching branch and never selects a different shop", async () => {
  let calls = 0; const diagnostics: unknown[] = [];
  const service = createGeocoder({ key: "secret-test-key", now: () => now, onDiagnostic: event => diagnostics.push(event), fetch: async () => {
    calls++; return Response.json({ status: "1", count: "1", pois: [poi] });
  } });
  const result = await service.resolve({ venue_name: "鸟剑居酒屋（西安高新万达店）1号门前", address: "旧路9号" });
  assert.equal(result.ok, true); assert.equal(calls, 1);
  assert(!JSON.stringify(diagnostics).includes("secret-test-key"));
  const unavailable = createGeocoder({ key: "key", now: () => now, fetch: async () => Response.json({ status: "1", count: "1", pois: [{ ...poi, name: "鸟剑居酒屋(高新GT Mall店)" }] }) });
  assert.deepEqual(await unavailable.resolve({ venue_name: "鸟剑居酒屋(高新万达店)", address: null }), { ok: false, reason: "BRANCH_NOT_CONFIRMED" });
});

test("brand fallback is bounded and floor variants reuse candidate searches for lower latency", async () => {
  let calls = 0;
  const service = createGeocoder({ key: "key", now: () => now, fetch: async url => {
    calls++; const keyword = new URL(String(url)).searchParams.get("keywords");
    return Response.json({ status: "1", count: keyword === "鸟剑居酒屋" ? "1" : "0", pois: keyword === "鸟剑居酒屋" ? [poi] : [] });
  } });
  assert.equal((await service.resolve({ venue_name: "鸟剑居酒屋(西安高新万达店)", address: null })).ok, true);
  const firstCalls = calls; assert(firstCalls <= 3);
  assert.equal((await service.resolve({ venue_name: "鸟剑居酒屋(西安高新万达店)1号门前", address: null })).ok, true);
  assert.equal(calls, firstCalls);
});

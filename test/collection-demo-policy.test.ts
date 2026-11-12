import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFacts, extractActivities } from "../src/collection/extraction.ts";
import { prepareCollection } from "../src/collection/preparation.ts";
import { createGeocoder } from "../src/collection/geocoding.ts";
import { validateDataset } from "../src/collection/validate.ts";
import { collectionFixture } from "./collection-fixture.ts";
import { extractionFixture, locatedFixture } from "./collection-downstream-fixture.ts";

test("demo accepts paraphrased title/summary and nonliteral or absent extraction notes", async () => {
  const { facts, document, asOf } = extractionFixture();
  facts.title = "秋日文化展参观"; facts.description = "文化展厅的秋日展览";
  facts.evidence = { title: "按语义概括的标题，不是正文片段" };
  assert.equal(checkFacts(facts, document, asOf).valid, true);
  const { evidence, ...withoutNotes } = facts;
  let calls = 0;
  const result = await extractActivities(document, { asOf, invoke: async () => {
    calls++; return JSON.stringify({ activities: [withoutNotes] });
  } });
  assert.equal(result.activities[0].check.valid, true); assert.equal(calls, 1);
  assert.equal(result.activities[0].facts.description, facts.description);
});

test("a model's optional summary-string notes do not trigger a paid format retry", async () => {
  const { facts, document, asOf } = extractionFixture(); let calls = 0;
  const result = await extractActivities(document, { asOf, invoke: async () => {
    calls++; return JSON.stringify({ activities: [{ ...facts, evidence: "按语义概括，不要求正文逐字引用" }] });
  } });
  assert.equal(calls, 1); assert.equal(result.activities[0].check.valid, true);
});

test("final publication does not reintroduce a verbatim quote requirement", async () => {
  const { dataset, options } = collectionFixture();
  dataset.provenance[0].evidence[0].quote = "这是一段概括说明";
  assert.equal(validateDataset(dataset, options).valid, true);
  dataset.provenance[0].evidence = [];
  assert.equal(validateDataset(dataset, options).valid, true);
  const { item, asOf } = await locatedFixture(); item.facts.evidence = {};
  assert.deepEqual(prepareCollection([item], { asOf, baseDate: "2026-11-12" }).rejected, []);
});

test("guide_url retains the original social or web source without adding an events column", async () => {
  for (const source of ["https://www.xiaohongshu.com/explore/offline-source", "https://www.sxhm.com/offline-test-notice"]) {
    const { item, asOf } = await locatedFixture(); item.document.url = source;
    const result = prepareCollection([item], { asOf, baseDate: "2026-11-12" });
    assert.deepEqual(result.rejected, []);
    assert.equal(result.prepared.dataset.events[0].guide_url, source);
    assert.equal(result.prepared.dataset.provenance[0].source_url, source);
    assert.equal(Object.keys(result.prepared.dataset.events[0]).length, 29);
  }
});

test("recent unknown-end candidates are retained provisionally, old ones are rejected", async () => {
  const { item, asOf } = await locatedFixture();
  item.facts.start_at = item.facts.end_at = item.facts.confirmed_end_date = item.facts.confirmed_start_date = null;
  item.facts.status = "unknown";
  const result = prepareCollection([item], { asOf, baseDate: "2026-11-12" });
  assert.deepEqual(result.rejected, []);
  assert.equal(Object.values(result.prepared.metadata)[0].status, "unknown");
  item.document.published_at = "2026-11-01T01:00:00Z";
  assert(checkFacts(item.facts, item.document, asOf).issues.includes("VALIDITY_UNKNOWN"));
});

test("AMap address wins for a unique named venue, while ambiguous branches and wrong city remain rejected", async () => {
  const poi = { id: "B_OFFLINE", name: "文化展厅", cityname: "西安市", adcode: "610113", adname: "雁塔区", address: "新文化路88号", location: "108.95,34.23" };
  const query = { venue_name: "文化展厅", address: "西安市碑林区旧文化路1号" };
  const service = (pois: unknown[]) => createGeocoder({ key: "test", now: () => "2026-11-12T03:00:00Z", fetch: async () => Response.json({ status: "1", count: String(pois.length), pois }) });
  const found = await service([poi]).resolve(query);
  assert.equal(found.ok, true);
  if (found.ok) assert.equal(found.location.address, "西安市雁塔区新文化路88号");
  assert.deepEqual(await service([poi, { ...poi, id: "other" }]).resolve(query), { ok: false, reason: "AMBIGUOUS_POI" });
  assert.deepEqual(await service([{ ...poi, cityname: "咸阳市", adcode: "610402" }]).resolve(query), { ok: false, reason: "NO_EXACT_POI_MATCH" });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { completeFacts, checkFacts, extractActivities, inferredEndDate } from "../src/collection/extraction.ts";
import { extractionFixture, locatedFixture } from "./collection-downstream-fixture.ts";
import { processCollection } from "../src/collection/pipeline.ts";

test("recent first publication supports missing year; an edit alone and cross-year dates do not", () => {
  const { document, asOf } = extractionFixture();
  document.text = "参观画展，展览到11.29日结束";
  assert.equal(inferredEndDate(document, asOf), "2026-11-29");
  document.published_at = "2025-11-12T01:00:00Z"; document.updated_at = asOf;
  assert.equal(inferredEndDate(document, asOf), null);
  document.published_at = asOf; document.text = "去年画展回顾，展览到11.29日结束";
  assert.equal(inferredEndDate(document, asOf), null);
  document.text = "展览到1.29日结束";
  assert.equal(inferredEndDate(document, asOf), null);
});

test("model receives actual collection clock and publication/edit context", async () => {
  const { document, asOf } = extractionFixture(); document.updated_at = asOf;
  await extractActivities(document, { asOf, invoke: async (_system, input) => {
    assert.equal(input.current_time, asOf); assert.equal(input.published_at, document.published_at);
    assert.equal(input.updated_at, asOf); assert.equal(input.timezone, "Asia/Shanghai");
    return '{"activities":[]}';
  } });
});

test("completion repairs missing literal references and computes future availability without invented hours", () => {
  const { facts, document, asOf } = extractionFixture();
  facts.status = "unknown"; delete facts.evidence.city; delete facts.evidence.description;
  facts.start_at = facts.end_at = null;
  const repaired = completeFacts(facts, document, asOf);
  assert.equal(repaired.status, "active"); assert.equal(repaired.evidence.city, "西安市");
  assert.equal(repaired.start_at, null); assert.equal(repaired.end_at, null);
  assert.equal(checkFacts(repaired, document, asOf).valid, true);
});

test("month/day model output is normalized locally with an auditable publication basis", () => {
  const { facts, document, asOf } = extractionFixture();
  document.text += "展览到11.29日结束";
  facts.confirmed_end_date = "11.29"; facts.evidence.confirmed_end_date = "展览到11.29日结束";
  const result = completeFacts(facts, document, asOf);
  // An explicit year elsewhere in a mixed document prevents inferring a second year.
  assert.equal(result.confirmed_end_date, "11.29");
  document.text = "参观画展，展览到11.29日结束";
  assert.equal(completeFacts(facts, document, asOf).confirmed_end_date, "2026-11-29");
});

test("an invalid date becomes a note without an extra paid semantic retry", async () => {
  const { facts, document, asOf } = extractionFixture(); let calls = 0;
  const result = await extractActivities(document, { asOf, invoke: async (system) => {
    calls++;
    if (calls === 1) return JSON.stringify({ activities: [{ ...facts, confirmed_end_date: "2026-99-99" }] });
    assert(system.includes("INVALID_END_DATE"));
    return JSON.stringify({ activities: [facts] });
  } });
  assert.equal(calls, 1); assert.equal(result.activities[0].check.valid, true);
  assert.match(result.activities[0].facts.time_note!, /2026-99-99/);
});

test("recaps, cancellations and expired dates remain rejected after completion", () => {
  for (const text of ["累计接待300人次", "活动取消", "活动回顾"]) {
    const { facts, document, asOf } = extractionFixture(); facts.status = "unknown"; document.text += text;
    assert.equal(checkFacts(completeFacts(facts, document, asOf), document, asOf).valid, false);
  }
  const { facts, document, asOf } = extractionFixture();
  document.text += "开放至2026年11月11日"; facts.status = "unknown";
  facts.confirmed_end_date = "2026-11-11"; facts.evidence.confirmed_end_date = "开放至2026年11月11日";
  assert.equal(completeFacts(facts, document, asOf).status, "past");
});

test("an original social post can publish with map-confirmed city and keeps its own URL", async () => {
  const { item, asOf } = await locatedFixture(); item.document.authority = "unverified";
  item.facts.city = null; delete item.facts.evidence.city;
  let lookups = 0;
  const result = await processCollection([{ document: item.document, structured: { activities: [item.facts] } }], {
    asOf, baseDate: "2026-11-12", corroborate: async () => { lookups++; return null; },
    geocoder: { resolve: async () => ({ ok: true, location: item.location, cached: false }) },
  });
  assert.deepEqual(result.rejected, []); assert.equal(lookups, 0);
  const provenance = result.prepared.dataset.provenance[0];
  assert.equal(provenance.source_url, item.document.url);
  assert.equal(provenance.city_evidence.source_url, item.location.source_url);
  assert.equal(result.prepared.dataset.events[0].start_at, item.facts.start_at);
});

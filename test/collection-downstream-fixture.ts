import type { ActivityFacts, ExtractionDocument } from "../src/collection/extraction.ts";
import { createGeocoder } from "../src/collection/geocoding.ts";
import type { LocatedActivity } from "../src/collection/preparation.ts";

export function extractionFixture() {
  const text = "2026年11月14日10:00至17:00，西安市雁塔区文化路1号文化展厅举办秋日文化展。展览对公众开放，票价每人20元，建议停留90分钟。";
  const facts: ActivityFacts = {
    title: "秋日文化展", description: "展览对公众开放", category: "展览", venue_name: "文化展厅", address: "西安市雁塔区文化路1号",
    city: "西安市", start_at: "2026-11-14T10:00", end_at: "2026-11-14T17:00", suggested_duration_minutes: 90,
    budget_min: 2000, budget_max: 2000, budget_note: null, confirmed_end_date: "2026-11-14", confirmed_start_date: "2026-11-14", schedule_type: "window", status: "active", conflicts: [],
    evidence: Object.fromEntries(["title", "description", "category", "venue_name", "address", "city", "start_at", "end_at", "suggested_duration_minutes", "budget_min", "budget_max", "confirmed_end_date", "confirmed_start_date", "status"].map(k => [k, text])),
  };
  const document: ExtractionDocument = { url: "https://www.sxhm.com/offline-test-notice", text, published_at: "2026-11-12T01:00:00Z", fetched_at: "2026-11-12T02:00:00Z", authority: "publisher", content_scope: "exported_text", image_urls: [] };
  return { facts, document, asOf: "2026-11-12T03:00:00Z" };
}

export async function locatedFixture(): Promise<{ item: LocatedActivity; asOf: string }> {
  const { facts, document, asOf } = extractionFixture();
  const service = createGeocoder({ key: "offline-fixture-key", now: () => asOf, fetch: async () => Response.json({
    status: "1", count: "1", pois: [{ id: "B_OFFLINE_TEST", name: facts.venue_name, address: "文化路1号", cityname: "西安市", adname: "雁塔区", adcode: "610113", location: "108.95,34.23" }],
  }) });
  const result = await service.resolve({ venue_name: facts.venue_name, address: facts.address });
  if (!result.ok) throw new Error(result.reason);
  return { item: { facts, document, location: result.location, source_event_key: "offline:autumn-2026", first_seen_at: document.fetched_at }, asOf };
}

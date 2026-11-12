import { test } from "node:test";
import assert from "node:assert/strict";
import { readAmapSharedVenue } from "../src/collection/amap-share.ts";
import { createGeocoder } from "../src/collection/geocoding.ts";
import { extractionFixture } from "./collection-downstream-fixture.ts";
import { prepareCollection } from "../src/collection/preparation.ts";

const share = "https://surl.amap.com/OfflineVenue123";
function redirect() {
  const target = new URL("https://wb.amap.com/");
  target.searchParams.set("p", "B0M2OZ0CGE,34.20856257151087,108.89016106724736,鸟剑居酒屋(高新万达店),丈八街道万达广场西安高新店(1号门)");
  target.searchParams.set("userRelationToken", "tracking-secret");
  return new Response(null, { status: 302, headers: { location: target.href } });
}

test("official short share extracts only POI metadata and drops tracking fields", async () => {
  const reference = await readAmapSharedVenue(share, async () => redirect());
  assert.equal(reference?.poi_id, "B0M2OZ0CGE");
  assert.equal(reference?.name, "鸟剑居酒屋(高新万达店)");
  assert.equal(reference?.original.lng, 108.89016106724736);
  assert(!JSON.stringify(reference).includes("tracking-secret"));
  assert.equal(await readAmapSharedVenue("http://127.0.0.1", async () => { throw Error("must not fetch"); }), null);
  assert.equal(await readAmapSharedVenue(share, async () => new Response(null, { status: 302, headers: { location: "https://untrusted.invalid/?p=B0M2OZ0CGE,34.2,108.9,x,y" } })), null);
});

test("a share-only App POI can be located and published with separate provenance and city verification", async () => {
  const { facts, document, asOf } = extractionFixture();
  facts.venue_name = "鸟剑居酒屋（西安高新万达店）1号门前"; facts.address = "旧地址9号";
  document.text += "鸟剑开业";
  const service = createGeocoder({ key: "key", now: () => asOf, shareUrls: [share], fetch: async url => {
    const u = new URL(String(url));
    if (u.hostname === "surl.amap.com") return redirect();
    if (u.pathname === "/v3/geocode/regeo") return Response.json({ status: "1", regeocode: { addressComponent: { city: "西安市", district: "雁塔区", adcode: "610113" } } });
    return Response.json({ status: "1", count: "0", pois: [] });
  } });
  const result = await service.resolve({ venue_name: facts.venue_name, address: facts.address, require_entrance: false });
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.location.method, "share"); assert.equal(result.location.source_url, share);
  assert.deepEqual(await service.resolve({ venue_name: facts.venue_name, address: facts.address, require_entrance: true }), { ok: false, reason: "ENTRANCE_NOT_CONFIRMED" });
  const built = prepareCollection([{ facts, document, location: result.location, source_event_key: "offline:bird", first_seen_at: document.fetched_at }], { asOf, baseDate: "2026-11-12" });
  assert.deepEqual(built.rejected, []);
  assert.equal(built.prepared.dataset.provenance[0].source_url, document.url);
  const tampered = structuredClone(result.location); tampered.share_reference!.name = "鸟剑居酒屋(万象天地店)";
  assert(prepareCollection([{ facts, document, location: tampered, source_event_key: "offline:bird", first_seen_at: document.fetched_at }], { asOf, baseDate: "2026-11-12" }).rejected[0].reasons.includes("LOCATION_NOT_VERIFIED_OR_NOT_BOUND"));
});

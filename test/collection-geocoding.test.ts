import { test } from "node:test";
import assert from "node:assert/strict";
import { createGeocoder } from "../src/collection/geocoding.ts";
import type { VerifiedLocation } from "../src/collection/geocoding.ts";
import { wgs84ToGcj02, gcj02ToWgs84 } from "../src/collection/coordinates.ts";

const now = "2026-11-12T03:00:00Z";
const query = { venue_name: "文化展厅", address: "西安市雁塔区文化路1号" };
const poi = { id: "B_OFFLINE_TEST", name: "文化展厅", cityname: "西安市", adcode: "610113", adname: "雁塔区", address: "文化路1号", location: "108.95,34.23" };
const answer = (pois: unknown[]) => ({ status: "1", count: String(pois.length), pois });

test("POI resolution restricts city, binds branch/address and converts longitude-first GCJ coordinates", async () => {
  const service = createGeocoder({ key: "private-map-key", now: () => now, fetch: async (value, options) => {
    const url = new URL(String(value));
    assert.equal(url.hostname, "restapi.amap.com"); assert.equal(url.searchParams.get("citylimit"), "true");
    assert.equal(url.searchParams.get("city"), "西安"); assert.equal(options?.redirect, "error");
    return Response.json(answer([poi]));
  } });
  const result = await service.resolve(query);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.location.system, "WGS-84"); assert.equal(result.location.original.lng, 108.95);
  assert.notEqual(result.location.longitude, 108.95);
  assert(!JSON.stringify(result).includes("private-map-key"));
});

const bad: [string, object[], string][] = [
  ["two matching branches", [poi, { ...poi, id: "another" }], "AMBIGUOUS_POI"],
  ["wrong branch", [{ ...poi, name: "文化展厅东馆" }], "NO_EXACT_POI_MATCH"],
  ["wrong city", [{ ...poi, cityname: "咸阳市", adcode: "610402" }], "NO_EXACT_POI_MATCH"],
  ["swapped axes", [{ ...poi, location: "34.23,108.95" }], "INVALID_MAP_COORDINATE"],
  ["distant entrance", [{ ...poi, entr_location: "109.4,35" }], "ENTRANCE_CONFLICT"],
];
for (const [name, pois, reason] of bad) test(`geocoder rejects ${name}`, async () => {
  const service = createGeocoder({ key: "test-key", now: () => now, fetch: async () => Response.json(answer(pois)) });
  assert.deepEqual(await service.resolve(query), { ok: false, reason });
});

test("only precise, unique geocoding fallback is accepted", async () => {
  for (const level of ["市", "区县", "道路", "未知", "门牌号"]) {
    let calls = 0;
    const service = createGeocoder({ key: "test-key", now: () => now, fetch: async () => Response.json(++calls === 1 ? answer([]) : {
      status: "1", geocodes: [{ city: "西安市", adcode: "610113", district: "雁塔区", formatted_address: "陕西省西安市雁塔区文化路1号", location: "108.95,34.23", level }],
    }) });
    const result = await service.resolve(query);
    assert.equal(result.ok, level === "门牌号"); assert.equal(calls, 2);
  }
});

test("cache reuses verified venues, expires at 30 days and invalidates on address changes", async () => {
  let calls = 0, date = now;
  const cache = new Map<string, VerifiedLocation>();
  const service = createGeocoder({ key: "test-key", now: () => date, cache, fetch: async () => { calls++; return Response.json(answer([poi])); } });
  assert.equal((await service.resolve(query)).ok, true);
  const cached = await service.resolve(query); assert.equal(cached.ok && cached.cached, true); assert.equal(calls, 1);
  date = "2026-12-12T03:00:00Z"; await service.resolve(query); assert.equal(calls, 2);
  await service.resolve({ ...query, address: "西安市雁塔区另一条路2号" }); assert.equal(calls, 3);
});

test("floor suffixes and guanqu spelling preserve branch matching without requiring identical punctuation", async () => {
  const service = createGeocoder({ key: "test", now: () => now, fetch: async () => Response.json(answer([
    { ...poi, name: "陕西省文化馆曲江馆区" },
  ])) });
  assert.equal((await service.resolve({ venue_name: "陕西省文化馆（曲江馆五楼展厅）", address: null })).ok, true);
  const other = await service.resolve({ venue_name: "陕西省文化馆（长安馆五楼展厅）", address: null });
  assert.deepEqual(other, { ok: false, reason: "NO_EXACT_POI_MATCH" });
});

test("request failures, API denial, oversized responses and exhausted budgets fail closed without key leakage", async () => {
  for (const fetcher of [
    async () => { throw new Error("private-map-key"); },
    async () => Response.json({ status: "0", info: "private-map-key" }),
    async () => new Response("x".repeat(1024 * 1024 + 1)),
  ]) {
    const result = await createGeocoder({ key: "private-map-key", now: () => now, fetch: fetcher }).resolve(query);
    assert.equal(result.ok, false); assert(!JSON.stringify(result).includes("private-map-key"));
  }
  let calls = 0;
  const noKey = await createGeocoder({ now: () => now, fetch: async () => { calls++; return Response.json({}); } }).resolve(query);
  assert.deepEqual(noKey, { ok: false, reason: "MAP_KEY_MISSING" }); assert.equal(calls, 0);
  assert.deepEqual(await createGeocoder({ key: "test", now: () => now, requestLimit: 0 }).resolve(query), { ok: false, reason: "MAP_BUDGET_EXHAUSTED" });
});

test("unique exact venue survives fuzzy count; large sites still require entrance", async () => {
  const partial = await createGeocoder({ key: "test", now: () => now, fetch: async () => Response.json({ ...answer([poi]), count: "20" }) }).resolve({ ...query, address: null });
  assert.equal(partial.ok, true);
  const entrance = await createGeocoder({ key: "test", now: () => now, fetch: async () => Response.json(answer([poi])) }).resolve({ ...query, require_entrance: true });
  assert.deepEqual(entrance, { ok: false, reason: "ENTRANCE_NOT_CONFIRMED" });
});

test("truncated fuzzy search requires exact name/address plus agreeing precise geocode", async () => {
  for (const location of ["108.95,34.23", "109.4,34.9"]) {
    let calls = 0;
    const result = await createGeocoder({ key: "test", now: () => now, fetch: async () => Response.json(++calls === 1
      ? { ...answer([poi]), count: "552" }
      : { status: "1", geocodes: [{ city: "西安市", adcode: "610113", district: "雁塔区", formatted_address: query.address, level: "门牌号", location }] }) }).resolve(query);
    assert.equal(result.ok, location === "108.95,34.23"); assert.equal(calls, 2);
    if (result.ok) assert(result.location.address_confirmation);
    else assert.equal(result.reason, "POI_GEOCODE_CONFLICT");
  }
});

test("multiple address points require exactly one to agree with the already name-bound POI", async () => {
  for (const locations of [["108.95,34.23", "108.93,34.24"], ["108.95,34.23", "108.9501,34.2301"]]) {
    let calls = 0;
    const result = await createGeocoder({ key: "test", now: () => now, fetch: async () => Response.json(++calls === 1
      ? { ...answer([poi]), count: "552" }
      : { status: "1", geocodes: locations.map(location => ({ city: "西安市", adcode: "610113", formatted_address: query.address, level: "门址", location })) }) }).resolve(query);
    assert.equal(result.ok, locations[1] === "108.93,34.24");
  }
});

test("conversion matches upstream published vectors and round-trips five Xi'an numerical points", () => {
  // Reference vectors from googollee/eviltransform/javascript/test.js (BSD notice retained).
  for (const [lat, lng, expectedLat, expectedLng] of [[31.1774276, 121.5272106, 31.17530398364597, 121.531541859215], [22.543847, 113.912316, 22.540796131694766, 113.9171774808363], [39.911954, 116.377817, 39.91334545536069, 116.38404722455657]]) {
    const actual = wgs84ToGcj02({ lat, lng });
    // Upstream published vectors and current transform constants differ at ~1e-6 degrees.
    assert(Math.abs(actual.lat - expectedLat) < 1.5e-6); assert(Math.abs(actual.lng - expectedLng) < 1.5e-6);
  }
  // Numerical fixtures only; these are NOT five independently measured real venues.
  for (const point of [{ lat: 34.23, lng: 108.95 }, { lat: 34.26, lng: 108.94 }, { lat: 34.28, lng: 108.96 }, { lat: 34.22, lng: 108.98 }, { lat: 34.35, lng: 108.9 }]) {
    const result = gcj02ToWgs84(wgs84ToGcj02(point));
    assert(Math.abs(result.lat - point.lat) < 1e-7); assert(Math.abs(result.lng - point.lng) < 1e-7);
  }
  assert.throws(() => gcj02ToWgs84({ lat: NaN, lng: 108 }), /INVALID_COORDINATE/);
});

import { createHash } from "node:crypto";
import { gcj02ToWgs84, CONVERSION_VERSION } from "./coordinates.ts";
import type { Coordinate } from "./coordinates.ts";

export interface VenueQuery { venue_name: string; address: string | null; require_entrance?: boolean; }
export interface VerifiedLocation {
  request_key: string; venue_name: string; address: string; poi_id: string | null;
  adcode: string; district: string; latitude: number; longitude: number;
  input_system: "GCJ-02"; system: "WGS-84"; original: Coordinate;
  conversion: string; source_url: string; verified_at: string; method: "poi" | "geocoding";
  address_confirmation?: { address: string; level: string; original: Coordinate };
}
export type GeoResult = { ok: true; location: VerifiedLocation; cached: boolean } | { ok: false; reason: string };
export interface GeocoderOptions {
  key?: string; fetch?: typeof fetch; now: () => string;
  cache?: Map<string, VerifiedLocation>; requestLimit?: number;
}
const norm = (value: string) => value.normalize("NFKC").replace(/[\s（）()，,]/g, "");
// Keep branch identity; remove only a floor/exhibition-room suffix and punctuation.
const venueName = (value: string) => norm(value).replace(/[一二三四五六七八九十百0-9]+楼(?:展厅|展馆)?$/, "").replace(/馆区$/, "馆");
const districts = ["新城区", "碑林区", "莲湖区", "灞桥区", "未央区", "雁塔区", "阎良区", "临潼区", "长安区", "高陵区", "鄠邑区", "蓝田县", "周至县"];
const cityAddress = (address: string) => districts.reduce((s, d) => s.replaceAll(d, ""), norm(address).replaceAll("陕西省", "").replaceAll("西安市", "").replaceAll("曲江新区", ""));
function sameAddress(request: string, actual: string): boolean {
  const a = cityAddress(request), b = cityAddress(actual);
  const requestedDoor = /\d+(?:-\d+)?号/.exec(a)?.[0];
  if (requestedDoor && /\d+(?:-\d+)?号/.exec(b)?.[0] !== requestedDoor) return false;
  return a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a));
}
function xian(row: Record<string, unknown>): boolean {
  return (row.cityname === "西安市" || row.city === "西安市") && /^6101\d{2}$/.test(String(row.adcode));
}
function coordinate(value: unknown): Coordinate | null {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(value)) return null;
  const [lng, lat] = value.split(",").map(Number);
  return lat >= 33 && lat <= 35.5 && lng >= 107 && lng <= 110.5 ? { lat, lng } : null;
}
export function venueRequestKey(query: VenueQuery): string {
  return createHash("sha256").update(JSON.stringify([norm(query.venue_name), query.address === null ? null : norm(query.address), !!query.require_entrance])).digest("hex");
}

/** Fixed endpoints, bounded body/time/call budgets, no raw error or key-bearing URL logs. */
export function createGeocoder(options: GeocoderOptions) {
  const cache = options.cache ?? new Map<string, VerifiedLocation>();
  let requests = 0;
  async function request(path: string, params: Record<string, string>): Promise<Record<string, any>> {
    if (!options.key?.trim()) throw new Error("MAP_KEY_MISSING");
    if (requests >= (options.requestLimit ?? 10)) throw new Error("MAP_BUDGET_EXHAUSTED");
    requests++;
    const url = new URL("https://restapi.amap.com" + path);
    for (const [name, value] of Object.entries({ ...params, key: options.key })) url.searchParams.set(name, value);
    let response: Response;
    try { response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(8000), redirect: "error" }); }
    catch { throw new Error("MAP_NETWORK_ERROR"); }
    if (!response.ok) throw new Error("MAP_HTTP_ERROR");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("MAP_EMPTY_RESPONSE");
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error("MAP_RESPONSE_TOO_LARGE"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let data: any;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("MAP_INVALID_JSON"); }
    if (data?.status !== "1") throw new Error("MAP_API_REJECTED");
    return data;
  }
  return {
    async resolve(query: VenueQuery): Promise<GeoResult> {
      const key = venueRequestKey(query), now = options.now(), instant = Date.parse(now);
      if (!Number.isFinite(instant) || !query.venue_name.trim()) return { ok: false, reason: "INVALID_VENUE_QUERY" };
      const cached = cache.get(key);
      if (cached && cached.request_key === key && Number.isFinite(cached.latitude) && Number.isFinite(cached.longitude)
        && cached.latitude >= 33 && cached.latitude <= 35.5 && cached.longitude >= 107 && cached.longitude <= 110.5
        && cached.system === "WGS-84" && cached.conversion === CONVERSION_VERSION && /^6101\d{2}$/.test(cached.adcode)
        && instant >= Date.parse(cached.verified_at) && instant - Date.parse(cached.verified_at) < 30 * 86400000) {
        return { ok: true, location: structuredClone(cached), cached: true };
      }
      try {
        const data = await request("/v3/place/text", { keywords: venueName(query.venue_name), city: "西安", citylimit: "true", extensions: "all", offset: "25", page: "1", children: "0" });
        if (!Array.isArray(data.pois)) return { ok: false, reason: "MAP_INVALID_POI_RESPONSE" };
        if (!/^\d+$/.test(String(data.count))) return { ok: false, reason: "MAP_INVALID_POI_RESPONSE" };
        const truncated = Number(data.count) > data.pois.length;
        // Fuzzy count includes unrelated amenities; exact venue candidates are matched below.
        let matches = data.pois.filter((poi: any) => poi && xian(poi) && venueName(String(poi.name)) === venueName(query.venue_name)
          && typeof poi.id === "string" && !!poi.id && typeof poi.address === "string" && poi.address.length >= 5
          && typeof poi.adname === "string" && !!poi.adname);
        if (matches.length > 1 && query.address) {
          const addressed = matches.filter((poi: any) => sameAddress(query.address!, poi.address));
          if (addressed.length === 1) matches = addressed;
        }
        if (matches.length > 1) return { ok: false, reason: "AMBIGUOUS_POI" };
        let row: Record<string, any>, point: Coordinate | null, method: VerifiedLocation["method"], address: string, source: string;
        let confirmation: VerifiedLocation["address_confirmation"];
        if (matches.length === 1) {
          row = matches[0];
          point = coordinate(row.entr_location || row.location);
          if (row.entr_location) {
            const center = coordinate(row.location);
            if (!center || !point || Math.hypot((center.lat - point.lat) * 111320, (center.lng - point.lng) * 111320 * Math.cos(center.lat * Math.PI / 180)) > 1000) return { ok: false, reason: "ENTRANCE_CONFLICT" };
          }
          if (query.require_entrance && !row.entr_location) return { ok: false, reason: "ENTRANCE_NOT_CONFIRMED" };
          address = `西安市${row.adname}${row.address}`; method = "poi"; source = "https://restapi.amap.com/v3/place/text";
          if (truncated && query.address && sameAddress(query.address, row.address) && /\d+号/.test(norm(query.address))) {
            // A fuzzy result count includes amenities and unrelated venues. For an
            // address-bound exact name match, independently resolve the printed door
            // number and require it to agree with the POI, rather than choosing rank 1.
            const check = await request("/v3/geocode/geo", { address: query.address!, city: "西安" });
            const candidates = (Array.isArray(check.geocodes) ? check.geocodes : []).filter((g: any) => g && coordinate(g.location) && xian(g)
              && ["门牌号", "单元号", "门址"].includes(g.level) && typeof g.formatted_address === "string" && sameAddress(query.address!, g.formatted_address));
            const agreeing = candidates.filter((g: any) => { const p = coordinate(g.location)!;
              return point && Math.hypot((point.lat - p.lat) * 111320, (point.lng - p.lng) * 111320 * Math.cos(point.lat * Math.PI / 180)) <= 500;
            });
            if (agreeing.length !== 1) return { ok: false, reason: agreeing.length > 1 ? "POI_ADDRESS_UNCONFIRMED" : candidates.length ? "POI_GEOCODE_CONFLICT" : "POI_ADDRESS_UNCONFIRMED" };
            const geo = agreeing[0], geoPoint = coordinate(geo.location)!;
            confirmation = { address: geo.formatted_address, level: geo.level, original: geoPoint };
          }
        } else {
          if (data.pois.length) return { ok: false, reason: "NO_EXACT_POI_MATCH" };
          if (!query.address || !/\d+号/.test(norm(query.address))) return { ok: false, reason: "PRECISE_ADDRESS_REQUIRED" };
          const geocoded = await request("/v3/geocode/geo", { address: query.address, city: "西安" });
          if (!Array.isArray(geocoded.geocodes) || geocoded.geocodes.length !== 1) return { ok: false, reason: "AMBIGUOUS_GEOCODE" };
          row = geocoded.geocodes[0];
          if (!xian(row) || !["门牌号", "单元号", "门址"].includes(row.level)
            || typeof row.formatted_address !== "string" || !sameAddress(query.address, row.formatted_address)) return { ok: false, reason: "COARSE_OR_CONFLICTING_GEOCODE" };
          if (query.require_entrance) return { ok: false, reason: "ENTRANCE_NOT_CONFIRMED" };
          point = coordinate(row.location); address = row.formatted_address; method = "geocoding"; source = "https://restapi.amap.com/v3/geocode/geo";
        }
        if (!point) return { ok: false, reason: "INVALID_MAP_COORDINATE" };
        const converted = gcj02ToWgs84(point);
        const location: VerifiedLocation = { request_key: key, venue_name: query.venue_name, address, poi_id: method === "poi" ? row.id : null,
          adcode: String(row.adcode), district: String(row.adname ?? row.district), latitude: converted.lat, longitude: converted.lng,
          input_system: "GCJ-02", system: "WGS-84", original: point, conversion: CONVERSION_VERSION, source_url: source, verified_at: now, method,
          ...(confirmation ? { address_confirmation: confirmation } : {}) };
        cache.set(key, structuredClone(location));
        return { ok: true, location, cached: false };
      } catch (error) {
        const code = error instanceof Error && /^MAP_[A-Z_]+$/.test(error.message) ? error.message : "MAP_PROCESSING_ERROR";
        return { ok: false, reason: code };
      }
    },
  };
}

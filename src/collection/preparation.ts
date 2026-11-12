import { createHash } from "node:crypto";
import { checkFacts } from "./extraction.ts";
import type { ActivityFacts, ExtractionDocument } from "./extraction.ts";
import { gcj02ToWgs84, CONVERSION_VERSION } from "./coordinates.ts";
import { venueRequestKey } from "./geocoding.ts";
import type { VerifiedLocation } from "./geocoding.ts";
import { registerSlot } from "./identity.ts";
import type { SlotIdentity } from "./identity.ts";
import type { NightlyMetadata } from "./freshness.ts";
import type { RealDataset, FieldEvidence, EventProvenance } from "./types.ts";
import type { SourceDocument } from "./validate.ts";
import { validateDataset } from "./validate.ts";
import { isCalendarDate } from "../itinerary/constraints.ts";
import type { VenueQuery } from "./geocoding.ts";

export const textHash = (text: string) => createHash("sha256").update(text).digest("hex");
export interface PreparedCollection {
  dataset: RealDataset; metadata: Record<string, NightlyMetadata>;
  identities: SlotIdentity[]; documents: Map<string, SourceDocument>;
  /** Private validation inputs; never included in the published database or sidecar. */
  witnesses: Record<string, LocatedActivity>;
}
export interface LocatedActivity {
  facts: ActivityFacts; document: ExtractionDocument; location: VerifiedLocation;
  source_event_key: string; first_seen_at: string;
}
export function locationQueryForFacts(facts: ActivityFacts): VenueQuery {
  return { venue_name: facts.venue_name, address: facts.address,
    require_entrance: facts.category === "户外活动" || /公园|景区|城墙|遗址/.test(facts.venue_name) };
}

/** The model has no access to this step. Recheck facts, source policy and map binding
 * before assigning an ID. Unknown source authority always requires primary corroboration.
 */
export function prepareCollection(items: readonly LocatedActivity[], options: { asOf: string; baseDate: string; identities?: readonly SlotIdentity[] }) {
  if (!isCalendarDate(options.baseDate)) throw new Error("INVALID_BASE_DATE");
  const horizon = new Date(Date.parse(options.baseDate + "T00:00:00Z") + 14 * 86400000).toISOString().slice(0, 10);
  const prepared: PreparedCollection = { dataset: { schema_version: "xian-events/3", base_date: options.baseDate, days: 14, events: [], provenance: [] },
    metadata: {}, identities: structuredClone([...(options.identities ?? [])]), documents: new Map(), witnesses: {} };
  const rejected: { source_event_key: string; reasons: string[] }[] = [];
  for (const item of items) {
    const { facts, document, location } = item;
    if (facts.confirmed_start_date !== null && facts.confirmed_start_date >= horizon) { rejected.push({ source_event_key: item.source_event_key, reasons: ["OUTSIDE_BATCH"] }); continue; }
    const checked = checkFacts(facts, document, options.asOf);
    if (!checked.valid || checked.needs_primary_source) {
      rejected.push({ source_event_key: item.source_event_key, reasons: [...checked.issues, ...(checked.needs_primary_source ? ["PRIMARY_SOURCE_REQUIRED"] : [])] }); continue;
    }
    const requested = venueRequestKey(locationQueryForFacts(facts));
    const age = Date.parse(options.asOf) - Date.parse(location.verified_at);
    let mapValid = location.request_key === requested && location.system === "WGS-84" && location.input_system === "GCJ-02"
      && location.conversion === CONVERSION_VERSION && /^6101\d{2}$/.test(location.adcode) && location.venue_name === facts.venue_name
      && ["https://restapi.amap.com/v3/place/text", "https://restapi.amap.com/v3/geocode/geo"].includes(location.source_url)
      && age >= 0 && age < 30 * 86400000 && location.address.includes("西安");
    try {
      const computed = gcj02ToWgs84(location.original);
      mapValid &&= Math.abs(computed.lat - location.latitude) < 1e-7 && Math.abs(computed.lng - location.longitude) < 1e-7;
    } catch { mapValid = false; }
    if (!mapValid) { rejected.push({ source_event_key: item.source_event_key, reasons: ["LOCATION_NOT_VERIFIED_OR_NOT_BOUND"] }); continue; }
    let identity;
    try {
      identity = registerSlot(prepared.identities, item.source_event_key, location.poi_id ? `amap:${location.poi_id}` : `address:${textHash(location.address)}`, facts.start_at);
    } catch { rejected.push({ source_event_key: item.source_event_key, reasons: ["AMBIGUOUS_OCCURRENCE_IDENTITY"] }); continue; }
    const id = identity.entry.event_id;
    const digest = textHash(document.text), mapText = JSON.stringify(location), mapDigest = textHash(mapText);
    const evidence: FieldEvidence[] = ["title", "venue_name", "start_at", "end_at", "suggested_duration_minutes", "budget_min", "budget_max"].flatMap(field => {
      const value = facts[field as keyof ActivityFacts];
      return value === null ? [] : [{ field: field as FieldEvidence["field"], source_url: document.url, quote: facts.evidence[field], document_sha256: digest }];
    });
    evidence.push({ field: "address", source_url: location.source_url, quote: location.address, document_sha256: mapDigest });
    const provenance: EventProvenance = { event_id: id, source_url: document.url, source_event_key: item.source_event_key,
      venue_key: identity.entry.venue_key, slot_key: identity.entry.slot_key, schedule_type: facts.schedule_type,
      source_kind: document.authority as EventProvenance["source_kind"], verified_at: options.asOf, city: "西安市",
      city_evidence: { source_url: document.url, quote: facts.evidence.city },
      coordinates: { system: "WGS-84", source_url: location.source_url, method: "geocoding", input_system: "GCJ-02", conversion: location.conversion },
      duration_basis: facts.suggested_duration_minutes === null ? "unknown" : "source", duration_note: facts.suggested_duration_minutes === null ? "来源未提供建议时长" : facts.evidence.suggested_duration_minutes,
      evidence };
    const event = { id, title: facts.title, description: facts.description, category: facts.category, venue_name: facts.venue_name,
      address: location.address, latitude: location.latitude, longitude: location.longitude, start_at: facts.start_at, end_at: facts.end_at,
      suggested_duration_minutes: facts.suggested_duration_minutes, budget_min: facts.budget_min, budget_max: facts.budget_max,
      currency: "CNY" as const, budget_note: facts.budget_note, guide_url: null, thumbnail_url: document.image_urls[0] ?? null, image_urls: [...document.image_urls] };
    const documents = new Map(prepared.documents);
    documents.set(digest, { url: document.url, text: document.text });
    documents.set(mapDigest, { url: location.source_url, text: mapText });
    const report = validateDataset({ ...prepared.dataset, events: [event], provenance: [provenance] }, { asOf: options.asOf, documents });
    if (!report.valid) { rejected.push({ source_event_key: item.source_event_key, reasons: report.issues.map(i => i.code) }); continue; }
    if (prepared.dataset.events.some(e => e.id === id)) { rejected.push({ source_event_key: item.source_event_key, reasons: ["DUPLICATE_ACTIVITY_IN_BATCH"] }); continue; }
    prepared.identities = identity.state;
    prepared.documents = documents;
    prepared.dataset.events.push(event); prepared.dataset.provenance.push(provenance);
    prepared.witnesses[id] = structuredClone(item);
    prepared.metadata[id] = { firstSeenAt: item.first_seen_at, lastVerifiedAt: options.asOf, sourcePublishedAt: document.published_at,
      confirmedEndDate: facts.confirmed_end_date, status: "active" };
  }
  return { prepared, rejected };
}

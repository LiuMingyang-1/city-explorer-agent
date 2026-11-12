import { extractActivities } from "./extraction.ts";
import type { ActivityFacts, ExtractionDocument, Extractor } from "./extraction.ts";
import type { GeoResult, VenueQuery } from "./geocoding.ts";
import { prepareCollection, textHash, locationQueryForFacts } from "./preparation.ts";
import type { LocatedActivity } from "./preparation.ts";
import type { SlotIdentity } from "./identity.ts";
import { createPilotApi } from "./pilot-api.ts";
import type { ApiOptions } from "./pilot-api.ts";
import { isCalendarDate } from "../itinerary/constraints.ts";

export function createDeepSeekExtractor(options: ApiOptions & { model?: string }): Extractor {
  const api = createPilotApi(options);
  return async (system, input) => {
    const response = await api.extract(options.model ?? "deepseek-flash", system, input);
    if (response?.choices?.[0]?.finish_reason !== "stop" || typeof response.choices[0].message?.content !== "string") throw new Error("INCOMPLETE_MODEL_RESPONSE");
    return response.choices[0].message.content;
  };
}

export interface PipelineDocument { document: ExtractionDocument; structured?: unknown; }
export interface ProcessingOptions {
  asOf: string; baseDate: string; invoke?: Extractor; identities?: readonly SlotIdentity[];
  /** Live clock is evaluated after awaited IO; fixed asOf is for deterministic replay. */
  now?: () => string;
  geocoder: { resolve(query: VenueQuery): Promise<GeoResult> };
  /** Collector-owned, bounded primary-source lookup. A model cannot mark its own source trusted. */
  corroborate?: (facts: ActivityFacts, original: ExtractionDocument) => Promise<ExtractionDocument | null>;
  modelBudget?: number; eventLimit?: number;
  requirePrimary?: boolean;
  /** Local OCR returns only image text; failures stay observable, never invented. */
  ocr?: (document: ExtractionDocument) => Promise<{text: string; errors?: string[]}>;
}
const canonical = (value: string) => value.normalize("NFKC").replace(/\s+/g, "");

/** Bounded orchestration. Models, source lookup and geocoding are injectable for offline
 * testing. No publication happens here; incomplete/rejected records are never returned as events.
 */
export async function processCollection(input: readonly PipelineDocument[], options: ProcessingOptions) {
  if (!isCalendarDate(options.baseDate) || !Number.isInteger(options.modelBudget ?? 10) || (options.modelBudget ?? 10) < 0 || (options.modelBudget ?? 10) > 10
    || !Number.isInteger(options.eventLimit ?? 10) || (options.eventLimit ?? 10) < 1 || (options.eventLimit ?? 10) > 10) throw new Error("INVALID_PROCESSING_OPTIONS");
  const metrics = { documents: input.length, model_calls: 0, primary_lookups: 0, location_lookups: 0, ocr_errors: [] as string[] };
  const clock = options.now ?? (() => options.asOf);
  const rejected: { source_url: string; reasons: string[] }[] = [];
  const located: LocatedActivity[] = [];
  if (input.length > 10) throw new Error("DOCUMENT_BUDGET_EXCEEDED");
  const invoke: Extractor | undefined = options.invoke ? async (...args) => {
    if (metrics.model_calls >= (options.modelBudget ?? 10)) throw new Error("MODEL_BUDGET_EXHAUSTED");
    metrics.model_calls++;
    return options.invoke!(...args);
  } : undefined;
  for (const original of input) {
    const candidate = { ...original, document: { ...original.document } };
    if (options.ocr && candidate.document.image_urls.length) {
      try {
        const result = await options.ocr(candidate.document);
        metrics.ocr_errors.push(...(result.errors ?? []));
        candidate.document.text = (candidate.document.text.slice(0, 15000) + "\n\n【图片OCR，可能存在识别错误】\n" + result.text.slice(0, 14000)).slice(0, 30000);
      } catch { metrics.ocr_errors.push("OCR_FAILED"); }
    }
    if (located.length >= (options.eventLimit ?? 10)) break;
    const result = await extractActivities(candidate.document, { asOf: clock(), structured: candidate.structured, invoke });
    if (result.issues.length) { rejected.push({ source_url: candidate.document.url, reasons: result.issues }); continue; }
    for (const extracted of result.activities) {
      extracted.check.needs_primary_source = !!options.requirePrimary && candidate.document.authority === "unverified";
      extracted.check.issues = extracted.check.issues.filter(code => !["CITY_NOT_CONFIRMED", "EVIDENCE_MISSING:city"].includes(code));
      extracted.check.valid = extracted.check.issues.length === 0;
      if (located.length >= (options.eventLimit ?? 10)) break;
      const fillable = new Set(["VALIDITY_UNKNOWN", "CITY_NOT_CONFIRMED", "FULL_TEXT_REQUIRED", ...(extracted.facts.status === "unknown" ? ["NOT_ACTIVE"] : [])]);
      const canCorroborateMissing = extracted.check.needs_primary_source && !!options.corroborate && extracted.check.issues.every(code => fillable.has(code));
      if (!extracted.check.valid && !canCorroborateMissing) { rejected.push({ source_url: candidate.document.url, reasons: extracted.check.issues }); continue; }
      let facts = extracted.facts, doc = candidate.document;
      if (extracted.check.needs_primary_source) {
        if (!options.corroborate) { rejected.push({ source_url: doc.url, reasons: ["PRIMARY_SOURCE_REQUIRED"] }); continue; }
        metrics.primary_lookups++;
        let primary: ExtractionDocument | null;
        try { primary = await options.corroborate(facts, doc); } catch { primary = null; }
        if (!primary) { rejected.push({ source_url: doc.url, reasons: ["PRIMARY_SOURCE_NOT_FOUND"] }); continue; }
        const checked = await extractActivities(primary, { asOf: clock(), invoke });
        const matches = checked.activities.filter(a => a.check.valid && !a.check.needs_primary_source
          && canonical(a.facts.title) === canonical(facts.title) && canonical(a.facts.venue_name) === canonical(facts.venue_name)
          && !(facts.start_at && a.facts.start_at && facts.start_at !== a.facts.start_at)
          && !(facts.end_at && a.facts.end_at && facts.end_at !== a.facts.end_at)
          && !(facts.address && a.facts.address && canonical(facts.address) !== canonical(a.facts.address)));
        if (matches.length !== 1) { rejected.push({ source_url: doc.url, reasons: ["PRIMARY_SOURCE_CONFLICT_OR_AMBIGUITY"] }); continue; }
        facts = matches[0].facts; doc = primary;
      }
      metrics.location_lookups++;
      let location: GeoResult;
      try {
        if (options.invoke?.locationFor) {
          const selected = options.invoke.locationFor(doc.url, facts);
          location = selected ? {ok:true,location:selected,cached:false} : {ok:false,reason:"MODEL_LOCATION_NOT_BOUND"};
        } else location = await options.geocoder.resolve(locationQueryForFacts(facts));
      }
      catch { location = { ok: false, reason: "LOCATION_LOOKUP_FAILED" }; }
      if (!location.ok) { rejected.push({ source_url: candidate.document.url, reasons: [location.reason] }); continue; }
      located.push({ facts, document: doc, location: location.location,
        source_event_key: `source:${textHash(candidate.document.url + "\n" + canonical(facts.title))}`,
        first_seen_at: candidate.document.fetched_at });
    }
  }
  const built = prepareCollection(located, { asOf: clock(), baseDate: options.baseDate, identities: options.identities });
  return { prepared: built.prepared, rejected: [...rejected, ...built.rejected], metrics };
}

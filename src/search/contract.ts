import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { isCalendarDate } from "../itinerary/constraints.ts";
import { SearchRequestError } from "./types.ts";
import type { NormalRequest } from "./types.ts";
const schema = (name: string) => JSON.parse(readFileSync(new URL(`../../docs/search-stage-0/${name}.schema.json`, import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true });
ajv.addSchema(schema("request"), "request.schema.json");
const req = ajv.getSchema("request.schema.json")!;
const res = ajv.compile(schema("response"));
export function normalizeRequest(value: unknown): NormalRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SearchRequestError();
  const copy = structuredClone(value) as Record<string, unknown>;
  for (const k of ["keyword", "category"]) if (typeof copy[k] === "string") copy[k] = copy[k].trim();
  if (Array.isArray(copy.platforms)) copy.platforms = [...new Set(copy.platforms)].sort();
  if (!req(copy) || (copy.date !== undefined && !isCalendarDate(copy.date))) throw new SearchRequestError();
  const result: Record<string, unknown> = { mode: copy.mode ?? "hybrid", limit: copy.limit ?? 20, freshness: copy.freshness ?? "cached" };
  for (const key of ["date", "category", "keyword", "platforms", "cursor"]) if (copy[key] !== undefined) result[key] = copy[key];
  if (typeof result.cursor === "string" && result.cursor.length > 200) throw new SearchRequestError("INVALID_CURSOR");
  return result as unknown as NormalRequest;
}
export function assertResponse(value: unknown): void {
  if (!res(value)) throw new Error(`INVALID_SEARCH_RESPONSE: ${ajv.errorsText(res.errors)}`);
  const r = value as { status: string; partial: boolean; next_cursor: string | null; truncated: boolean; errors: unknown[]; coverage: { status: string }[]; results: Record<string, any>[]; effective_request: unknown };
  normalizeRequest(r.effective_request);
  const valid = (ok: unknown) => { if (!ok) throw new Error("INVALID_SEARCH_RESPONSE_INVARIANT"); };
  valid(r.partial === (r.status === "partial"));
  valid(!r.next_cursor || r.truncated);
  if (r.status === "success") valid(!r.errors.length && r.coverage.some(c => c.status === "success"));
  if (r.status === "failed") valid(!r.results.length && r.errors.length && !r.coverage.some(c => c.status === "success"));
  if (r.status === "partial") valid(r.errors.length || r.coverage.some(c => c.status !== "success"));
  valid(new Set(r.results.map(x => x.result_id)).size === r.results.length);
  for (const h of r.results) {
    valid(h.city_status !== "outside");
    if (h.kind === "document") valid(!h.plannable && h.event === null && h.document_id && h.result_id === h.document_id);
    else {
      const e = h.event;
      valid(h.plannable && e && h.result_id === e.event_id && h.city_status === "confirmed");
      if ((r.effective_request as NormalRequest).date) valid(h.date_status === "confirmed");
      valid(isCalendarDate(e.start_at.slice(0,10)) && isCalendarDate(e.end_at.slice(0,10)) && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(e.start_at) && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(e.end_at) && e.start_at < e.end_at);
      valid(e.budget_min === null || e.budget_max === null || e.budget_min <= e.budget_max);
      if (!h.limitations.includes("legacy_unverified")) valid(e.source_url && e.verified_at && e.fresh_until);
    }
  }
}

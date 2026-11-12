import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { CATEGORIES } from "../data/categories.ts";
import type { CandidateEvent } from "./types.ts";

/** Runtime consumers share categories with SQLite and extraction prompts. */
export const datasetSchema = JSON.parse(readFileSync(new URL("./dataset.schema.json", import.meta.url), "utf8"));
datasetSchema.properties.events.items.properties.category.enum = [...CATEGORIES];

const candidateSchema = structuredClone(datasetSchema.properties.events.items);
for (const name of ["latitude", "longitude"]) {
  candidateSchema.properties[name].type = ["number", "null"];
}
const structural = new Ajv2020({ allErrors: true }).compile(candidateSchema);
const nullable = [
  "latitude", "longitude", "start_at", "end_at", "suggested_duration_minutes",
  "budget_min", "budget_max", "budget_note", "guide_url", "thumbnail_url",
] as const;

/** Shape validation only. Neither fact verification nor publication approval.
 * Missing optional values are materialized, without modifying the caller's object.
 */
export function normalizeCandidate(value: unknown):
  { valid: true; candidate: CandidateEvent } | { valid: false; issues: string[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, issues: ["CANDIDATE_NOT_OBJECT"] };
  }
  const normalized = structuredClone(value) as Record<string, unknown>;
  for (const name of nullable) if (!(name in normalized)) normalized[name] = null;
  if (!("currency" in normalized)) normalized.currency = "CNY";
  if (!("image_urls" in normalized)) normalized.image_urls = [];
  if (!structural(normalized)) {
    return { valid: false, issues: structural.errors!.map(e => `SCHEMA_INVALID:${e.instancePath}:${e.keyword}`) };
  }
  if ((normalized.latitude === null) !== (normalized.longitude === null)) {
    return { valid: false, issues: ["COORDINATES_MUST_BE_PAIRED"] };
  }
  for (const name of ["title", "description", "venue_name", "address"]) {
    if (!(normalized[name] as string).trim()) return { valid: false, issues: [`BLANK_FIELD:${name}`] };
  }
  return { valid: true, candidate: normalized as unknown as CandidateEvent };
}

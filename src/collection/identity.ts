import { createHash } from "node:crypto";
/** Keys describe the activity edition and physical branch, not a search ranking or array offset.
 * Corrections to a finish time, budget, description or preferred source do not change the ID.
 * slotKey is assigned once by the identity registry, NOT recomputed from corrected time.
 * For a previously registered v2 record, its original start/unscheduled key is retained.
 */
export function eventId(sourceEventKey: string, venueKey: string, slotKey: string | null): string {
 const parts=[sourceEventKey,venueKey,slotKey ?? "unscheduled"].map(s=>s.normalize("NFKC").trim());
 if(parts.some(s=>!s))throw new Error("EMPTY_EVENT_IDENTITY");
 return "xa_"+createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0,32);
}

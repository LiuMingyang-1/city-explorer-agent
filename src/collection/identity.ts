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

export interface SlotIdentity {
  source_event_key: string; venue_key: string; slot_key: string; event_id: string; aliases: string[];
}
/** Pure registry update. A single unknown occurrence may be completed, never silently
 * merged into one of several known occurrences. Registry is published with the batch.
 */
export function registerSlot(state: readonly SlotIdentity[], sourceKey: string, venueKey: string, startAt: string | null): { entry: SlotIdentity; state: SlotIdentity[] } {
  const next = structuredClone([...state]);
  const token = startAt ?? "unscheduled";
  const group = next.filter(e => e.source_event_key === sourceKey && e.venue_key === venueKey);
  const unresolved = (entry: SlotIdentity) => entry.aliases.every(a => a === "unscheduled");
  if (group.length > 1 && token === "unscheduled") throw new Error("AMBIGUOUS_OCCURRENCE_IDENTITY");
  let entry = group.find(e => e.aliases.includes(token));
  if (!entry && group.length === 1 && (token === "unscheduled" || unresolved(group[0]))) entry = group[0];
  if (!entry && group.length > 1 && group.some(unresolved)) throw new Error("AMBIGUOUS_OCCURRENCE_IDENTITY");
  if (!entry) {
    entry = { source_event_key: sourceKey, venue_key: venueKey, slot_key: token, event_id: eventId(sourceKey, venueKey, token), aliases: [token] };
    next.push(entry);
  } else if (!entry.aliases.includes(token)) entry.aliases.push(token);
  return { entry, state: next };
}

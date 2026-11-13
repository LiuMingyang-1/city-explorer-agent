import { mkdirSync, openSync, closeSync, unlinkSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { ensureEventsSchema } from "../data/schema.ts";
import { createSqliteEventRepository } from "../data/sqlite.ts";
import type { EventRepository } from "../data/repository.ts";
import type { Event } from "../data/types.ts";
import { validateDataset } from "./validate.ts";
import { assessFreshness } from "./freshness.ts";
import type { NightlyMetadata } from "./freshness.ts";
import type { PreparedCollection } from "./preparation.ts";
import { prepareCollection } from "./preparation.ts";
import type { SlotIdentity } from "./identity.ts";
import type { EventProvenance } from "./types.ts";
import type { ExtractionDocument } from "./extraction.ts";
import { publicUrl } from "./validate.ts";
import { isCalendarDate } from "../itinerary/constraints.ts";
import { deduplicateAttractions } from "./attraction-dedup.ts";
import type { AttractionDuplicate } from "./attraction-dedup.ts";
import {captureAmapAuthority,mergeAmapAuthority} from "./amap-authority.ts";
import type {AmapAuthoritySnapshot} from "./amap-authority.ts";

export interface Sidecar { schema_version: "xian-release/2"; batch_id: string; identities: SlotIdentity[]; attraction_duplicates?: AttractionDuplicate[]; events: Record<string, {
  freshness: NightlyMetadata; provenance: EventProvenance; window: { start_at: string | null; end_at: string | null; record_type?: "activity" | "attraction"; schedule_json?: import("../data/schedule.ts").Schedule | null };
  status_evidence?: { source_url: string; quote: string; verified_at: string };
  amap_authority?: AmapAuthoritySnapshot;
}>; }
const checksum = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const validBatch = (value: string) => /^[A-Za-z0-9_-]{1,80}$/.test(value);

export function inspectRelease(root: string) {
  const batch = readFileSync(join(root, "CURRENT"), "utf8").trim();
  if (!validBatch(batch)) throw new Error("INVALID_CURRENT_POINTER");
  const directory = join(root, "releases", batch);
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (manifest.schema_version !== "xian-release/2" || manifest.batch_id !== batch
    || manifest.database_sha256 !== checksum(join(directory, "events.db"))
    || manifest.sidecar_sha256 !== checksum(join(directory, "provenance.json"))) throw new Error("RELEASE_INTEGRITY_FAILED");
  const sidecar = JSON.parse(readFileSync(join(directory, "provenance.json"), "utf8")) as Sidecar;
  if (sidecar.schema_version !== "xian-release/2" || sidecar.batch_id !== batch || !sidecar.events || !Array.isArray(sidecar.identities)) throw new Error("INVALID_RELEASE_SIDECAR");
  for (const [id, row] of Object.entries(sidecar.events)) {
    if (!/^xa_[a-f0-9]{32}$/.test(id) || !row?.freshness || !row.window || row.provenance?.event_id !== id
      || !["active", "unknown", "cancelled"].includes(row.freshness.status)
      || !Number.isFinite(Date.parse(row.freshness.firstSeenAt))
      || row.freshness.lastVerifiedAt !== null && !Number.isFinite(Date.parse(row.freshness.lastVerifiedAt))) throw new Error("INVALID_RELEASE_SIDECAR");
  }
  return { directory, database: join(directory, "events.db"), sidecar, batch };
}

/** Publish immutable snapshots. All work completes before the CURRENT rename.
 * A failure leaves the old pointer intact; unreferenced partial directories are retained
 * for diagnosis. There is no seed, destructive replace, or background scheduling here.
 */
export interface CancellationNotice { event_id: string; source_event_key: string; document: ExtractionDocument; quote: string; }
export interface PublicationOptions {batchId:string;asOf:string;beforeSwitch?:()=>void;cancellations?:readonly CancellationNotice[];attractionDuplicateMeters?:number;}
/** Shared validation for both the legacy snapshot publisher and the canonical database. */
export function validatePublication(input:PreparedCollection,options:PublicationOptions){
  if (!validBatch(options.batchId)) throw new Error("INVALID_BATCH_ID");
  if (!isCalendarDate(options.asOf.slice(0, 10)) || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(options.asOf) || !Number.isFinite(Date.parse(options.asOf))) throw new Error("INVALID_PUBLICATION_CLOCK");
  if (input.dataset.events.length) {
    const report = validateDataset(input.dataset, { asOf: options.asOf, documents: input.documents });
    if (!report.valid) throw new Error("INVALID_PUBLICATION_DATASET");
  } else if (!options.cancellations?.length || input.dataset.provenance.length || input.dataset.schema_version !== "xian-events/4"
    || input.dataset.days !== 14 || !isCalendarDate(input.dataset.base_date)) throw new Error("EMPTY_OR_INVALID_PUBLICATION");
  for (const event of input.dataset.events) {
    const meta = input.metadata[event.id];
    if (!meta || !assessFreshness(event, meta, options.asOf).includeInDiscovery) throw new Error("INELIGIBLE_PUBLICATION_EVENT");
    const witness = input.witnesses?.[event.id];
    if (!witness) throw new Error("PUBLICATION_WITNESS_REQUIRED");
    const rebuilt = prepareCollection([witness], { asOf: options.asOf, baseDate: input.dataset.base_date, identities: input.identities });
    const verified = rebuilt.prepared.dataset.events[0];
    if (!verified || JSON.stringify(verified) !== JSON.stringify(event)) throw new Error("PUBLICATION_WITNESS_MISMATCH");
    const provenance = input.dataset.provenance.find(p => p.event_id === event.id)!;
    const expected = rebuilt.prepared.dataset.provenance[0];
    if (provenance.source_url !== expected.source_url || provenance.source_kind !== expected.source_kind
      || JSON.stringify(provenance.evidence) !== JSON.stringify(expected.evidence)) throw new Error("PUBLICATION_WITNESS_MISMATCH");
  }
}
/** Mutates the caller's SQLite transaction and metadata. The caller owns commit/rollback. */
export function applyPublication(db:DatabaseSync,sidecar:Sidecar,input:PreparedCollection,options:PublicationOptions){
  let written=0;const discarded:{event_id:string;reason:string}[]=[];
  sidecar.batch_id=options.batchId;
      const columns = ["id", "title", "description", "category", "venue_name", "address", "latitude", "longitude", "start_at", "end_at", "suggested_duration_minutes", "budget_min", "budget_max", "currency", "budget_note", "guide_url", "thumbnail_url", "image_urls", "record_type", "city", "amap_poi_id", "valid_from", "valid_to", "schedule_json", "time_note", "time_status", "status", "source_published_at", "source_updated_at", "fetched_at", "updated_at"] as const;
      const insert = db.prepare(`INSERT INTO events (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${columns.filter(c => c !== "id").map(c => `${c}=excluded.${c}`).join(",")}`);
        const inserted = new Set<string>();
        for (const sourceEvent of input.dataset.events) {
          const event=structuredClone(sourceEvent);
          const incoming = structuredClone(input.metadata[event.id]);
          const old = sidecar.events[event.id];
          const provenance = structuredClone(input.dataset.provenance.find(p => p.event_id === event.id)!);
          if (old) {
            // Re-fetching an article cannot extend retention or undo a cancellation.
            if (old.freshness.status === "cancelled") { discarded.push({ event_id: event.id, reason: "CANCELLED_EVENT_REQUIRES_EXPLICIT_CORRECTION" }); continue; }
            incoming.firstSeenAt = Date.parse(old.freshness.firstSeenAt) < Date.parse(incoming.firstSeenAt) ? old.freshness.firstSeenAt : incoming.firstSeenAt;
            const primaryHash = (p: EventProvenance) => p.evidence.find(e => e.source_url === p.source_url && e.field === "title")?.document_sha256;
            if (primaryHash(old.provenance) && primaryHash(old.provenance) === primaryHash(provenance)) {
              incoming.lastVerifiedAt = old.freshness.lastVerifiedAt;
              provenance.verified_at = old.provenance.verified_at;
            }
            if (!assessFreshness(event, incoming, options.asOf).includeInDiscovery) { discarded.push({ event_id: event.id, reason: "UNCHANGED_SOURCE_NEEDS_REVERIFICATION" }); continue; }
          }
          const priorAuthority=Object.values(sidecar.events).map(row=>row.amap_authority)
            .filter(row=>row?.poi_id===event.amap_poi_id&&row?.record_type===event.record_type)
            .sort((a,b)=>Date.parse(b!.checked_at)-Date.parse(a!.checked_at))[0];
          const amap_authority=mergeAmapAuthority(event,priorAuthority,captureAmapAuthority(event,input.witnesses[event.id].location));
          if(amap_authority){incoming.timeStatus=event.time_status;incoming.confirmedStartDate=event.valid_from??null;incoming.confirmedEndDate=event.valid_to??null;}
          insert.run(...columns.map(c => c === "image_urls" ? JSON.stringify(event[c]) : c === "schedule_json" ? event.schedule_json ? JSON.stringify(event.schedule_json) : null : event[c] ?? (c === "record_type" ? "activity" : c === "city" ? "西安市" : c === "time_status" ? "unknown" : c === "status" ? "unknown" : null)));
          written++;
          inserted.add(event.id);
          sidecar.events[event.id] = { freshness: incoming, provenance, window: { start_at: event.start_at, end_at: event.end_at, record_type: event.record_type, schedule_json: event.schedule_json }, ...(amap_authority?{amap_authority}:{}) };
        }
        for (const notice of options.cancellations ?? []) {
          const row = sidecar.events[notice.event_id];
          const event = db.prepare("SELECT title,venue_name FROM events WHERE id=?").get(notice.event_id);
          const age = Date.parse(options.asOf) - Date.parse(notice.document.fetched_at);
          if (!row || !event || notice.source_event_key !== row.provenance.source_event_key || !["publisher", "ticketing", "organizer_social"].includes(notice.document.authority)
            || age < 0 || age > 36 * 3600000 || !Number.isFinite(age) || !publicUrl(notice.document.url)
            || !notice.quote || notice.quote.length > 400 || !notice.document.text.includes(notice.quote)
            || !notice.quote.includes(String(event.title)) || !notice.quote.includes(String(event.venue_name))
            || !/已取消|取消举办|取消本次/.test(notice.quote)) throw new Error("INVALID_CANCELLATION_NOTICE");
          row.freshness.status = "cancelled"; row.freshness.lastVerifiedAt = options.asOf;
          row.status_evidence = { source_url: notice.document.url, quote: notice.quote, verified_at: options.asOf };
        }
        const identities = new Map(sidecar.identities.map(e => [e.event_id, e]));
        for (const entry of input.identities) identities.set(entry.event_id, structuredClone(entry));
        sidecar.identities = [...identities.values()];
        // Also compare with previous snapshots: nightly batches may discover the
        // same attraction under a different title, URL or POI identifier.
        const stored = db.prepare("SELECT * FROM events").all() as unknown as import("./types.ts").RealEvent[];
        const dedup = deduplicateAttractions(stored, options.attractionDuplicateMeters);
        for (const duplicate of dedup.duplicates) {
          db.prepare("DELETE FROM events WHERE id=?").run(duplicate.removed_id);
          delete sidecar.events[duplicate.removed_id];
          discarded.push({event_id:duplicate.removed_id,reason:"ATTRACTION_COORDINATE_DUPLICATE"});
          if (inserted.has(duplicate.removed_id)) written--;
        }
        const replacements = new Map(dedup.duplicates.map(d=>[d.removed_id,d.kept_id]));
        const audit = [...(sidecar.attraction_duplicates ?? []), ...(input.attraction_duplicates ?? []), ...dedup.duplicates]
          .map(d=>({...d,kept_id:replacements.get(d.kept_id) ?? d.kept_id}));
        sidecar.attraction_duplicates = [...new Map(audit.map(d=>[JSON.stringify([d.removed_id,d.kept_id]),d])).values()];
        if (!written && !dedup.duplicates.length && !options.cancellations?.length) throw new Error("NO_ELIGIBLE_UPDATES");
  return {written,discarded,sidecar};
}

export async function publishRelease(rootPath: string, input: PreparedCollection, options: { batchId: string; asOf: string; beforeSwitch?: () => void; cancellations?: readonly CancellationNotice[]; attractionDuplicateMeters?: number }) {
  const root = resolve(rootPath);
  validatePublication(input,options);
  mkdirSync(join(root, "releases"), { recursive: true });
  const lock = join(root, "publication.lock");
  let handle: number;
  try { handle = openSync(lock, "wx"); } catch { throw new Error("PUBLICATION_LOCKED"); }
  let pointerTemp: string | undefined;
  let written = 0;
  const discarded: { event_id: string; reason: string }[] = [];
  try {
    const previous = existsSync(join(root, "CURRENT")) ? inspectRelease(root) : undefined;
    const destination = join(root, "releases", options.batchId);
    mkdirSync(destination); // Reusing a batch name never overwrites immutable data.
    const database = join(destination, "events.db");
    if (previous) {
      const source = new DatabaseSync(previous.database, { readOnly: true });
      try { await backup(source, database); } finally { source.close(); }
    }
    const db = new DatabaseSync(database);
    const sidecar: Sidecar = previous ? structuredClone(previous.sidecar) : { schema_version: "xian-release/2", batch_id: options.batchId, identities: [], events: {} };
    sidecar.batch_id = options.batchId;
    try {
      ensureEventsSchema(db); db.exec("PRAGMA journal_mode=DELETE");
      db.exec("BEGIN IMMEDIATE");
      try {
        const update=applyPublication(db,sidecar,input,options);
        written=update.written;discarded.push(...update.discarded);
        db.exec("COMMIT");
      } catch(error){db.exec("ROLLBACK");throw error;}
      if (db.prepare("PRAGMA integrity_check").get()!.integrity_check !== "ok") throw new Error("DATABASE_INTEGRITY_FAILED");
    } finally { db.close(); }
    writeFileSync(join(destination, "provenance.json"), JSON.stringify(sidecar, null, 2) + "\n", { flag: "wx" });
    const manifest = { schema_version: "xian-release/2", batch_id: options.batchId, created_at: options.asOf,
      database_sha256: checksum(database), sidecar_sha256: checksum(join(destination, "provenance.json")), incoming_events: input.dataset.events.length, written_events: written, discarded };
    writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    options.beforeSwitch?.();
    // Recheck files after any preparation hook, before exposing them to readers.
    if (checksum(database) !== manifest.database_sha256 || checksum(join(destination, "provenance.json")) !== manifest.sidecar_sha256) throw new Error("RELEASE_INTEGRITY_FAILED");
    pointerTemp = join(root, `CURRENT-${options.batchId}.tmp`);
    writeFileSync(pointerTemp, options.batchId + "\n", { flag: "wx" });
    renameSync(pointerTemp, join(root, "CURRENT")); pointerTemp = undefined;
    return manifest;
  } finally {
    if (pointerTemp && existsSync(pointerTemp)) unlinkSync(pointerTemp);
    closeSync(handle); unlinkSync(lock);
  }
}

/** Optional reader for published collections; does not change the application's default
 * data/events.db. Availability is evaluated BEFORE the SQL result limit.
 */
export function createReleasedRepository(root: string, now: () => string): EventRepository & { getStatus(id: string): ReturnType<typeof assessFreshness> | undefined } {
  type State = { release: ReturnType<typeof inspectRelease>; repository: EventRepository; users: number; retired: boolean };
  let active: State | undefined;
  let closed = false;
  const states = new Set<State>();
  const releaseIfIdle = (state: State) => { if (state.retired && !state.users) { state.repository.close(); states.delete(state); } };
  const load = () => {
    if (closed) throw new Error("REPOSITORY_CLOSED");
    const batch = readFileSync(join(root, "CURRENT"), "utf8").trim();
    if (active?.release.batch === batch) return active;
    // A corrupt new batch never replaces a successfully opened previous reader.
    let release;
    try { release = inspectRelease(root); } catch (error) { if (active) return active; throw error; }
    const availability = (id: string) => {
      const row = release.sidecar.events[id];
      return !!row && !!row.window && assessFreshness(row.window, row.freshness, now()).includeInDiscovery;
    };
    const repository = createSqliteEventRepository(release.database, { readOnly: true, isAvailable: availability });
    if (active) { active.retired = true; releaseIfIdle(active); }
    active = { release, repository, users: 0, retired: false }; states.add(active);
    return active;
  };
  const use = async <T>(operation: (state: State) => Promise<T>): Promise<T> => {
    const state = load(); state.users++;
    try { return await operation(state); } finally { state.users--; releaseIfIdle(state); }
  };
  const decision = (event: Event, row: Sidecar["events"][string]) => assessFreshness({ start_at: event.startAt, end_at: event.endAt, record_type: event.recordType, schedule_json: event.schedule }, row.freshness, now());
  return {
    search(input) {
      return use(async current => (await current.repository.search(input)).filter(event => {
        const row = current.release.sidecar.events[event.id];
        return row && decision(event, row).includeInDiscovery;
      }));
    },
    getByIds(ids) { return use(current => current.repository.getByIds(ids)); },
    getStatus(id) {
      const row = load().release.sidecar.events[id];
      return row ? assessFreshness(row.window, row.freshness, now()) : undefined;
    },
    close() { closed = true; for (const state of states) { state.retired = true; releaseIfIdle(state); } active = undefined; },
  };
}

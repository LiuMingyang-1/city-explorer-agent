import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ensureSearchSchema } from "./schema.ts";
import { SearchRequestError } from "./types.ts";
import type { CollectedHit, NormalRequest } from "./types.ts";
import type { SearchRepository, StoredHit, Snapshot } from "./repository.ts";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();
type Run = {id: string; scope_key: string; request_key: string; response_json: string | null; snapshot_until: string; cursor_state_json: string};
export function createSearchRepository(path: string, options: { now?: () => number; id?: () => string; token?: () => string } = {}): SearchRepository {
 const db = new DatabaseSync(path), now = options.now ?? Date.now, id = options.id ?? randomUUID, token = options.token ?? (() => randomBytes(32).toString("hex"));
 try { ensureSearchSchema(db); } catch(e) { db.close(); throw e; }
 let closed = false;
 const budget = (at: number) => { if (at <= now()) throw new Error("STORAGE_DEADLINE"); db.exec(`PRAGMA busy_timeout = ${Math.max(0,Math.min(1000,Math.floor(at-now())))}`); };
 const transaction = <T>(fn: () => T): T => { db.exec("BEGIN IMMEDIATE"); try { const r=fn(); db.exec("COMMIT"); return r; } catch(e) { db.exec("ROLLBACK"); throw e; } };
 const get = (runId: string, scope: string, key: string, at: number): Run => {
   const r=db.prepare("SELECT * FROM search_runs WHERE id=? AND scope_key=? AND request_key=?").get(runId,scope,key) as Run | undefined;
   if (!r?.response_json || !r.snapshot_until || Date.parse(r.snapshot_until)<=at) throw new SearchRequestError("INVALID_CURSOR");
   return r;
 };
 return {
 beginRun(runId, scope, request, key, at, until) { budget(until); db.prepare("INSERT INTO search_runs(id,scope_key,request_json,request_key,mode,status,expires_at,started_at) VALUES (?,?,?,?,?,'running',?,?)").run(runId,scope,JSON.stringify(request),key,request.mode,iso(at+7*86400000),iso(at)); },
 completeRun(runId, hits, at, until, build) { budget(until); return transaction(() => {
   const stored: StoredHit[]=[]; let conflicts=0;
   for (const item of hits) {
     const h=item.hit;
     const byUrl=db.prepare("SELECT id,platform,platform_content_id FROM search_documents WHERE canonical_url=?").get(h.url) as {id:string;platform:string;platform_content_id:string|null}|undefined;
     const byId=h.platformContentId ? db.prepare("SELECT id FROM search_documents WHERE platform=? AND platform_content_id=?").get(h.platform,h.platformContentId) as {id:string}|undefined : undefined;
     if (byId && byUrl && byId.id!==byUrl.id || byUrl && (byUrl.platform!==h.platform || byUrl.platform_content_id && h.platformContentId && byUrl.platform_content_id!==h.platformContentId)) { conflicts++; continue; }
     const docId=byId?.id ?? byUrl?.id ?? id();
     if (byId || byUrl) db.prepare("UPDATE search_documents SET title=?,author=?,snippet=?,last_fetched_at=?,platform_content_id=COALESCE(platform_content_id,?) WHERE id=?").run(h.title,h.author,h.snippet,iso(at),h.platformContentId,docId);
     else db.prepare("INSERT INTO search_documents(id,platform,platform_content_id,canonical_url,title,author,snippet,published_at,first_seen_at,last_fetched_at,fetch_status) VALUES (?,?,?,?,?,?,?,?,?,?,'snippet_only')").run(docId,h.platform,h.platformContentId,h.url,h.title,h.author,h.snippet,h.publishedAt,iso(at),iso(at));
     db.prepare("INSERT INTO search_run_results(id,run_id,document_id,channel,matched_query,channel_rank,snippet) VALUES (?,?,?,?,?,?,?) ON CONFLICT(run_id,document_id,channel,matched_query) DO UPDATE SET channel_rank=min(channel_rank,excluded.channel_rank)").run(id(),runId,docId,item.channel,item.query,h.rank,h.snippet);
     stored.push({...item,documentId:docId});
   }
   const snapshot=build(stored,conflicts);
   for (let n=0;n<snapshot.response.results.length;n++) db.prepare("UPDATE search_run_results SET final_rank=? WHERE run_id=? AND document_id=?").run(n+1,runId,snapshot.response.results[n].document_id);
   if (now()>=until) throw new Error("STORAGE_DEADLINE");
   const result=db.prepare("UPDATE search_runs SET status=?,response_json=?,channel_results_json=?,snapshot_until=?,finished_at=? WHERE id=? AND status='running'").run(snapshot.response.status,JSON.stringify(snapshot),JSON.stringify(snapshot.response.coverage),iso(at+1800000),iso(at),runId);
   if (result.changes!==1) throw new Error("INVALID_RUN_STATE");
   return snapshot;
 }); },
 failRun(runId,status,at) { db.exec("PRAGMA busy_timeout = 0"); db.prepare("UPDATE search_runs SET status=?,finished_at=? WHERE id=? AND status='running'").run(status,iso(at),runId); },
 getSnapshot(runId,scope,key,at,until) { budget(until); return JSON.parse(get(runId,scope,key,at).response_json!) as Snapshot; },
 issueCursor(runId,scope,offset,at,until) { budget(until); return transaction(() => {
   const r=db.prepare("SELECT * FROM search_runs WHERE id=? AND scope_key=?").get(runId,scope) as Run | undefined;
   if (!r?.response_json || Date.parse(r.snapshot_until)<=at) throw new SearchRequestError("INVALID_CURSOR");
   const state=JSON.parse(r.cursor_state_json) as Record<string,number>;
   if(Object.keys(state).length>=128) throw new SearchRequestError("CURSOR_LIMIT");
   const raw=token(); state[hash(raw)]=offset;
   db.prepare("UPDATE search_runs SET cursor_state_json=? WHERE id=?").run(JSON.stringify(state),runId);
   return `${runId}.${raw}`;
 }); },
 resolveCursor(value,scope,key,at,until) { budget(until); const dot=value.indexOf('.'); if(dot<1) throw new SearchRequestError("INVALID_CURSOR");
   const r=get(value.slice(0,dot),scope,key,at), state=JSON.parse(r.cursor_state_json) as Record<string,number>;
   const offset=state[hash(value.slice(dot+1))]; if(!Number.isInteger(offset)) throw new SearchRequestError("INVALID_CURSOR");
   return {snapshot:JSON.parse(r.response_json!) as Snapshot,offset};
 },
 cleanup(at) { transaction(() => { db.prepare("DELETE FROM search_runs WHERE expires_at<=?").run(iso(at));
   // Future evidence tables may hold references: do not clean documents once those tables exist.
   if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='activity_evidence'").get()) db.prepare("DELETE FROM search_documents WHERE last_fetched_at<? AND NOT EXISTS(SELECT 1 FROM search_run_results r WHERE r.document_id=search_documents.id)").run(iso(at-30*86400000));
 }); },
 close() { if(!closed) { closed=true; db.close(); } }
 };
}

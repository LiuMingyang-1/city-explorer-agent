import {existsSync,mkdirSync,openSync,closeSync,unlinkSync} from "node:fs";
import {resolve,relative,isAbsolute,dirname} from "node:path";
import {randomUUID} from "node:crypto";
import {DatabaseSync,backup} from "node:sqlite";
import {ensureEventsSchema} from "../data/schema.ts";
import {inspectRelease,validatePublication,applyPublication} from "./releases.ts";
import type {Sidecar,PublicationOptions} from "./releases.ts";
import type {PreparedCollection} from "./preparation.ts";
import {parseSchedule} from "../data/schedule.ts";

export interface TimeCorrection {
  id:string;
  expected:{guide_url:string|null;schedule_json:string|null;time_note:string|null;time_status:string};
  remove_exception_dates:string[];
  clear_last_entry_paths:string[];
  clear_schedule?:boolean;
  downgrade_time_status?:"partial"|"unknown"|"conflicting"|null;
  reason:string;
}

/** Production has one authoritative database. Private paths support isolated tests. */
export function collectionDatabasePath(value="data/events.db"):string {
  const path=resolve(value),child=relative(resolve(".local-data"),path);
  if(path!==resolve("data/events.db")&&(!child||child.startsWith("..")||isAbsolute(child)||!path.endsWith(".db")))throw new Error("INVALID_COLLECTION_DATABASE_PATH");
  return path;
}
const META="_collection_metadata";
function createMeta(db:DatabaseSync){db.exec(`CREATE TABLE IF NOT EXISTS ${META} (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)))`);}
function put(db:DatabaseSync,key:string,value:unknown){db.prepare(`INSERT INTO ${META}(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key,JSON.stringify(value));}
function get(db:DatabaseSync,key:string):any {const row=db.prepare(`SELECT value FROM ${META} WHERE key=?`).get(key);return row?JSON.parse(String(row.value)):undefined;}
function readState(db:DatabaseSync){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(META))throw new Error("COLLECTION_DATABASE_NOT_INITIALIZED");
  const sidecar=get(db,"state") as Sidecar,databaseId=get(db,"database_id") as string;
  if(sidecar?.schema_version!=="xian-release/2"||!sidecar.events||!Array.isArray(sidecar.identities)||typeof databaseId!=="string")throw new Error("INVALID_COLLECTION_DATABASE_METADATA");
  const ids=db.prepare("SELECT id FROM events ORDER BY id").all().map(r=>String(r.id));
  if(JSON.stringify(ids)!==JSON.stringify(Object.keys(sidecar.events).sort()))throw new Error("COLLECTION_DATABASE_METADATA_OUT_OF_SYNC");
  return {sidecar,databaseId};
}
function lockFile(database:string){
  mkdirSync(dirname(database),{recursive:true});const path=database+".collection-write.lock";
  let fd:number;try{fd=openSync(path,"wx");}catch{throw new Error("COLLECTION_DATABASE_LOCKED");}
  return ()=>{closeSync(fd);unlinkSync(path);};
}
export function inspectCollectionDatabase(path:string){
  const database=collectionDatabasePath(path),db=new DatabaseSync(database,{readOnly:true});
  try{const state=readState(db);return {database,database_id:state.databaseId,sidecar:state.sidecar,batch:state.sidecar.batch_id,records:Number(db.prepare("SELECT count(*) n FROM events").get()!.n)};}finally{db.close();}
}

/** One-time migration copies the previously validated real dataset. No old rows are deleted. */
export async function initializeCollectionDatabase(path:string,legacyRoot?:string){
  const database=collectionDatabasePath(path),unlock=lockFile(database);
  try{
    if(existsSync(database)){
      const db=new DatabaseSync(database);
      try{
        if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(META))return inspectCollectionDatabase(database);
        if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get())throw new Error("EXISTING_DATABASE_REQUIRES_EXPLICIT_MIGRATION");
      }finally{db.close();}
    }
    const legacy=legacyRoot&&existsSync(resolve(legacyRoot,"CURRENT"))?inspectRelease(legacyRoot):undefined;
    if(legacy){const source=new DatabaseSync(legacy.database,{readOnly:true});try{await backup(source,database);}finally{source.close();}}
    const db=new DatabaseSync(database);
    try{
      ensureEventsSchema(db);db.exec("PRAGMA busy_timeout=5000");db.exec("BEGIN IMMEDIATE");
      try{
        createMeta(db);
        const state:Sidecar=legacy?structuredClone(legacy.sidecar):{schema_version:"xian-release/2",batch_id:"initialized",events:{},identities:[]};
        const ids=db.prepare("SELECT id FROM events").all().map(r=>String(r.id)).sort();
        if(JSON.stringify(ids)!==JSON.stringify(Object.keys(state.events).sort()))throw new Error("MIGRATION_PROVENANCE_MISMATCH");
        put(db,"database_id",randomUUID());put(db,"state",state);
        put(db,"initialization",{source:legacy?.database??null,records:ids.length,created_at:new Date().toISOString()});
        if(db.prepare("PRAGMA integrity_check").get()!.integrity_check!=="ok")throw new Error("DATABASE_INTEGRITY_FAILED");
        db.exec("COMMIT");
      }catch(error){db.exec("ROLLBACK");throw error;}
    }finally{db.close();}
    return inspectCollectionDatabase(database);
  }finally{unlock();}
}

/** Updates the SAME file in one transaction, including all provenance and receipts. */
export function writeCollectionDatabase(path:string,input:PreparedCollection,options:PublicationOptions&{beforeCommit?:()=>void}){
  validatePublication(input,options);
  const database=collectionDatabasePath(path),unlock=lockFile(database);let db:DatabaseSync|undefined;
  try{
    db=new DatabaseSync(database);
    ensureEventsSchema(db);db.exec("PRAGMA busy_timeout=5000");db.exec("BEGIN IMMEDIATE");
    try{
      const {sidecar,databaseId}=readState(db);
      if(get(db,"batch:"+options.batchId))throw new Error("DUPLICATE_DATABASE_BATCH");
      const before=Number(db.prepare("SELECT count(*) n FROM events").get()!.n);
      const result=applyPublication(db,sidecar,input,options);
      const after=Number(db.prepare("SELECT count(*) n FROM events").get()!.n);
      const receipt={schema_version:"xian-database-batch/1",database,database_id:databaseId,batch_id:options.batchId,created_at:options.asOf,records_before:before,records_after:after,incoming_events:input.dataset.events.length,written_events:result.written,discarded:result.discarded};
      put(db,"state",result.sidecar);put(db,"batch:"+options.batchId,receipt);
      readState(db);
      if(db.prepare("PRAGMA integrity_check").get()!.integrity_check!=="ok")throw new Error("DATABASE_INTEGRITY_FAILED");
      options.beforeCommit?.();db.exec("COMMIT");return receipt;
    }catch(error){db.exec("ROLLBACK");throw error;}
  }finally{db?.close();unlock();}
}

/** Cached-source audit can only remove unsupported timing assertions, never add facts.
 * Compare the exact reviewed version, retain provenance freshness, and journal before/after.
 */
export function correctCollectionTimes(path:string,corrections:readonly TimeCorrection[],options:{batchId:string;asOf:string;beforeCommit?:()=>void}){
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(options.batchId)||!Number.isFinite(Date.parse(options.asOf))||!corrections.length||new Set(corrections.map(c=>c.id)).size!==corrections.length)throw new Error("INVALID_TIME_CORRECTION");
  const database=collectionDatabasePath(path),unlock=lockFile(database);let db:DatabaseSync|undefined;
  try{
    db=new DatabaseSync(database);db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    try{
      const {sidecar,databaseId}=readState(db);
      if(get(db,"batch:"+options.batchId))throw new Error("DUPLICATE_DATABASE_BATCH");
      const changes=[];
      for(const correction of corrections){
        if(!correction.reason?.trim()||correction.reason.length>1000)throw new Error("INVALID_TIME_CORRECTION");
        const row=db.prepare("SELECT * FROM events WHERE id=?").get(correction.id);
        if(!row||row.record_type!=="attraction"||Object.entries(correction.expected).some(([key,value])=>row[key]!==value)||Object.keys(correction.expected).sort().join()!=="guide_url,schedule_json,time_note,time_status")throw new Error("STALE_TIME_CORRECTION");
        let schedule=parseSchedule(row.schedule_json as string|null);
        if(!schedule)throw new Error("INVALID_TIME_CORRECTION");
        const before={schedule_json:row.schedule_json,time_note:row.time_note,time_status:row.time_status};
        for(const date of correction.remove_exception_dates){
          if(!schedule.exceptions?.some(e=>e.date===date))throw new Error("INVALID_TIME_CORRECTION_DATE");
          schedule.exceptions=schedule.exceptions.filter(e=>e.date!==date);
        }
        for(const path of correction.clear_last_entry_paths){
          const match=/^(weekly|dates|exceptions)\.(\d+)\.windows\.(\d+)(?:\.last_entry)?$/.exec(path);
          if(!match)throw new Error("INVALID_TIME_CORRECTION_PATH");
          const list=schedule[match[1] as "weekly"|"dates"|"exceptions"];
          const window=list?.[Number(match[2])]?.windows?.[Number(match[3])];
          if(!window?.last_entry)throw new Error("INVALID_TIME_CORRECTION_PATH");
          delete window.last_entry;
        }
        const timeStatus=correction.downgrade_time_status??String(row.time_status);
        if(!["complete","partial","unknown","conflicting"].includes(timeStatus)||correction.downgrade_time_status&&(correction.downgrade_time_status as string)==="complete"||row.time_status==="unknown"&&timeStatus!=="unknown"||row.time_status==="conflicting"&&!["unknown","conflicting"].includes(timeStatus))throw new Error("TIME_CORRECTION_CANNOT_UPGRADE");
        if(correction.clear_schedule){
          if(!["unknown","conflicting"].includes(timeStatus))throw new Error("TIME_CORRECTION_STATUS_REQUIRED");
          schedule=null;
        }
        if(JSON.stringify(schedule)===row.schedule_json&&timeStatus===row.time_status)throw new Error("EMPTY_TIME_CORRECTION");
        const note=`${row.time_note??""}\n时间审计修正：${correction.reason}`;
        if(note.length>2000)throw new Error("TIME_CORRECTION_NOTE_TOO_LONG");
        parseSchedule(schedule);
        const stored=schedule?JSON.stringify(schedule):null;
        db.prepare("UPDATE events SET schedule_json=?,time_note=?,time_status=?,updated_at=? WHERE id=?").run(stored,note,timeStatus,options.asOf,correction.id);
        sidecar.events[correction.id].window.schedule_json=schedule;
        sidecar.events[correction.id].freshness.timeStatus=timeStatus as "complete"|"partial"|"unknown"|"conflicting";
        changes.push({id:correction.id,source_url:row.guide_url,reason:correction.reason,before,after:{schedule_json:stored,time_note:note,time_status:timeStatus}});
      }
      const receipt={kind:"cached-source-time-correction",database,database_id:databaseId,batch_id:options.batchId,created_at:options.asOf,changes};
      put(db,"state",sidecar);put(db,"batch:"+options.batchId,receipt);readState(db);
      options.beforeCommit?.();db.exec("COMMIT");return receipt;
    }catch(error){db.exec("ROLLBACK");throw error;}
  }finally{db?.close();unlock();}
}

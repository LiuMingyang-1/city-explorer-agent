import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdirSync,rmSync,statSync,existsSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {spawnSync} from "node:child_process";
import {join,resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {initializeCollectionDatabase,inspectCollectionDatabase,writeCollectionDatabase,collectionDatabasePath,correctCollectionTimes} from "../src/collection/database.ts";
import {locatedFixture} from "./collection-downstream-fixture.ts";
import {prepareCollection} from "../src/collection/preparation.ts";
import {publishRelease} from "../src/collection/releases.ts";
function folder(){const root=`.local-data/canonical-test-${randomUUID()}`;mkdirSync(root,{recursive:true});return {root,path:join(root,"events.db"),clean:()=>rmSync(root,{recursive:true,force:true})};}
async function prepared(key:string,type:"activity"|"attraction"="activity"){
  const {item,asOf}=await locatedFixture();item.source_event_key=key;
  if(type==="attraction"){item.facts.record_type=type;item.facts.category="等级未知";}
  const p=prepareCollection([item],{asOf,baseDate:"2026-11-12"});assert.equal(p.prepared.dataset.events.length,1,JSON.stringify(p.rejected));return {...p,asOf};
}
test("two writes keep the same file and database identity and retain the earlier activity",async()=>{
  const f=folder();try{
    const initial=await initializeCollectionDatabase(f.path),inode=statSync(f.path).ino;
    const a=await prepared("canonical:a"),b=await prepared("canonical:b");
    const first=writeCollectionDatabase(f.path,a.prepared,{batchId:"first",asOf:a.asOf});
    const second=writeCollectionDatabase(f.path,b.prepared,{batchId:"second",asOf:b.asOf});
    assert.equal(first.database,second.database);assert.equal(first.database_id,initial.database_id);assert.equal(second.database_id,initial.database_id);assert.equal(statSync(f.path).ino,inode);
    assert.equal(first.records_after,1);assert.equal(second.records_before,1);assert.equal(second.records_after,2);
    const current=inspectCollectionDatabase(f.path);assert.equal(Object.keys(current.sidecar.events).length,2);
    const db=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(db.prepare("SELECT count(*) n FROM events").get()!.n,2);assert.equal(db.prepare("SELECT count(*) n FROM _collection_metadata WHERE key LIKE 'batch:%'").get()!.n,2);assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check,"ok");}finally{db.close();}
    assert(!existsSync(join(f.root,"releases")));
  }finally{f.clean();}
});
test("one-time migration retains legacy records and is never repeated over later changes",async()=>{
  const f=folder();try{
    const legacy=join(f.root,"legacy"),a=await prepared("legacy:a");await publishRelease(legacy,a.prepared,{batchId:"original",asOf:a.asOf});
    const first=await initializeCollectionDatabase(f.path,legacy);assert.equal(first.records,1);assert(first.sidecar.events[a.prepared.dataset.events[0].id]);
    const b=await prepared("canonical:new");writeCollectionDatabase(f.path,b.prepared,{batchId:"added",asOf:b.asOf});
    const again=await initializeCollectionDatabase(f.path,legacy);assert.equal(again.records,2);assert.equal(again.database_id,first.database_id);
  }finally{f.clean();}
});
test("failed transactions roll back events, metadata and receipts together",async()=>{
  const f=folder();try{
    await initializeCollectionDatabase(f.path);const a=await prepared("atomic:a"),b=await prepared("atomic:b");writeCollectionDatabase(f.path,a.prepared,{batchId:"first",asOf:a.asOf});const before=inspectCollectionDatabase(f.path);
    assert.throws(()=>writeCollectionDatabase(f.path,b.prepared,{batchId:"failed",asOf:b.asOf,beforeCommit:()=>{assert.equal(inspectCollectionDatabase(f.path).records,1);throw new Error("injected");}}),/injected/);
    assert.deepEqual(inspectCollectionDatabase(f.path),before);assert(!existsSync(f.path+".collection-write.lock"));
    const db=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(db.prepare("SELECT value FROM _collection_metadata WHERE key='batch:failed'").get(),undefined);}finally{db.close();}
  }finally{f.clean();}
});
test("stale write locks are reclaimed and a live holder still fails fast",async()=>{
  const f=folder();try{
    await initializeCollectionDatabase(f.path);const a=await prepared("lock:a"),lock=resolve(f.path+".collection-write.lock");
    const held=new DatabaseSync(lock);held.exec("BEGIN IMMEDIATE");
    assert.throws(()=>writeCollectionDatabase(f.path,a.prepared,{batchId:"blocked",asOf:a.asOf}),/COLLECTION_DATABASE_LOCKED/);
    held.exec("ROLLBACK");held.close();
    // A holder killed with SIGKILL leaves the file behind, but the OS released the lock.
    spawnSync(process.execPath,["--input-type=module","-e",`import{DatabaseSync}from"node:sqlite";const d=new DatabaseSync(${JSON.stringify(lock)});d.exec("BEGIN IMMEDIATE");setInterval(()=>{},1e9)`],{killSignal:"SIGKILL",timeout:3000});
    assert(existsSync(lock));
    const receipt=writeCollectionDatabase(f.path,a.prepared,{batchId:"reclaimed",asOf:a.asOf});assert.equal(receipt.records_after,1);assert(!existsSync(lock));
  }finally{f.clean();}
});
test("cross-run attraction coordinate dedup updates the same file and provenance",async()=>{
  const f=folder();try{
    await initializeCollectionDatabase(f.path);const a=await prepared("point:a","attraction"),b=await prepared("point:b","attraction");
    writeCollectionDatabase(f.path,a.prepared,{batchId:"a",asOf:a.asOf});writeCollectionDatabase(f.path,b.prepared,{batchId:"b",asOf:b.asOf});
    const current=inspectCollectionDatabase(f.path);assert.equal(current.records,1);assert.equal(Object.keys(current.sidecar.events).length,1);assert(current.sidecar.attraction_duplicates!.length>0);
  }finally{f.clean();}
});
test("unknown existing databases and duplicate batch names are rejected without overwriting",async()=>{
  const f=folder();try{
    const old=new DatabaseSync(f.path);old.exec("CREATE TABLE other(value TEXT); INSERT INTO other VALUES('keep')");old.close();
    await assert.rejects(initializeCollectionDatabase(f.path),/EXPLICIT_MIGRATION/);
    const db=new DatabaseSync(f.path,{readOnly:true});try{assert.equal(db.prepare("SELECT value FROM other").get()!.value,"keep");}finally{db.close();}
    const safe=join(f.root,"other.db");await initializeCollectionDatabase(safe);const a=await prepared("same");writeCollectionDatabase(safe,a.prepared,{batchId:"one",asOf:a.asOf});
    assert.throws(()=>writeCollectionDatabase(safe,a.prepared,{batchId:"one",asOf:a.asOf}),/DUPLICATE_DATABASE_BATCH/);assert.equal(inspectCollectionDatabase(safe).records,1);
  }finally{f.clean();}
});
test("database paths cannot silently target sessions or unrelated files",()=>{
  assert(collectionDatabasePath().endsWith("events.db"));assert.throws(()=>collectionDatabasePath("data/sessions.db"));assert.throws(()=>collectionDatabasePath("../events.db"));
});

test("time audit removes unsupported dates and ticket cutoffs while retaining IDs, coordinates and freshness",async()=>{
  const f=folder();try{
    await initializeCollectionDatabase(f.path);const a=await prepared("audit:a","attraction");writeCollectionDatabase(f.path,a.prepared,{batchId:"a",asOf:a.asOf});
    const id=a.prepared.dataset.events[0].id,db=new DatabaseSync(f.path);
    const schedule={timezone:"Asia/Shanghai",mode:"weekly",weekly:[{weekdays:[1,2,3,4,5,6,7],windows:[{start:"09:00",end:"18:00",last_entry:"17:00"}]}],exceptions:[{date:"2026-11-13",closed:true}]};
    db.prepare("UPDATE events SET schedule_json=?,time_note='17:00停止售票',time_status='complete' WHERE id=?").run(JSON.stringify(schedule),id);
    const row=db.prepare("SELECT * FROM events WHERE id=?").get(id)!;db.close();
    const state=inspectCollectionDatabase(f.path),meta=structuredClone(state.sidecar.events[id]);
    const expected={guide_url:row.guide_url as string,schedule_json:row.schedule_json as string,time_note:row.time_note as string,time_status:String(row.time_status)};
    const correction={id,expected,remove_exception_dates:["2026-11-13"],clear_last_entry_paths:["weekly.0.windows.0"],reason:"删除示例日期；停止售票不等于停止入场。"};
    assert.throws(()=>correctCollectionTimes(f.path,[correction],{batchId:"fail",asOf:a.asOf,beforeCommit:()=>{throw Error("injected");}}),/injected/);
    assert.deepEqual(inspectCollectionDatabase(f.path),state);
    const receipt=correctCollectionTimes(f.path,[correction],{batchId:"audit",asOf:a.asOf});assert.equal(receipt.changes.length,1);
    const after=inspectCollectionDatabase(f.path);assert.equal(after.database_id,state.database_id);assert.equal(after.records,1);assert.deepEqual(after.sidecar.events[id].freshness,{...meta.freshness,timeStatus:"complete"});assert.deepEqual(after.sidecar.events[id].provenance,meta.provenance);
    const check=new DatabaseSync(f.path,{readOnly:true});const updated=check.prepare("SELECT * FROM events WHERE id=?").get(id)!;check.close();
    for(const key of ["id","title","latitude","longitude","guide_url","fetched_at","time_status"])assert.equal(updated[key],row[key]);
    const fixed=JSON.parse(String(updated.schedule_json));assert.equal(fixed.exceptions.length,0);assert.equal(fixed.weekly[0].windows[0].last_entry,undefined);assert.equal(fixed.weekly[0].windows[0].end,"18:00");assert.deepEqual(after.sidecar.events[id].window.schedule_json,fixed);
    assert.throws(()=>correctCollectionTimes(f.path,[correction],{batchId:"stale",asOf:a.asOf}),/STALE_TIME_CORRECTION/);
  }finally{f.clean();}
});

test("time audit rejects paths that could change opening hours or create new dates",async()=>{
  const f=folder();try{
    await initializeCollectionDatabase(f.path);const a=await prepared("audit:invalid","attraction");writeCollectionDatabase(f.path,a.prepared,{batchId:"a",asOf:a.asOf});
    const db=new DatabaseSync(f.path),id=a.prepared.dataset.events[0].id;
    db.prepare("UPDATE events SET schedule_json=?,time_status='complete' WHERE id=?").run(JSON.stringify({timezone:"Asia/Shanghai",mode:"always_open"}),id);const row=db.prepare("SELECT * FROM events WHERE id=?").get(id)!;db.close();
    const correction={id,expected:{guide_url:row.guide_url as string,schedule_json:row.schedule_json as string,time_note:row.time_note as string|null,time_status:String(row.time_status)},reason:"test",remove_exception_dates:[],clear_last_entry_paths:["weekly.0.windows.0.start"]};
    assert.throws(()=>correctCollectionTimes(f.path,[correction],{batchId:"invalid",asOf:a.asOf}),/INVALID_TIME_CORRECTION_PATH/);
    assert.throws(()=>correctCollectionTimes(f.path,[{...correction,clear_last_entry_paths:[],remove_exception_dates:["2027-01-01"]}],{batchId:"invalid2",asOf:a.asOf}),/INVALID_TIME_CORRECTION_DATE/);
    assert.throws(()=>correctCollectionTimes(f.path,[{...correction,clear_last_entry_paths:[],clear_schedule:true}],{batchId:"invalid3",asOf:a.asOf}),/TIME_CORRECTION_STATUS_REQUIRED/);
    const check=new DatabaseSync(f.path,{readOnly:true});assert.equal(check.prepare("SELECT schedule_json FROM events WHERE id=?").get(id)!.schedule_json,row.schedule_json);check.close();
    correctCollectionTimes(f.path,[{...correction,clear_last_entry_paths:[],clear_schedule:true,downgrade_time_status:"unknown"}],{batchId:"clear",asOf:a.asOf});
    assert.equal(inspectCollectionDatabase(f.path).sidecar.events[id].window.schedule_json,null);
    assert.equal(inspectCollectionDatabase(f.path).sidecar.events[id].freshness.timeStatus,"unknown");
  }finally{f.clean();}
});

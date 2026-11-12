import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ensureEventsSchema,EVENTS_TABLE_DDL} from "../src/data/schema.ts";
import {createSqliteEventRepository} from "../src/data/sqlite.ts";
import {validateItinerary} from "../src/itinerary/validation.ts";
import {makeEvent,eventsOf,DAY} from "./validation-fixtures.ts";
const insert=`INSERT INTO events(id,title,description,category,venue_name,address,latitude,longitude,start_at,end_at,suggested_duration_minutes) VALUES ('e','t','d','展览','v','西安市',34.2,108.9,NULL,NULL,NULL)`;
test("fresh events schema permits paired nullable coordinates and retains 18 columns",()=>{
 const db=new DatabaseSync(":memory:");try{ensureEventsSchema(db);db.exec(insert);const cols=db.prepare("PRAGMA table_info(events)").all();assert.equal(cols.length,18);for(const k of ["start_at","end_at","suggested_duration_minutes"])assert.equal(cols.find(c=>c.name===k)!.notnull,0);assert.throws(()=>db.exec("UPDATE events SET latitude=NULL"));db.exec("UPDATE events SET latitude=NULL,longitude=NULL");for(const k of ["latitude","longitude","start_at","end_at","suggested_duration_minutes"])assert.equal(cols.find(c=>c.name===k)!.dflt_value,"NULL");}finally{db.close();}
});
test("legacy NOT NULL migration preserves rows, extra columns, index, trigger and inbound references",()=>{
 const db=new DatabaseSync(":memory:");try{
  const legacy=EVENTS_TABLE_DDL.replace("start_at TEXT","start_at TEXT NOT NULL").replace("end_at TEXT","end_at TEXT NOT NULL").replace("suggested_duration_minutes INTEGER","suggested_duration_minutes INTEGER NOT NULL");db.exec(legacy);
  db.exec(`ALTER TABLE events ADD COLUMN custom_note TEXT; CREATE INDEX custom_event_title ON events(title); CREATE TABLE audit(value TEXT); CREATE TRIGGER event_audit AFTER UPDATE ON events BEGIN INSERT INTO audit VALUES(new.id); END; PRAGMA foreign_keys=ON; CREATE TABLE refs(event_id TEXT REFERENCES events(id));`);
  db.exec(insert.replace("NULL,NULL,NULL","'2026-11-14T10:00','2026-11-14T17:00',90"));db.exec("UPDATE events SET custom_note='keep'; INSERT INTO refs VALUES('e')");ensureEventsSchema(db);ensureEventsSchema(db);
  db.exec("UPDATE events SET start_at=NULL,end_at=NULL,suggested_duration_minutes=NULL");assert.equal(db.prepare("SELECT custom_note FROM events").get()!.custom_note,"keep");assert.equal(db.prepare("SELECT count(*) n FROM audit").get()!.n,2);assert(db.prepare("SELECT 1 FROM sqlite_master WHERE name='custom_event_title'").get());assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys,1);assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
 }finally{db.close();}
});
test("migration rollback preserves old schema and original foreign key setting",()=>{
 const db=new DatabaseSync(":memory:");try{db.exec(EVENTS_TABLE_DDL.replace("start_at TEXT","start_at TEXT NOT NULL"));db.exec("CREATE TABLE events__nullable_migration(x); PRAGMA foreign_keys=ON");assert.throws(()=>ensureEventsSchema(db),/temporary table/);assert.equal(db.prepare("PRAGMA table_info(events)").all().find(c=>c.name==="start_at")!.notnull,1);assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys,1);}finally{db.close();}
});
test("unknown times round-trip, date-specific search excludes them, nearby discovery keeps them",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"events-nullable-")),path=join(dir,"events.db");let repo:ReturnType<typeof createSqliteEventRepository>|undefined;
 try{const db=new DatabaseSync(path);ensureEventsSchema(db);db.exec(insert);db.close();repo=createSqliteEventRepository(path);assert.equal((await repo.getByIds(["e"])).get("e")!.startAt,null);assert.equal((await repo.search({date:"2026-11-14"})).length,0);assert.equal((await repo.search({near:{lat:34.2,lng:108.9},radiusKm:1}))[0].distanceKm,0);}finally{repo?.close();rmSync(dir,{recursive:true,force:true});}
});
test("planner rejects unknown windows without crashing; unknown suggested duration alone is allowed",()=>{
 const candidate={date:DAY,summary:"s",stops:[{event_id:"evt_a",arrive_at:"13:00",leave_at:"14:00",reason:"r"}]};
 for(const values of [{startAt:null},{endAt:null},{startAt:null,endAt:null}]){const event=makeEvent({id:"evt_a",...values});assert(validateItinerary(candidate,{date:DAY},eventsOf(event)).issues.some(i=>i.code==="unknown_event_window"));}
 assert.equal(validateItinerary(candidate,{date:DAY},eventsOf(makeEvent({id:"evt_a",suggestedDurationMinutes:null}))).ok,true);
});

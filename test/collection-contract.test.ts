import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { eventId } from "../src/collection/identity.ts";
import { publicUrl,validateDataset } from "../src/collection/validate.ts";
import { collectionFixture } from "./collection-fixture.ts";
import type { RealDataset } from "../src/collection/types.ts";

test("valid publication contract includes stats and does not mutate inputs",()=>{
 const {dataset,options}=collectionFixture(),before=JSON.stringify(dataset);const report=validateDataset(dataset,options);
 assert.equal(report.valid,true,JSON.stringify(report.issues));assert.equal(report.stats.slots,1);assert.equal(report.stats.projects,1);assert.equal(report.stats.venues,1);assert.equal(JSON.stringify(dataset),before);
});
const invalid:[string,(d:RealDataset)=>void,string][]=[
 ["empty dataset",d=>{d.events=[];d.provenance=[];},"SCHEMA_INVALID"],
 ["fake calendar day",d=>{d.events[0].start_at="2026-02-30T10:00";},"INVALID_SLOT"],
 ["invalid clock",d=>{d.events[0].end_at="2026-11-14T25:00";},"INVALID_SLOT"],
 ["reversed slot",d=>{d.events[0].end_at="2026-11-14T09:00";},"INVALID_SLOT"],
 ["multi-day blanket opening",d=>{d.events[0].end_at="2026-11-16T17:00";},"INVALID_SLOT"],
 ["outside delivery horizon",d=>{d.events[0].start_at="2026-12-01T10:00";d.events[0].end_at="2026-12-01T17:00";},"OUTSIDE_BATCH"],
 ["unknown coordinates",d=>{(d.events[0] as any).latitude=null;},"SCHEMA_INVALID"],
 ["Shanghai coordinate",d=>{d.events[0].latitude=31.2;d.events[0].longitude=121.4;},"COORDINATE_OUTSIDE_COARSE_REGION"],
 ["swapped axes",d=>{d.events[0].latitude=108.95;d.events[0].longitude=34.23;},"SCHEMA_INVALID"],
 ["missing source",d=>{d.provenance[0].source_url="";},"SCHEMA_INVALID"],
 ["wrong expense order",d=>{d.events[0].budget_min=2000;d.events[0].budget_max=1000;},"INVALID_BUDGET_RANGE"],
 ["fractional currency",d=>{d.events[0].budget_min=20.5;},"SCHEMA_INVALID"],
 ["wrong category",d=>{(d.events[0] as any).category="看展";},"SCHEMA_INVALID"],
 ["blank name",d=>{d.events[0].title="   ";},"BLANK_FIELD"],
 ["mock content",d=>{d.events[0].description="模拟数据，非真实活动";},"SYNTHETIC_CONTENT"],
 ["missing provenance",d=>{d.provenance=[];},"SCHEMA_INVALID"],
 ["wrong ID association",d=>{d.provenance[0].event_id="missing";},"MISSING_PROVENANCE"],
 ["unconfirmed city",d=>{d.provenance[0].city_evidence.quote="陕西省";},"CITY_NOT_CONFIRMED"],
 ["missing conversion",d=>{d.provenance[0].coordinates.input_system="GCJ-02";},"COORDINATE_CONVERSION_MISSING"],
 ["stale verification",d=>{d.provenance[0].verified_at="2026-11-01T00:00:00Z";},"INVALID_VERIFICATION_TIME"],
 ["future verification",d=>{d.provenance[0].verified_at="2026-11-15T00:00:00Z";},"INVALID_VERIFICATION_TIME"],
 ["fixed show with guessed duration",d=>{d.provenance[0].schedule_type="fixed";},"FIXED_DURATION_UNCONFIRMED"],
 ["duplicate slot",d=>{d.events.push(structuredClone(d.events[0]));},"DUPLICATE_SLOT"],
 ["ID based on list position",d=>{d.events[0].id="xa_"+"0".repeat(32);d.provenance[0].event_id=d.events[0].id;},"UNSTABLE_ID"],
 ["source URL mismatch",d=>{d.events[0].guide_url="https://www.sxhm.com/guide";},"SOURCE_URL_MISMATCH"],
 ["embedded fake credential",d=>{d.events[0].description="sk-"+"x".repeat(32);},"POSSIBLE_SECRET"],
];
for(const [name,mutate,code] of invalid)test(`publication rejects ${name}`,()=>{
 const {dataset,options}=collectionFixture();mutate(dataset);const r=validateDataset(dataset,options);assert.equal(r.valid,false);assert(r.issues.some(i=>i.code===code),JSON.stringify(r.issues));
});
test("evidence text must match the retained content hash",()=>{
 const {dataset,options}=collectionFixture();for(const doc of options.documents.values())doc.text+="改动";assert(validateDataset(dataset,options).issues.some(i=>i.code==="EVIDENCE_NOT_FOUND"));
});
test("fixed show requires actual duration and duration evidence",()=>{
 const {dataset,options}=collectionFixture();dataset.events[0].end_at="2026-11-14T11:30";dataset.provenance[0].schedule_type="fixed";dataset.provenance[0].duration_basis="source";dataset.provenance[0].evidence.push({...dataset.provenance[0].evidence[0],field:"suggested_duration_minutes"});assert.equal(validateDataset(dataset,options).valid,true);
});
test("stable ID is independent of finish, price, description and input ordering",()=>{
 const {dataset,options}=collectionFixture();const before=dataset.events[0].id;dataset.events[0].end_at="2026-11-14T16:00";dataset.events[0].description="修订介绍";assert.equal(validateDataset(dataset,options).valid,true);assert.equal(dataset.events[0].id,before);
 assert.notEqual(eventId("other-edition","venue:branch-a","2026-11-14T10:00"),before);
 assert.notEqual(eventId("publisher:edition-2026-11","other-branch","2026-11-14T10:00"),before);
});
test("public URL rejects credentials, private targets, test hosts and API tokens",()=>{
 for(const url of ["http://localhost/x","http://127.0.0.1/x","http://[::1]/x","https://user:password@museum.cn/","https://museum.cn/?api_key=secret","https://example.com/a","javascript:alert(1)"])assert.equal(publicUrl(url),false,url);
 assert.equal(publicUrl("https://www.sxhm.com/notice?id=123"),true);
});
test("delivery DDL retains 18 fields with nullable paired coordinates",()=>{
 const db=new DatabaseSync(":memory:");try{db.exec(readFileSync(new URL("../docs/real-events-stage-a/events-delivery.sql",import.meta.url),"utf8"));
 const columns=db.prepare("PRAGMA table_info(events)").all();assert.equal(columns.length,18);assert(columns.some(c=>c.name==="guide_url"));assert(!columns.some(c=>c.name==="source_url"));
 for(const name of ["start_at","end_at","suggested_duration_minutes"])assert.equal(columns.find(c=>c.name===name)!.notnull,0);
 for(const name of ["latitude","longitude"])assert.equal(columns.find(c=>c.name===name)!.notnull,0);
 assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name),["events"]);
 }finally{db.close();}
});

test("real datasets may retain unknown times and duration but still require coordinates and sources",()=>{
 const {dataset,options}=collectionFixture();const e=dataset.events[0],p=dataset.provenance[0];e.start_at=null;e.end_at=null;e.suggested_duration_minutes=null;p.duration_basis="unknown";e.id=eventId(p.source_event_key,p.venue_key,null);p.event_id=e.id;p.slot_key="unscheduled";p.evidence=p.evidence.filter(v=>!["start_at","end_at"].includes(v.field));
 const report=validateDataset(dataset,options);assert.equal(report.valid,true,JSON.stringify(report.issues));assert.equal(report.stats.dates.unknown,1);
 (e as any).longitude=null;assert.equal(validateDataset(dataset,options).valid,false);
});

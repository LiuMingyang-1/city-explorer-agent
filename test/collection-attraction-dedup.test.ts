import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {coordinateDistanceMeters,deduplicateAttractions} from "../src/collection/attraction-dedup.ts";
import {prepareCollection} from "../src/collection/preparation.ts";
import {publishRelease,inspectRelease} from "../src/collection/releases.ts";
import {locatedFixture} from "./collection-downstream-fixture.ts";

const point=(id:string,lat=34.25,lng=108.95)=>({id,record_type:"attraction",latitude:lat,longitude:lng,guide_url:`https://www.sxhm.com/${id}`});

test("nearby attractions merge without requiring equal names or POI IDs, and keep the complete original",()=>{
  const a={...point("a"),title:"校园",amap_poi_id:"poi-a"},b={...point("b",34.25004,108.95004),title:"校园秋景",amap_poi_id:"poi-b",time_status:"complete",schedule_json:{mode:"weekly"}};
  const original=structuredClone([a,b]);const result=deduplicateAttractions([a,b]);
  assert.equal(result.records.length,1);assert.equal(result.records[0],b);
  assert.equal(result.duplicates[0].kept_id,"b");assert.equal(result.duplicates[0].removed_id,"a");
  assert(result.duplicates[0].distance_meters>0&&result.duplicates[0].distance_meters<10);
  assert.deepEqual(result.duplicates[0].source_urls,[b.guide_url,a.guide_url]);assert.deepEqual([a,b],original);
});

test("activities at the same location remain separate from attractions and each other",()=>{
  const rows=[point("a"),{...point("show1"),record_type:"activity"},{...point("show2"),record_type:"activity"}];
  assert.equal(deduplicateAttractions(rows).records.length,3);
});

test("distance boundary is inclusive and the threshold is configurable, not decimal rounding",()=>{
  const a=point("a"),b=point("b",34.2501);const distance=coordinateDistanceMeters(a,b);
  assert.equal(deduplicateAttractions([a,b]).records.length,2);
  assert.equal(deduplicateAttractions([a,b],distance).records.length,1);
  assert.equal(deduplicateAttractions([a,b],distance-.001).records.length,2);
  assert.equal(deduplicateAttractions([a,{...a,id:"c"}],0).records.length,1);
  for(const v of [-1,101,NaN,Infinity])assert.throws(()=>deduplicateAttractions([],v),/INVALID_ATTRACTION/);
});

test("a chain of nearby points cannot merge points farther than the representative threshold",()=>{
  const result=deduplicateAttractions([point("a"),point("b",34.25007),point("c",34.25014)]);
  assert.deepEqual(result.records.map(p=>p.id),["a","c"]);
});

test("invalid or missing coordinates are never equated to zero or used for proximity matching",()=>{
  const rows=[point("a"),{...point("b"),latitude:null},{...point("c"),latitude:NaN},{...point("d"),longitude:Infinity}];
  assert.equal(deduplicateAttractions(rows).records.length,4);
});

test("batch dedup removes orphan witnesses and provenance but retains a source audit",async()=>{
  const {item,asOf}=await locatedFixture();item.facts.record_type="attraction";item.facts.category="暂无评级";
  const other=structuredClone(item);other.source_event_key="another-source";other.document.url="https://www.sxhm.com/another-source";other.facts.time_status="complete";
  const result=prepareCollection([item,other],{asOf,baseDate:"2026-11-12"});
  assert.deepEqual(result.rejected,[]);assert.equal(result.prepared.dataset.events.length,1);
  const id=result.prepared.dataset.events[0].id;
  assert.deepEqual(Object.keys(result.prepared.metadata),[id]);assert.deepEqual(Object.keys(result.prepared.witnesses),[id]);
  assert.equal(result.prepared.dataset.provenance.length,1);assert.equal(result.prepared.attraction_duplicates?.length,1);
});

test("publication deduplicates across nightly batches and records every merged source",async()=>{
  const folder=mkdtempSync(join(tmpdir(),"attraction-dedup-"));
  try{
    const {item,asOf}=await locatedFixture();item.facts.record_type="attraction";item.facts.category="暂无评级";
    const first=prepareCollection([item],{asOf,baseDate:"2026-11-12"}).prepared;
    await publishRelease(folder,first,{batchId:"one",asOf});
    const other=structuredClone(item);other.source_event_key="richer-source";other.document.url="https://www.sxhm.com/richer-source";other.facts.time_status="complete";
    const second=prepareCollection([other],{asOf,baseDate:"2026-11-12"}).prepared;
    await publishRelease(folder,second,{batchId:"two",asOf});
    const release=inspectRelease(folder);const db=new DatabaseSync(release.database,{readOnly:true});
    try{const rows=db.prepare("SELECT id,guide_url FROM events").all();assert.equal(rows.length,1);assert.equal(rows[0].guide_url,other.document.url);assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check,"ok");}finally{db.close();}
    assert.equal(Object.keys(release.sidecar.events).length,1);
    assert.equal(release.sidecar.attraction_duplicates?.length,1);
    assert.deepEqual(new Set(release.sidecar.attraction_duplicates![0].source_urls),new Set([item.document.url,other.document.url]));
    // Re-collecting a merged source does not create a second published row.
    await publishRelease(folder,first,{batchId:"three",asOf});
    assert.equal(Object.keys(inspectRelease(folder).sidecar.events).length,1);
  }finally{rmSync(folder,{recursive:true,force:true});}
});

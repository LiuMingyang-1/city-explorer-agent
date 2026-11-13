import{test}from"node:test";import assert from"node:assert/strict";
import{mkdirSync,rmSync,readFileSync,existsSync}from"node:fs";import{randomUUID,createHash}from"node:crypto";import{DatabaseSync}from"node:sqlite";
import{locatedFixture}from"./collection-downstream-fixture.ts";import{prepareCollection}from"../src/collection/preparation.ts";
import{initializeCollectionDatabase,writeCollectionDatabase,inspectCollectionDatabase}from"../src/collection/database.ts";
import{planAmapSupplement,applyAmapSupplement}from"../src/collection/amap-supplement.ts";
test("AMap supplement preserves activities, journals changes and rolls back on failure",async()=>{
  const root=`.local-data/amap-supplement-test-${randomUUID()}`,path=root+"/events.db";mkdirSync(root,{recursive:true});
  try{
    const {item,asOf}=await locatedFixture();await initializeCollectionDatabase(path);
    const attraction=structuredClone(item);attraction.facts.record_type="attraction";attraction.facts.category="等级未知";attraction.source_event_key="attraction";
    const p=prepareCollection([item,attraction],{asOf,baseDate:"2026-11-12"});assert.equal(p.prepared.dataset.events.length,2);
    writeCollectionDatabase(path,p.prepared,{batchId:"seed",asOf});
    const db=new DatabaseSync(path,{readOnly:true});const rows=db.prepare("SELECT * FROM events ORDER BY id").all();db.close();
    const hash=()=>createHash("sha256").update(readFileSync(path)).digest("hex");const before=hash();
    const raw={id:item.location.poi_id,name:"文化展厅",location:"108.95,34.23",pname:"陕西省",cityname:"西安市",adname:"雁塔区",address:"高德新址",business:{keytag:"4A景区",opentime_week:"周一至周日 09:00-17:00",cost:"99"},photos:[{url:"http://store.is.autonavi.com/test"}]};
    const plan=planAmapSupplement({baseline:{sha256:before,rows},pois:[raw],hours:{},images:{"https://store.is.autonavi.com/test":{ok:true,url:"https://store.is.autonavi.com/test"}},asOf});
    assert.equal(plan.updates[0].after.category,"4A");assert.equal(plan.updates[0].after.budget_min,2000);assert.equal(plan.updates[0].after.time_status,"complete");
    assert.throws(()=>applyAmapSupplement(path,plan,{batchId:"failed",beforeCommit:()=>{throw Error("injected");}}),/injected/);assert.equal(hash(),before);assert(!existsSync(path+".task.lock"));
    const result=applyAmapSupplement(path,plan,{batchId:"enriched"});assert.equal(result.records,1);
    const check=new DatabaseSync(path,{readOnly:true});try{
      assert.deepEqual({...check.prepare("SELECT * FROM events WHERE record_type='activity'").get()},{...rows.find(r=>r.record_type==="activity")});
      const saved=inspectCollectionDatabase(path);assert.equal(saved.records,2);assert(saved.sidecar.events[plan.updates[0].before.id].amap_authority);
      assert(check.prepare("SELECT 1 FROM _collection_metadata WHERE key='batch:enriched'").get());
    }finally{check.close();}
    assert.throws(()=>applyAmapSupplement(path,plan,{batchId:"stale"}),/BASELINE_CHANGED/);
    const weaker=prepareCollection([attraction],{asOf,baseDate:"2026-11-12"});
    writeCollectionDatabase(path,weaker.prepared,{batchId:"weaker-post",asOf});
    const later=new DatabaseSync(path,{readOnly:true});try{
      const row=later.prepare("SELECT * FROM events WHERE record_type='attraction'").get()!;
      assert.equal(row.category,"4A");assert.equal(row.address,"陕西省西安市雁塔区高德新址");assert.equal(row.time_status,"complete");
      assert.equal(row.start_at,null);assert.equal(row.end_at,null);assert.equal(row.guide_url,item.document.url);
      const state=inspectCollectionDatabase(path).sidecar.events[String(row.id)];assert.equal(state.freshness.confirmedEndDate,null);assert.equal(state.window.schedule_json!.mode,"weekly");
    }finally{later.close();}
    const otherPost=structuredClone(attraction);otherPost.source_event_key="another-source-for-same-poi";
    const newSource=prepareCollection([otherPost],{asOf,baseDate:"2026-11-12"});
    writeCollectionDatabase(path,newSource.prepared,{batchId:"another-source",asOf});
    const merged=new DatabaseSync(path,{readOnly:true});try{
      const attractions=merged.prepare("SELECT * FROM events WHERE record_type='attraction'").all();assert.equal(attractions.length,1);assert.equal(attractions[0].category,"4A");assert.equal(attractions[0].address,"陕西省西安市雁塔区高德新址");
    }finally{merged.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});

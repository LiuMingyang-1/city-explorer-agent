import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createToolAnalysisExtractor, createAmapSearch } from "../src/collection/analysis-model.ts";
import { extractActivities } from "../src/collection/extraction.ts";
import { processCollection } from "../src/collection/pipeline.ts";
import { ensureEventsSchema } from "../src/data/schema.ts";
import { availabilityOnDate } from "../src/data/schedule.ts";
import { assessFreshness } from "../src/collection/freshness.ts";
import { extractionFixture } from "./collection-downstream-fixture.ts";

test("invalid schedules and dates fall back to original time notes without losing the object", async () => {
  const {facts,document,asOf} = extractionFixture();
  const result = await extractActivities(document,{asOf,structured:{activities:[{...facts,start_at:null,end_at:null,confirmed_start_date:null,confirmed_end_date:null,valid_from:"2026-02-30",schedule_json:{mode:"weekly",weekly:"invalid"}}]}});
  assert.equal(result.activities[0].check.valid,true);
  assert.equal(result.activities[0].facts.schedule_json,null);
  assert.equal(result.activities[0].facts.valid_from,null);
  assert.match(result.activities[0].facts.time_note!,/2026-02-30/);
  assert.match(result.activities[0].facts.time_note!,/invalid/);
});

test("time conflicts retain an attraction but do not expose guessed planning windows", async () => {
  const {facts,document,asOf} = extractionFixture();
  const result=await extractActivities(document,{asOf,structured:{activities:[{...facts,record_type:"attraction",category:"等级未知",conflicts:["开放时间08:00或08:30不一致"]}]}});
  const f=result.activities[0].facts;
  assert.equal(result.activities[0].check.valid,true);
  assert.equal(f.time_status,"conflicting");assert.equal(f.start_at,null);
  assert.equal(availabilityOnDate({recordType:"attraction",timeStatus:f.time_status,schedule:f.schedule_json},"2026-11-14").state,"unknown");
});

test("old undated attractions and activities survive extraction, explicit expired activities still fail", async () => {
  const {facts,document,asOf}=extractionFixture();document.published_at="2025-01-01T00:00:00Z";
  const missing={...facts,start_at:null,end_at:null,confirmed_start_date:null,confirmed_end_date:null,status:"unknown"};
  const result=await extractActivities(document,{asOf,structured:{activities:[missing]}});
  assert.equal(result.activities[0].check.valid,true);
  const expired=await extractActivities(document,{asOf,structured:{activities:[{...missing,valid_to:"2026-11-01"}]}});
  assert(expired.activities[0].check.issues.includes("ALREADY_ENDED"));
});

test("new fields migrate idempotently and constrain time_status without discarding old rows",()=>{
  const db=new DatabaseSync(":memory:");
  try{ensureEventsSchema(db);db.exec("INSERT INTO events(id,title,description,category,venue_name,address) VALUES('a','展','介绍','展览','展厅','西安市')");ensureEventsSchema(db);
    assert.deepEqual({...db.prepare("SELECT time_note,time_status FROM events").get()},{time_note:null,time_status:"unknown"});
    assert.throws(()=>db.exec("UPDATE events SET time_status='invented'"));
  }finally{db.close();}
});

test("tool analysis combines OCR with text, chooses the parent mall and binds exact returned coordinates",async()=>{
  const {facts,document,asOf}=extractionFixture();document.image_urls=["https://sns-webpic-qc.xhscdn.com/image"];
  let rounds=0,sawOcr=false;
  const selected={id:"mall",name:"西安荟聚",address:"西安市雁塔区西部大道",adcode:"610113",district:"雁塔区",latitude:34.17116,longitude:108.900077};
  const model=createToolAnalysisExtractor({deepseekKey:"test",record:()=>{},now:()=>asOf,extractLimit:4,map:{search:async()=>[selected]},fetch:async(_url,init)=>{
    const request=JSON.parse(String(init?.body));sawOcr=JSON.stringify(request.messages).includes("图片场馆：西安荟聚雁南中厅");
    if(rounds++===0)return Response.json({choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:"call1",type:"function",function:{name:"amap_search",arguments:JSON.stringify({keywords:"西安荟聚"})}}]}}]});
    return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({activities:[{...facts,venue_name:"西安荟聚·雁南中厅",address:selected.address,amap_poi_id:selected.id,latitude:selected.latitude,longitude:selected.longitude}]})}}]});
  }});
  const result=await processCollection([{document}],{asOf,baseDate:"2026-11-12",invoke:model,geocoder:{resolve:async()=>{throw new Error("mechanical matching must not run");}},ocr:async()=>({text:"图片场馆：西安荟聚雁南中厅"})});
  assert(sawOcr);assert.equal(result.prepared.dataset.events.length,1,JSON.stringify(result.rejected));
  const event=result.prepared.dataset.events[0];assert.equal(event.longitude,selected.longitude);assert.equal(event.amap_poi_id,"mall");
  assert.equal(model.locationFor!(document.url,{...facts,amap_poi_id:"mall",latitude:0,longitude:0}),null);
  assert.equal(model.locationFor!("https://www.sxhm.com/another",{...facts,amap_poi_id:"mall",latitude:selected.latitude,longitude:selected.longitude}),null);
});

test("tool loop is bounded rather than issuing unlimited model requests",async()=>{
  const {document}=extractionFixture();let count=0;
  const model=createToolAnalysisExtractor({deepseekKey:"test",record:()=>{},maxRounds:2,map:{search:async()=>[]},fetch:async()=>{count++;return Response.json({choices:[{finish_reason:"tool_calls",message:{tool_calls:[{id:`c${count}`,function:{name:"amap_search",arguments:'{"keywords":"展厅"}'}}]}}]});}});
  await assert.rejects(()=>model("system",{text:document.text,source_url:document.url,schema:{} as any}),/ROUND_BUDGET/);assert.equal(count,2);
});

test("map search keeps fuzzy candidate names for model choice and filters out other cities",async()=>{
  const map=createAmapSearch({key:"test",fetch:async()=>Response.json({status:"1",infocode:"10000",pois:[{id:"mall",name:"西安荟聚",address:"西部大道",adcode:"610113",adname:"雁塔区",cityname:"西安市",location:"108.9,34.17"},{id:"other",name:"西安荟聚",address:"某路",adcode:"310100",cityname:"上海市",location:"121.4,31.2"}]})});
  const rows=await map.search("荟聚雁南中厅");assert.equal(rows.length,1);assert.equal(rows[0].id,"mall");
});

test("partial time remains discoverable without passing the automatic planning gate",()=>{
  const result=assessFreshness({start_at:null,end_at:null},{timeStatus:"partial",recordType:"activity",firstSeenAt:"2026-11-12T00:00:00Z",lastVerifiedAt:"2026-11-12T01:00:00Z",sourcePublishedAt:"2025-01-01T00:00:00Z",confirmedEndDate:null,status:"unknown"},"2026-11-12T02:00:00Z");
  assert.equal(result.includeInDiscovery,true);assert.equal(result.allowPlanning,false);
});

test("all explicit dates expired is different from a partial series with a future date",async()=>{
  const {facts,document,asOf}=extractionFixture();
  const candidate={...facts,start_at:null,end_at:null,confirmed_start_date:null,confirmed_end_date:null,schedule_json:{timezone:"Asia/Shanghai",mode:"dates",dates:[{date:"2026-11-10",windows:[{start:"10:00",end:"11:00"}]}]}};
  const expired=await extractActivities(document,{asOf,structured:{activities:[candidate]}});
  assert(expired.activities[0].check.issues.includes("ALREADY_ENDED"));
  candidate.schedule_json.dates.push({date:"2026-11-14",windows:[{start:"10:00",end:"11:00"}]});
  const upcoming=await extractActivities(document,{asOf,structured:{activities:[candidate]}});
  assert.equal(upcoming.activities[0].check.valid,true);
});

test("a model's explicit uncertainty is not promoted to confirmed opening hours",async()=>{
  const {facts,document,asOf}=extractionFixture();
  const result=await extractActivities(document,{asOf,structured:{activities:[{...facts,time_status:"unknown",time_note:"旧攻略时间尚未确认"}]}});
  assert.equal(result.activities[0].facts.time_status,"unknown");
});

test("the last tool round forces final JSON so an unmatched venue still produces reviewable facts",async()=>{
  const {document}=extractionFixture();let calls=0;
  const model=createToolAnalysisExtractor({deepseekKey:"test",record:()=>{},maxRounds:2,map:{search:async()=>[]},fetch:async(_url,init)=>{
    const body=JSON.parse(String(init?.body));calls++;
    if(calls===1)return Response.json({choices:[{finish_reason:"tool_calls",message:{tool_calls:[{id:"c",function:{name:"amap_search",arguments:'{"keywords":"未知场馆"}'}}]}}]});
    assert.equal(body.tool_choice,"none");assert.deepEqual(body.response_format,{type:"json_object"});
    return Response.json({choices:[{finish_reason:"stop",message:{content:'{"activities":[]}'}}]});
  }});
  assert.equal(await model("system",{text:document.text,source_url:document.url,schema:{} as any}),'{"activities":[]}');assert.equal(calls,2);
});

test("unresolved map tool failures surface as execution failures, empty results stay a model rejection",async()=>{
  const {facts,document,asOf}=extractionFixture();
  const run=async(map:{search(keywords:string):Promise<any[]>})=>{
    let calls=0;
    const model=createToolAnalysisExtractor({deepseekKey:"test",record:()=>{},now:()=>asOf,map,fetch:async()=>{
      if(calls++===0)return Response.json({choices:[{finish_reason:"tool_calls",message:{tool_calls:[{id:"c",function:{name:"amap_search",arguments:'{"keywords":"西安荟聚"}'}}]}}]});
      return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({activities:[{...facts,amap_poi_id:null,latitude:null,longitude:null}]})}}]});
    }});
    const result=await processCollection([{document}],{asOf,baseDate:"2026-11-12",invoke:model,geocoder:{resolve:async()=>{throw new Error("mechanical matching must not run");}}});
    return {model,result};
  };
  const failed=await run({search:async()=>{throw new Error("MAP_RATE_LIMITED");}});
  assert.equal(failed.result.prepared.dataset.events.length,0);
  assert.deepEqual(failed.model.locationFailuresFor!(document.url),["MAP_RATE_LIMITED"]);
  assert(failed.result.rejected.some(r=>r.reasons.includes("LOCATION_LOOKUP_FAILED")),JSON.stringify(failed.result.rejected));
  const empty=await run({search:async()=>[]});
  assert.deepEqual(empty.model.locationFailuresFor!(document.url),[]);
  assert(empty.result.rejected.some(r=>r.reasons.includes("MODEL_LOCATION_NOT_BOUND")),JSON.stringify(empty.result.rejected));
});

test("a map retry that later binds still publishes despite an earlier recorded failure",async()=>{
  const {facts,document,asOf}=extractionFixture();let calls=0,searches=0;
  const selected={id:"mall",name:"西安荟聚",address:"西安市雁塔区西部大道",adcode:"610113",district:"雁塔区",latitude:34.17116,longitude:108.900077};
  const model=createToolAnalysisExtractor({deepseekKey:"test",record:()=>{},now:()=>asOf,map:{search:async()=>{if(searches++===0)throw new Error("MAP_RATE_LIMITED");return[selected];}},fetch:async()=>{
    if(calls++<2)return Response.json({choices:[{finish_reason:"tool_calls",message:{tool_calls:[{id:`c${calls}`,function:{name:"amap_search",arguments:JSON.stringify({keywords:`尝试${calls}`})}}]}}]});
    return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({activities:[{...facts,venue_name:"西安荟聚·雁南中厅",address:selected.address,amap_poi_id:selected.id,latitude:selected.latitude,longitude:selected.longitude}]})}}]});
  }});
  const result=await processCollection([{document}],{asOf,baseDate:"2026-11-12",invoke:model,geocoder:{resolve:async()=>{throw new Error("mechanical matching must not run");}}});
  assert.equal(result.prepared.dataset.events.length,1,JSON.stringify(result.rejected));
  assert.deepEqual(model.locationFailuresFor!(document.url),["MAP_RATE_LIMITED"]);
});

test("conflicting exhibition dates are kept in notes instead of selecting an arbitrary end date",async()=>{
  const {facts,document,asOf}=extractionFixture();
  const result=await extractActivities(document,{asOf,structured:{activities:[{...facts,valid_from:"2026-11-14",valid_to:"2026-12-13",conflicts:["展期结束日：正文12月13日，海报12月6日"]}]}});
  const f=result.activities[0].facts;assert.equal(f.valid_to,null);assert.equal(f.confirmed_end_date,null);
  assert.equal(result.activities[0].check.valid,true);assert.match(f.time_note!,/12月6日/);
});

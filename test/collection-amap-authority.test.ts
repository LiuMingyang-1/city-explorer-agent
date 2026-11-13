import {test} from "node:test";
import assert from "node:assert/strict";
import {amapDetails,amapGrade,amapImageUrl,subjectProblem,applyAmapAuthority,normalizeAmapHours,simpleAmapHours,mergeAmapAuthority,captureAmapAuthority} from "../src/collection/amap-authority.ts";
import {extractionFixture} from "./collection-downstream-fixture.ts";
const details=()=>amapDetails({business:{keytag:"4A景区",rating:"4.9",opentime_week:"周二至周日09:00-17:00（16:30停止入馆）"},photos:[{url:"http://store.is.autonavi.com/showpic/a"}]},"2026-11-13T01:00:00Z");
test("AMap grade is explicit A-level, not rating; image hosts are bounded",()=>{
  assert.equal(amapGrade(details()),"4A");assert.equal(amapGrade(amapDetails({business:{rating:"5.0",keytag:"公园"}},"now")),null);
  assert.equal(amapImageUrl("http://store.is.autonavi.com/showpic/a"),"https://store.is.autonavi.com/showpic/a");
  for(const url of ["https://amap.com.evil.test/a","http://127.0.0.1/a","https://x:secret@store.is.autonavi.com/a"])assert.equal(amapImageUrl(url),null);
});

test("simple full weekly expressions avoid model calls; ambiguous text is left intact",()=>{
  assert.equal(simpleAmapHours("周一至周日 00:00-24:00")!.time_status,"complete");
  assert.equal(simpleAmapHours("周二至周六 09:00-17:00 最晚进入16:30")!.schedule_json!.weekly![0].windows[0].last_entry,"16:30");
  for(const s of ["周一至周日 09:00-17:00；春节休息","夏季周一至周日 09:00-17:00","周一至周日 09:00-99:00"])assert.equal(simpleAmapHours(s),null);
});
test("trusted map snapshots protect fields from weaker later posts but never cross entities",()=>{
  const event={record_type:"attraction",amap_poi_id:"p",address:"地图地址",venue_name:"馆",latitude:34,longitude:109,category:"4A",image_urls:["a"],thumbnail_url:"a",schedule_json:null,time_status:"unknown",time_note:"原文"};
  const old=captureAmapAuthority(event,{poi_id:"p",source_url:"map",amap:details()})!;
  const weak={...event,address:"帖子地址",category:"5A"};mergeAmapAuthority(weak,old);assert.equal(weak.address,"地图地址");assert.equal(weak.category,"4A");
  const other={...weak,amap_poi_id:"other",address:"另一家"};assert.equal(mergeAmapAuthority(other,old),undefined);assert.equal(other.address,"另一家");
  const changed={...event,address:"高德新址"},fresh=captureAmapAuthority(changed,{poi_id:"p",source_url:"map",amap:{...details(),fetched_at:"2026-11-14T01:00:00Z"}})!;
  mergeAmapAuthority(weak,old,fresh);assert.equal(weak.address,"高德新址");
});
test("selected AMap facts win over conflicting attraction source fields",()=>{
  const {facts}=extractionFixture();facts.record_type="attraction";facts.category="5A";facts.conflicts=["开放时间冲突","地址冲突"];
  const d=details();d.hours={schedule_json:{timezone:"Asia/Shanghai",mode:"weekly",weekly:[{weekdays:[2,3,4,5,6,7],windows:[{start:"09:00",end:"17:00",last_entry:"16:30"}]}]},time_status:"complete",reason:"采用高德"};
  applyAmapAuthority(facts,{id:"p",name:"文化博物馆",address:"西安市高德地址",latitude:34.2,longitude:108.9,amap:d});
  assert.equal(facts.category,"4A");assert.equal(facts.address,"西安市高德地址");assert.equal(facts.time_status,"complete");assert.equal(facts.start_at,null);assert.deepEqual(facts.conflicts,[]);assert.equal(d.photos.length,1);assert(d.overrides!.length>0);
});
test("activity dates are not replaced by venue opening hours and closures stay paused",()=>{
  const {facts}=extractionFixture(),start=facts.start_at;applyAmapAuthority(facts,{id:"p",name:"文化展厅",address:"西安市高德地址",latitude:34.2,longitude:108.9,amap:details()});assert.equal(facts.start_at,start);assert.equal(facts.category,"展览");
  facts.record_type="attraction";applyAmapAuthority(facts,{id:"p",name:"文化博物馆(暂停开放)",address:"西安市高德地址",latitude:34.2,longitude:108.9,amap:details()});assert.equal(facts.status,"paused");assert.equal(facts.time_status,"unknown");assert(facts.time_note!.includes("高德营业时间"));
  assert(subjectProblem("丝路欢乐世界","丝路欢乐世界P5停车场",amapDetails({business:{keytag:"停车场"}},"now")));
  assert(subjectProblem("中国音乐史博物馆","学府城",amapDetails({business:{keytag:"高等教育"}},"now")));
});
test("AMap time normalization validates clocks and forbids invented date exceptions",async()=>{
  const input=[{id:"p",name:"博物馆",opentime_week:"周一至周日09:00-17:00",opentime_today:""}];
  const value={id:"p",schedule_json:{timezone:"Asia/Shanghai",mode:"weekly",weekly:[{weekdays:[1,2,3,4,5,6,7],windows:[{start:"09:00",end:"17:00"}]}]},time_status:"complete",reason:"原文规范"};
  assert.equal((await normalizeAmapHours(input,"2026-11-13",async()=>JSON.stringify({items:[value]}))).get("p")!.time_status,"complete");
  const wrong=structuredClone(value);wrong.schedule_json.weekly[0].windows[0].end="18:00";
  await assert.rejects(normalizeAmapHours(input,"2026-11-13",async()=>JSON.stringify({items:[wrong]})),/UNSUPPORTED_AMAP_CLOCK/);
  await assert.rejects(normalizeAmapHours(input,"2026-11-13",async()=>JSON.stringify({items:[{...value,schedule_json:{...value.schedule_json,exceptions:[{date:"2026-11-16",closed:true}]}}]})),/AMAP_EXCEPTION_NEEDS_EXPLICIT_DATE/);
  await assert.rejects(normalizeAmapHours([{...input[0],opentime_week:"",opentime_today:"09:00-17:00"}],"2026-11-13",async()=>JSON.stringify({items:[value]})),/TODAY_HOURS_NOT_WEEKLY/);
});

import{test}from"node:test";import assert from"node:assert/strict";
import{applyDefaultAttractionHours,isDefaultAttractionSchedule,applyDefaultAttractionBudget}from"../src/collection/default-opening.ts";
import{assessFreshness}from"../src/collection/freshness.ts";import{availabilityOnDate}from"../src/data/schedule.ts";
import{applyAttractionStatusPolicy}from"../src/collection/demo-status.ts";
import{extractActivities}from"../src/collection/extraction.ts";import{locatedFixture}from"./collection-downstream-fixture.ts";import{prepareCollection}from"../src/collection/preparation.ts";
test("missing attraction hours default to daily 09–17 with an explicit assumed basis and planning permission",()=>{
  const value:any={record_type:"attraction",status:"active",time_status:"unknown",schedule_json:null,time_note:"资料未提供常规开放时间"};assert(applyDefaultAttractionHours(value));assert(isDefaultAttractionSchedule(value.schedule_json));assert.equal(value.time_status,"partial");assert.match(value.time_note,/非来源确认/);
  const window=availabilityOnDate({recordType:"attraction",timeStatus:value.time_status,schedule:value.schedule_json},"2026-11-15");assert.equal(window.windows[0].startAt,"2026-11-15T09:00");assert.equal(window.windows[0].endAt,"2026-11-15T17:00");
  const decision=assessFreshness({...value,start_at:null,end_at:null},{recordType:"attraction",timeStatus:"partial",status:"active",confirmedEndDate:null,firstSeenAt:"2026-11-12T01:00:00Z",lastVerifiedAt:"2026-11-13T01:00:00Z",sourcePublishedAt:null},"2026-11-13T02:00:00Z");assert(decision.allowPlanning);
});
test("empty attraction budget defaults to 2000 cents, without replacing free entry or known prices",()=>{
  const row:any={record_type:"attraction",budget_min:null,budget_max:null,budget_note:"门票未查到"};assert(applyDefaultAttractionBudget(row));assert.equal(row.budget_min,2000);assert.equal(row.budget_max,2000);assert.match(row.budget_note,/非已核实/);
  for(const r of [{record_type:"activity",budget_min:null,budget_max:null},{record_type:"attraction",budget_min:0,budget_max:0},{record_type:"attraction",budget_min:5000,budget_max:null}]){const before=structuredClone(r);assert(!applyDefaultAttractionBudget(r));assert.deepEqual(r,before);}
});
test("defaults do not overwrite activity, closed, conflicting, seasonal or existing explicit hours",()=>{
  for(const input of [{record_type:"activity"},{status:"paused"},{time_status:"conflicting"},{time_note:"冬季需预约"},{time_note:"每周一闭馆"},{time_note:"每天08:30–18:00"},{schedule_json:{mode:"weekly",weekly:[]}},{valid_to:"2026-12-31"}]){
    const value={record_type:"attraction",status:"active",time_status:"unknown",...input};const before=structuredClone(value);assert.equal(applyDefaultAttractionHours(value),false);assert.deepEqual(value,before);
  }
});
test("closed and unconfirmed attractions carry 不开放 and cannot pass the planning gate; repeated policy is stable",()=>{
 for(const status of ["paused","unknown"]){const r:any={record_type:"attraction",status,time_note:"原始资料"};assert(applyAttractionStatusPolicy(r));assert.equal(r.status,"paused");assert.match(r.time_note,/不开放/);const note=r.time_note;applyAttractionStatusPolicy(r);assert.equal(r.time_note,note);assert(!assessFreshness({...r,start_at:null,end_at:null},{recordType:"attraction",timeStatus:"complete",status:"active",confirmedEndDate:null,firstSeenAt:"2026-11-12T01:00:00Z",lastVerifiedAt:"2026-11-13T01:00:00Z",sourcePublishedAt:null},"2026-11-13T02:00:00Z").allowPlanning);}
});
test("partial attraction time with a nonempty note is accepted without altering its actual rule",()=>{
 const event:any={start_at:null,end_at:null,record_type:"attraction",time_note:"季节规则见原文",schedule_json:null};const meta:any={recordType:"attraction",timeStatus:"partial",status:"active",confirmedEndDate:null,firstSeenAt:"2026-11-12T01:00:00Z",lastVerifiedAt:"2026-11-13T01:00:00Z",sourcePublishedAt:null};assert(assessFreshness(event,meta,"2026-11-13T02:00:00Z").allowPlanning);assert(!assessFreshness({...event,time_note:""},meta,"2026-11-13T02:00:00Z").allowPlanning);
});
test("script extraction and publication preparation retain approved defaults instead of rejecting missing source hours and price",async()=>{
 const{item,asOf}=await locatedFixture();item.document.text="西安市雁塔区文化路1号文化展厅长期对外参观，开放钟点与票价未公布。";
 const raw={...item.facts,record_type:"attraction",category:"暂无评级",start_at:null,end_at:null,confirmed_start_date:null,confirmed_end_date:null,budget_min:null,budget_max:null,evidence:{},status:"active"};
 const extracted=await extractActivities(item.document,{asOf,structured:{activities:[raw]}});assert.equal(extracted.activities.length,1);const facts=extracted.activities[0].facts;assert.equal(facts.budget_min,2000);assert(isDefaultAttractionSchedule(facts.schedule_json));
 const p=prepareCollection([{...item,facts}],{asOf,baseDate:"2026-11-12"});assert.equal(p.prepared.dataset.events.length,1,JSON.stringify(p.rejected));assert.equal(p.prepared.dataset.events[0].budget_max,2000);
});

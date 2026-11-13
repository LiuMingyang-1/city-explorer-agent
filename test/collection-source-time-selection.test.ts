import{test}from"node:test";import assert from"node:assert/strict";import{readFileSync}from"node:fs";import{parseSchedule,availabilityOnDate}from"../src/data/schedule.ts";
const selections=JSON.parse(readFileSync("docs/data/attraction-time-resolutions-20261113.json","utf8")).resolutions;
test("selected museum sign closes Friday while leaving Saturday open and keeps unspecified holidays as notes",()=>{
 const row=selections.find((r:any)=>r.title.includes("吉兆春"));const schedule=parseSchedule({timezone:"Asia/Shanghai",mode:"weekly",weekly:[{weekdays:row.weekdays,windows:[{start:row.start,end:row.end}]}]});
 assert.equal(availabilityOnDate({recordType:"attraction",timeStatus:row.time_status,schedule},"2026-11-13").state,"closed");assert.equal(availabilityOnDate({recordType:"attraction",timeStatus:row.time_status,schedule},"2026-11-14").state,"open");assert.equal(schedule!.exceptions,undefined);assert.match(row.historical_note,/法定节假日/);
});
test("all four selected schedules form usable recurring windows without changing holidays into invented dates",()=>{
 assert.equal(selections.length,4);assert.equal(new Set(selections.map((r:any)=>r.id)).size,4);
 for(const r of selections){assert(new URL(r.source_url).protocol==="https:");assert(r.reason&&r.historical_note);const schedule=parseSchedule({timezone:"Asia/Shanghai",mode:"weekly",weekly:[{weekdays:r.weekdays,windows:[{start:r.start,end:r.end}]}]});const day=availabilityOnDate({recordType:"attraction",timeStatus:r.time_status,schedule},"2026-11-16");assert.equal(day.state,"open");assert(day.windows[0].endAt>day.windows[0].startAt);}
});

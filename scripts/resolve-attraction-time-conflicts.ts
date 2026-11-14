import{readFileSync,writeFileSync,statSync}from"node:fs";import{createHash}from"node:crypto";import{DatabaseSync}from"node:sqlite";
import{applyAmapSupplement}from"../src/collection/amap-supplement.ts";import type{SupplementPlan}from"../src/collection/amap-supplement.ts";
import{parseSchedule,availabilityOnDate}from"../src/data/schedule.ts";
const path="data/events.db",batchId="curated-time-resolutions-20261113",asOf=new Date().toISOString(),apply=process.argv.includes("--apply");
const sha=()=>createHash("sha256").update(readFileSync(path)).digest("hex");
const db=new DatabaseSync(path,{readOnly:true}),rows=db.prepare("SELECT * FROM events ORDER BY id").all(),done=db.prepare("SELECT 1 FROM _collection_metadata WHERE key=?").get("batch:"+batchId);db.close();
if(done){console.log(JSON.stringify({already_applied:true,batch_id:batchId}));process.exit(0);}
const data=JSON.parse(readFileSync("docs/data/attraction-time-resolutions-20261113.json","utf8"));
const plan:SupplementPlan={expected_sha256:sha(),asOf,reviews:[],updates:[]};
for(const choice of data.resolutions){
 const before=rows.find(r=>r.id===choice.id);if(!before||before.title!==choice.title||before.record_type!=="attraction"||before.time_status!=="conflicting")throw Error("TIME_RESOLUTION_BASELINE_MISMATCH");
 const schedule=parseSchedule({timezone:"Asia/Shanghai",mode:"weekly",weekly:[{weekdays:choice.weekdays,windows:[{start:choice.start,end:choice.end}]}],note:choice.reason});
 const time_note=`已选用：${choice.weekdays.length===7?"每日":"周一至周四、周六及周日"}${choice.start}–${choice.end}。\n选择依据：${choice.reason}\n来源：${choice.source_title} ${choice.source_url}\n历史参考（本次不采用）：${choice.historical_note}`;
 const after={...before,schedule_json:JSON.stringify(schedule),time_status:choice.time_status,time_note,start_at:null,end_at:null,valid_from:null,valid_to:null,updated_at:asOf};
 if(choice.description_tail)after.description=String(before.description).replace(/正文称[\s\S]*开放日存在冲突。?/,choice.description_tail);
 const check=availabilityOnDate({recordType:"attraction",timeStatus:choice.time_status,schedule},"2026-11-16");if(check.state!=="open")throw Error("SELECTED_TIME_UNUSABLE");
 plan.updates.push(Object.assign({before,after},{resolution_evidence:{...choice,checked_at:asOf}}));
}
if(apply){
 applyAmapSupplement(path,plan,{batchId});const manifest=JSON.parse(readFileSync("data/events.manifest.json","utf8"));Object.assign(manifest,{sha256:sha(),bytes:statSync(path).size,latest_time_resolution:{batch_id:batchId,records:plan.updates.length,sources:"docs/data/attraction-time-resolutions-20261113.json"}});if(manifest.amap_supplement?.verification)manifest.amap_supplement.verification.sha256=sha();writeFileSync("data/events.manifest.json",JSON.stringify(manifest,null,2)+"\n");
}
const out="docs/status/attraction-time-resolutions-20261113";writeFileSync(out+".json",JSON.stringify({batch_id:batchId,checked_at:asOf,applied:apply,resolutions:data.resolutions,database_sha256:apply?sha():null},null,2)+"\n");
let md=`# 四条时间冲突的选定结果\n\n${apply?"已写入":"预览，尚未写入"}唯一数据库，按用户授权保留较可信的一套；其他说法压缩为历史备注。没有改动高德地址、经纬度、原guide_url、价格、图片及活动记录。选择不等于保证现场营业，节假日和未明确闭馆日仍在备注中说明。\n\n|景点|选用时间|依据|\n|---|---|---|\n`;
md+=data.resolutions.map((r:any)=>`|${r.title}|${r.weekdays.length===7?"每日":"周一至周四、周六及周日"} ${r.start}–${r.end}|[${r.source_title}](${r.source_url})；${r.reason}|`).join("\n");
md+="\n\n其余规则：三组近邻记录字段不同则分别保留；丝路欢乐世界保留且城市注明咸阳市。\n";writeFileSync(out+".md",md);console.log(JSON.stringify({applied:apply,records:plan.updates.length,selected:data.resolutions.map((r:any)=>({title:r.title,start:r.start,end:r.end,weekdays:r.weekdays}))}));

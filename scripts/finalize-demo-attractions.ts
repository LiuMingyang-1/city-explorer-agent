import{readFileSync,writeFileSync,statSync}from"node:fs";import{createHash}from"node:crypto";import{DatabaseSync}from"node:sqlite";
import{inspectCollectionDatabase}from"../src/collection/database.ts";
import{planAmapSupplement,applyAmapSupplement}from"../src/collection/amap-supplement.ts";
import{planImageSupplement}from"../src/collection/image-supplement.ts";
import{applyDefaultAttractionHours,applyDefaultAttractionBudget,isDefaultAttractionSchedule}from"../src/collection/default-opening.ts";
import{applyAttractionStatusPolicy}from"../src/collection/demo-status.ts";
import{parseSchedule}from"../src/data/schedule.ts";
const path="data/events.db",asOf=new Date().toISOString(),batchId="demo-attraction-policy-20261113",apply=process.argv.includes("--apply");
const sha=()=>createHash("sha256").update(readFileSync(path)).digest("hex");
const db=new DatabaseSync(path,{readOnly:true});const rows=db.prepare("SELECT * FROM events ORDER BY id").all();const done=db.prepare("SELECT 1 FROM _collection_metadata WHERE key=?").get("batch:"+batchId);db.close();
if(done){console.log(JSON.stringify({already_applied:true,batch_id:batchId,report:"docs/status/demo-attraction-completion-20261113.md"}));process.exit(0);}
const baseline={sha256:sha(),rows},inspection=inspectCollectionDatabase(path);
const previous=JSON.parse(readFileSync("docs/status/amap-attraction-review-20261113.json","utf8"));
const ids=new Set(previous.pending.filter((r:any)=>r.issues.some((s:string)=>s.startsWith("地点待确认"))).map((r:any)=>r.id));
const root=".local-data/xian/amap-supplement/",pois=JSON.parse(readFileSync(root+"pois.json","utf8"));
const plan=planAmapSupplement({baseline:{...baseline,rows:rows.filter(r=>ids.has(r.id))},pois,hours:{},images:{},asOf});
const updates=new Map(plan.updates.map(u=>[u.before.id,u]));const defaultHours:string[]=[],defaultBudget:string[]=[],unavailable:string[]=[];
for(const before of rows.filter(r=>r.record_type==="attraction")){
  const existing=updates.get(before.id),base=existing?.after??before,value:Record<string,any>={...base,schedule_json:parseSchedule(base.schedule_json)};
  // The nearby-POI planning pass may already have supplied the defaults.
  if(before.budget_min===null&&value.budget_min===2000)defaultBudget.push(String(before.title));
  const h=applyDefaultAttractionHours(value,String(value.description??"")),b=applyDefaultAttractionBudget(value),c=applyAttractionStatusPolicy(value);
  if(h)defaultHours.push(String(before.title));if(b)defaultBudget.push(String(before.title));
  if(c)unavailable.push(String(before.title));
  if(h||b||c||existing){
    const after={...value,schedule_json:value.schedule_json?JSON.stringify(value.schedule_json):null,updated_at:asOf};
    updates.set(before.id,{...(existing??{before}),after});
  }
}
const selected=JSON.parse(readFileSync("docs/data/baidu-attraction-images-20261113.json","utf8"));
const imagePlan=planImageSupplement(baseline,selected.selections,asOf);
for(const u of imagePlan.updates){const old=updates.get(u.before.id);updates.set(u.before.id,old?{...old,after:{...old.after,image_urls:u.after.image_urls,thumbnail_url:u.after.thumbnail_url},image_supplement:u.image_supplement}:u);}
plan.updates=[...updates.values()];
const report:any={created_at:asOf,batch_id:batchId,applied:false,accepted_nearby_pois:ids.size,images_added:imagePlan.updates.reduce((n,u)=>n+JSON.parse(u.after.image_urls).length,0),image_targets:imagePlan.updates.length,default_hours:defaultHours,default_budget:[...new Set(defaultBudget)],unavailable:[...new Set(unavailable)],updated_records:plan.updates.length};
if(apply){
  applyAmapSupplement(path,plan,{batchId});
  const check=new DatabaseSync(path,{readOnly:true}),after=check.prepare("SELECT * FROM events ORDER BY id").all(),a=after.filter(r=>r.record_type==="attraction");
  report.applied=true;report.verification={records:after.length,activities_unchanged:JSON.stringify(after.filter(r=>r.record_type==="activity"))===JSON.stringify(rows.filter(r=>r.record_type==="activity")),ids_unchanged:JSON.stringify(after.map(r=>r.id))===JSON.stringify(rows.map(r=>r.id)),integrity:check.prepare("PRAGMA integrity_check").get()!.integrity_check,with_images:a.filter(r=>JSON.parse(String(r.image_urls)).length).length,budget_missing:a.filter(r=>r.budget_min===null).length,default_hours:a.filter(r=>isDefaultAttractionSchedule(parseSchedule(String(r.schedule_json??"null")))) .map(r=>r.title),unavailable:a.filter(r=>r.status==="paused").map(r=>r.title),remaining_time_conflicts:a.filter(r=>r.time_status==="conflicting").map(r=>({id:r.id,title:r.title,time_note:r.time_note})),sha256:sha()};check.close();
  const manifest=JSON.parse(readFileSync("data/events.manifest.json","utf8"));Object.assign(manifest,{sha256:sha(),bytes:statSync(path).size,latest_demo_policy:report});if(manifest.amap_supplement?.verification)manifest.amap_supplement.verification.sha256=sha();writeFileSync("data/events.manifest.json",JSON.stringify(manifest,null,2)+"\n");
}
const out="docs/status/demo-attraction-completion-20261113";writeFileSync(out+".json",JSON.stringify(report,null,2)+"\n");
let md=`# Demo景点规则、图片与最终缺项\n\n${apply?"已写入":"预览"}唯一数据库data/events.db；接受${ids.size}个高德附近定位点。补${report.image_targets}个景点、${report.images_added}张图片，图片来源见[图片清单](../data/baidu-attraction-images-20261113.json)。图片只保存URL，原信息源guide_url不改动。\n\n`;
md+=`- 空预算恢复为每人20元：${report.default_budget.length}条，数据库按分存2000；原有免费0元和明确价格保留。\n- 确实没有常规时间的记录：${defaultHours.join("、")||"无新增"}，默认每天09:00–17:00，明确标为项目默认，非来源确认。\n- 部分时间有备注就保留，不作为独立失败项；时间冲突仍单独列出。\n- 不开放、不纳入规划：${report.unavailable.length}条，包括原暂停、原未知开放状态及高德明确内部专用记录；时间备注注明原因。\n\n`;
if(apply)md+=`## 核对\n\n记录${report.verification.records}条；图片覆盖${report.verification.with_images}/245；预算空值${report.verification.budget_missing}；活动原行不变${report.verification.activities_unchanged}；ID不变${report.verification.ids_unchanged}；完整性${report.verification.integrity}。\n\n## 仍需处理的时间冲突\n\n`+report.verification.remaining_time_conflicts.map((r:any)=>`- ${r.title}：${String(r.time_note).replace(/\n/g,"；")}`).join("\n")+"\n\n丝路欢乐世界行政城市仍按高德为咸阳市，作为西安周边范围事项注明。暂无评级、默认预算/时间、已标不开放、有备注的部分时间，不单独算作不合格。\n";
writeFileSync(out+".md",md);console.log(JSON.stringify(report));

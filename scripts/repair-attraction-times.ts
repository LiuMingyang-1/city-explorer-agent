import{readFileSync,writeFileSync,readdirSync,statSync}from"node:fs";
import{resolve,join}from"node:path";import{createHash}from"node:crypto";import{DatabaseSync}from"node:sqlite";
import{inspectCollectionDatabase}from"../src/collection/database.ts";
import{planAmapTimeRepairs,applyAmapSupplement}from"../src/collection/amap-supplement.ts";
import{availabilityOnDate,parseSchedule}from"../src/data/schedule.ts";
// One-time maintenance from private, redacted normalization results. No API
// calls occur here. All returned rules are checked again against bound AMap text.
const args=process.argv.slice(2),root=resolve(args.find(a=>!a.startsWith("--"))??".local-data/xian/amap-supplement/recharge-repair");
const database="data/events.db",asOf=new Date().toISOString(),batchId="attraction-time-repair-20261113";
const checksum=()=>createHash("sha256").update(readFileSync(database)).digest("hex");
const db=new DatabaseSync(database,{readOnly:true});const rows=db.prepare("SELECT * FROM events ORDER BY id").all();db.close();
const baseline={sha256:checksum(),rows},inspection=inspectCollectionDatabase(database);
const results=Object.entries(JSON.parse(readFileSync(join(root,"results.json"),"utf8"))) as [string,any][];
const items=results.filter(([,r])=>r.result).map(([id,r])=>({id,poi_id:r.poi_id,hours:r.result}));
const plan=await planAmapTimeRepairs(baseline,inspection.sidecar,items,asOf);
const sourceCorrections:{title:string;reason:string}[]=[];
for(const row of rows.filter(r=>r.record_type==="attraction")){
  let patch:Record<string,unknown>|undefined,reason="";
  if(["易俗社文化旅游景区","王府井奥莱·临潼小镇（临潼奥特莱斯景区）"].includes(String(row.title))&&row.budget_min===null&&/免费/.test(String(row.budget_note))){
    patch={budget_min:0,budget_max:0,budget_note:`基础入场免费，购物、演出及其他自选项目另计。原资料：${row.budget_note}`};reason="原有明确免费说明落实为基础入场0元";
  }
  if(row.title==="红色葛牌景区（葛牌古镇）"&&row.time_status==="unknown"&&/24小时全年无休/.test(String(row.time_note))){
    patch={schedule_json:JSON.stringify({timezone:"Asia/Shanghai",mode:"always_open",note:"仅古镇公共区域，纪念馆开放时间需另行确认"}),time_status:"complete",time_note:`古镇公共区域：原资料称24小时全年无休。纪念馆周一闭馆且未给出具体开放钟点，不能把古镇全天开放理解为纪念馆全天开放。原资料：${row.time_note}`,valid_from:null,valid_to:null,start_at:null,end_at:null};reason="区分古镇公共区域和馆内时间，不把馆内信息缺失扩大为整个古镇未知";
  }
  if(row.title==="西安常宁宫休闲山庄"&&row.budget_min===67000&&/住宿/.test(String(row.budget_note))){
    patch={budget_min:null,budget_max:null,budget_note:`基础参观门票尚未确认；原670元起为含住宿套餐，不能作为景点门票。原资料：${row.budget_note}`};reason="移除住宿套餐误作参观费用的数值，保留原套餐说明";
  }
  if(row.title==="曲江寒窑遗址公园"&&/成人全价票未明确/.test(String(row.budget_note))){
    patch={budget_min:null,budget_max:null,budget_note:`成人基础门票尚未确认；学生票与特定人群免票不能替代成人全价。原资料：${row.budget_note}`};reason="移除以优惠票25元充当成人预算上限的错误";
  }
  if(patch){const existing=plan.updates.find(u=>u.before.id===row.id);if(existing)Object.assign(existing.after,patch);else plan.updates.push({before:row,after:{...row,...patch,updated_at:asOf},authority:inspection.sidecar.events[String(row.id)]?.amap_authority});sourceCorrections.push({title:String(row.title),reason});}
}
const dates=Array.from({length:14},(_,i)=>new Date(Date.parse("2026-11-13T12:00:00Z")+i*86400000).toISOString().slice(0,10));
const stats=(data:any[])=>({records:data.length,time_statuses:data.filter(r=>r.record_type==="attraction").reduce((a:any,r:any)=>(a[r.time_status]=(a[r.time_status]??0)+1,a),{}),budget_missing:data.filter(r=>r.record_type==="attraction"&&r.budget_min===null).length});
const fixedNames=["大明宫国家遗址公园丹凤门遗址博物馆","大明宫遗址博物馆","西安市起良蔡侯纸博物馆","阿房宫遗址公园"];
for(const u of plan.updates.filter(u=>fixedNames.includes(u.after.title))){const states=dates.map(date=>availabilityOnDate({recordType:"attraction",timeStatus:u.after.time_status,schedule:parseSchedule(u.after.schedule_json)},date));if(!states.some(s=>s.state==="open")||states.some(s=>s.state==="unknown"))throw Error("REPAIRED_SEASONAL_WINDOW_UNUSABLE");}
const attempts=readdirSync(root).filter(f=>/^attempt-.*\.json$/.test(f)).map(f=>JSON.parse(readFileSync(join(root,f),"utf8")));
const times=attempts.map(a=>a.elapsed_ms).sort((a,b)=>a-b),percentile=(p:number)=>times[Math.max(0,Math.ceil(times.length*p)-1)]??null;
const report:any={checked_at:asOf,batch_id:batchId,applied:false,normalized:items.length,skipped_model_failures:results.filter(([,r])=>!r.result).map(([id,r])=>({id,title:r.title,error:r.error})),source_corrections:sourceCorrections,before:stats(rows),api:{requests:attempts.length,p50_ms:percentile(.5),p95_ms:percentile(.95)},changes:plan.updates.map(u=>({id:u.before.id,title:u.before.title,old_time_status:u.before.time_status,new_time_status:u.after.time_status,changed_fields:Object.keys(u.before).filter(k=>u.before[k]!==u.after[k])}))};
if(args.includes("--apply")){
  applyAmapSupplement(database,plan,{batchId});
  const check=new DatabaseSync(database,{readOnly:true});const after=check.prepare("SELECT * FROM events ORDER BY id").all();check.close();
  const activitiesUnchanged=JSON.stringify(rows.filter(r=>r.record_type==="activity"))===JSON.stringify(after.filter(r=>r.record_type==="activity"));if(!activitiesUnchanged)throw Error("ACTIVITY_ROWS_CHANGED");
  Object.assign(report,{applied:true,after:stats(after),activities_unchanged:true,database_sha256:checksum()});
  const path="data/events.manifest.json",manifest=JSON.parse(readFileSync(path,"utf8"));Object.assign(manifest,{sha256:checksum(),bytes:statSync(database).size,latest_time_repair:{batch_id:batchId,normalized:items.length,source_corrections:sourceCorrections,after:report.after}});
  if(manifest.amap_supplement?.verification)manifest.amap_supplement.verification.sha256=checksum();
  manifest.known_limitations=manifest.known_limitations.filter((s:string)=>!s.startsWith("DeepSeek balance exhausted"));writeFileSync(path,JSON.stringify(manifest,null,2)+"\n");
}
const output="docs/status/attraction-time-repair-20261113";writeFileSync(output+".json",JSON.stringify(report,null,2)+"\n");
let md=`# 景点时间与现有资料修复批次\n\n${report.applied?"已写入":"预览，未写入"}唯一数据库data/events.db。58条高德时间结果重校验，4条季节端点错误检查未来14天可用性。不存在余额不足错误后继续静默丢弃的情况；所有API返回仍逐条校验。\n\nAPI请求${attempts.length}次（含重试），单次P50 ${percentile(.5)}毫秒、P95 ${percentile(.95)}毫秒。\n\n`;
md+=`修复前：${JSON.stringify(report.before)}。\n\n修复后：${JSON.stringify(report.after??null)}。\n\n活动原行保持不变：${report.activities_unchanged??"未写入"}。高德原始抓取时间保持不变，另存normalized_at，不把重新规范当成重新核验全部事实。\n\n`;
md+="## 现有资料纠正\n\n"+sourceCorrections.map(c=>`- ${c.title}：${c.reason}`).join("\n")+"\n\n## 逐条变更\n\n|景点|原时间状态|新时间状态|修改字段|\n|---|---|---|---|\n"+report.changes.map((r:any)=>`|${r.title}|${r.old_time_status}|${r.new_time_status}|${r.changed_fields.join("、")}|`).join("\n")+"\n\n本批未处理的地点、图片、门票补查等问题见更新后的黄金数据分类清单，不以本次时间处理成功宣称全部数据达标。\n";writeFileSync(output+".md",md);
console.log(JSON.stringify({...report,changes:report.changes.length}));

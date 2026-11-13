import {readFileSync,writeFileSync,mkdirSync,statSync} from "node:fs";
import {resolve,join} from "node:path";
import {createHash} from "node:crypto";
import {planAmapSupplement,applyAmapSupplement} from "../src/collection/amap-supplement.ts";
import {inspectCollectionDatabase} from "../src/collection/database.ts";
import {DatabaseSync} from "node:sqlite";
import {deduplicateAttractions} from "../src/collection/attraction-dedup.ts";

// Private caches contain collector-fetched POIs, not keys. Applying requires the
// original database checksum and exact rows to still match the reviewed baseline.
const args=process.argv.slice(2),root=resolve(args.find(a=>!a.startsWith("--"))??".local-data/xian/amap-supplement");
const read=(name:string)=>JSON.parse(readFileSync(join(root,name),"utf8"));
const repairs=read("identity-repair.json");
const plan=planAmapSupplement({baseline:read("baseline.json"),pois:[...read("pois.json"),...repairs.pois],hours:read("hours.json"),images:read("image-checks.json"),asOf:new Date().toISOString(),repairs:{B0JAXM5NIO:"B0HDFZFFIX"}});
const pending=plan.reviews.filter(r=>!r.golden),counts:Record<string,number>={};
for(const row of pending)for(const issue of row.issues){const group=issue.split("：")[0];counts[group]=(counts[group]??0)+1;}
mkdirSync("docs/status",{recursive:true});
const path="docs/status/amap-attraction-review-20261113";
const summary={checked_at:plan.asOf,attractions:plan.reviews.length,golden:plan.reviews.length-pending.length,pending:pending.length,issues:counts,changed:plan.reviews.filter(r=>r.changed_fields.length).length};
writeFileSync(path+".json",JSON.stringify({summary,criteria:"字段覆盖与来源质量审计，不保证现场营业；A级未提供不等于未评级；费用/介绍沿用原来源，见notes及原provenance。",pending,passed:plan.reviews.filter(r=>r.golden)},null,2)+"\n");
const safe=(s:unknown)=>String(s??"无").replace(/\|/g,"\\|").replace(/\r?\n/g,"；");
let md=`# 西安景点高德补全与待核对清单\n\n检查时间：${plan.asOf}。${summary.attractions}条景点，覆盖检查通过${summary.golden}条，仍待核对${summary.pending}条。通过仅表示本文口径下字段与依据够用，不保证现场开放；简介、建议时长和门票仍可能沿用原来源。\n\n`;
md+="## 检查口径\n\n地点必须是景点本体；高德地址、GCJ-02坐标、明确A级、图片、主体开放时间和暂停状态优先。同字段高德缺失时保留原来源，标记待确认。高德评分不当作A级、人均消费不当作票价。时间要求未来14天至少存在开放窗口且无未知日期；复杂时间解析失败时原文完整保留。未知A级仍需核对是否未评级或不适用，不猜测。费用缺失或明确为估算需要核对。内部景点须确认公众参观条件。建议时长允许估算，保留原provenance依据。\n\n这不是删除清单；记录保留在唯一数据库，供逐条复核。详情仅按既有POI查询，除已确认的丝路欢乐世界外，没有将相似名称场馆自动替换成另一个实体。活动20条不参与本次补全。\n\n";
md+="## 缺项汇总\n\n|问题|景点数|\n|---|---:|\n"+Object.entries(counts).map(([k,v])=>`|${safe(k)}|${v}|`).join("\n")+"\n\n";
md+="## 逐条待核对\n\n";
for(const [i,r]of pending.entries()){
  md+=`### ${i+1}. ${r.title}\n\nID：\`${r.id}\`；高德：${r.amap_name??"未查到"}（${r.amap_poi_id??"无"}）。\n\n`;
  md+=r.issues.map(s=>"- "+safe(s)).join("\n")+"\n\n";
  md+=`现有地址：${safe(r.current.address)}；坐标：${r.current.longitude}, ${r.current.latitude}（GCJ-02）；等级：${r.current.category}；图片：${JSON.parse(r.current.image_urls).length}张；费用：${r.current.budget_min??"未知"}–${r.current.budget_max??"未知"}分。\n\n`;
  md+=`[原信息源](${r.current.guide_url})。本次修改：${r.changed_fields.join("、")||"无字段补全"}。\n\n`;
  if(r.notes.length)md+="说明："+r.notes.join("；")+"。\n\n";
}
md+="## 字段覆盖检查通过\n\n"+plan.reviews.filter(r=>r.golden).map(r=>`- ${r.title}（${r.id}）`).join("\n")+"\n";
if(args.includes("--apply")){
  const receipt=applyAmapSupplement("data/events.db",plan,{batchId:"amap-attraction-supplement-20261113"});
  const manifest=JSON.parse(readFileSync("data/events.manifest.json","utf8")),inspection=inspectCollectionDatabase("data/events.db");
  Object.assign(manifest,{created_at:plan.asOf,sha256:createHash("sha256").update(readFileSync("data/events.db")).digest("hex"),bytes:statSync("data/events.db").size,database_id:inspection.database_id,records:inspection.records,amap_supplement:summary});
  manifest.known_limitations.push(`AMap supplement: ${pending.length} attractions require review; see ${path}.md.`,`DeepSeek balance exhausted during complex opening-hours normalization; unprocessed source text is preserved.`);
  writeFileSync("data/events.manifest.json",JSON.stringify(manifest,null,2)+"\n");
  md+="\n已写入data/events.db；同库同ID，完整before/after和高德依据记录在_collection_metadata的批次收据中。\n";
  console.log(JSON.stringify({applied:receipt,summary}));
}else console.log(JSON.stringify({preview:summary,apply:"node scripts/supplement-amap.ts --apply"}));
const db=new DatabaseSync("data/events.db",{readOnly:true});
try{
  const rows=db.prepare("SELECT * FROM events ORDER BY id").all();
  const applied=!!db.prepare("SELECT 1 FROM _collection_metadata WHERE key=?").get("batch:amap-attraction-supplement-20261113");
  const before=read("baseline.json").rows;
  const verification={applied,records:rows.length,activities_unchanged:JSON.stringify(rows.filter(r=>r.record_type==="activity"))===JSON.stringify(before.filter((r:any)=>r.record_type==="activity")),ids_unchanged:JSON.stringify(rows.map(r=>r.id))===JSON.stringify(before.map((r:any)=>r.id)),integrity:db.prepare("PRAGMA integrity_check").get()!.integrity_check,coordinate_duplicates:deduplicateAttractions(rows as any).duplicates.length,sha256:createHash("sha256").update(readFileSync("data/events.db")).digest("hex")};
  writeFileSync(path+".json",JSON.stringify({summary,verification,criteria:"字段覆盖与来源质量审计，不保证现场营业；A级未提供不等于未评级；费用/介绍沿用原来源，见notes及原provenance。",pending,passed:plan.reviews.filter(r=>r.golden)},null,2)+"\n");
  if(applied)md+=`\n## 写入核对\n\n已写入唯一数据库data/events.db；记录${rows.length}条。活动原行保持一致：${verification.activities_unchanged}；所有ID保持一致：${verification.ids_unchanged}；完整性：${verification.integrity}；10米坐标重复：${verification.coordinate_duplicates}。SHA256：\`${verification.sha256}\`。原始before/after与高德字段依据保存在同库_collection_metadata批次收据。丝路欢乐世界城市按高德更正为咸阳市，作为既有西安周边目标保留待复核。\n`;
}finally{db.close();}
writeFileSync(path+".md",md);

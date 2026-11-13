import{readFileSync,writeFileSync}from"node:fs";import{createHash}from"node:crypto";import{DatabaseSync}from"node:sqlite";
import{parseSchedule,availabilityOnDate}from"../src/data/schedule.ts";import{isDefaultAttractionSchedule}from"../src/collection/default-opening.ts";
const database="data/events.db",db=new DatabaseSync(database,{readOnly:true});
const rows=db.prepare("SELECT * FROM events WHERE record_type='attraction' ORDER BY title").all() as Record<string,any>[];
const state=JSON.parse(String(db.prepare("SELECT value FROM _collection_metadata WHERE key=?").get("state")!.value));db.close();
const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date());
const groups:any[]=[];
function add(key:string,title:string,kind:string,meaning:string,list:Record<string,any>[],detail:(r:Record<string,any>)=>string){groups.push({key,title,kind,count:list.length,meaning,items:list.map(r=>({id:r.id,title:r.title,detail:detail(r),category:r.category,source_url:r.guide_url}))});}
const seasonal=rows.filter(r=>r.time_status==="complete"&&r.status!=="paused").filter(r=>{
 const schedule=parseSchedule(r.schedule_json);const states=Array.from({length:14},(_,i)=>new Date(Date.parse(today+"T12:00:00Z")+i*86400000).toISOString().slice(0,10)).map(d=>availabilityOnDate({recordType:"attraction",timeStatus:r.time_status,schedule},d).state);
 return schedule?.mode==="dates"&&(!states.includes("open")||states.includes("unknown"));
});
add("program_dates","季节区间展开错误","需修复","此前4条已修复，本项重新按当前库检查，不将只有首尾日期当作完整区间。",seasonal,r=>r.time_note);
add("identity","地点本体待核对","需修复","用户已接受高德附近定位；只在缺少坐标或POI时记录缺失，不因父校园/附近点拦截。",rows.filter(r=>!r.amap_poi_id||r.latitude==null||r.longitude==null),r=>r.address);
add("partial_hours","部分时间没有备注","需补充","部分时间有备注即可保留，不要求全部变成完整规则。",rows.filter(r=>r.time_status==="partial"&&!r.time_note?.trim()),()=>"缺少时间说明");
add("conflicting_hours","仍未消除的时间冲突","需处理","这4条仍是conflicting，不把矛盾悄悄改成完整；其中不开放的记录已排除规划。历史地址已按高德处理，本项只列时间问题。",rows.filter(r=>r.time_status==="conflicting"),r=>(r.status==="paused"?"【不开放，已排除规划】":"【仍在候选中，精确时间需处理】")+String(r.time_note).split("\n").filter(s=>!s.includes("地址存在冲突")).join("；"));
add("missing_hours","确实缺少开放时间且没有默认","需补充","无资料时默认每天09:00–17:00并标注默认依据，不覆盖已知季节限制和冲突。",rows.filter(r=>r.time_status==="unknown"),r=>r.time_note);
add("images","缺少图片","需补充","按最终image_urls统计，已补18条、47张。",rows.filter(r=>!JSON.parse(r.image_urls).length),()=>"image_urls为空");
add("budget_missing","预算数值为空","需补充","景点预算全空时默认每人20元，存2000分；明确免费或已有价格不覆盖。",rows.filter(r=>r.budget_min===null&&r.budget_max===null),r=>r.budget_note??"无说明");
add("nearby_accepted","已接受高德附近定位","正常保留","15条接受高德地址和GCJ-02坐标，保留馆名；不套用父地点时间、星级或图片。",rows.filter(r=>state.events[r.id]?.amap_authority?.details.location_only),r=>"高德定位点："+state.events[r.id].amap_authority.details.nearby_name);
add("partial_notes_accepted","部分时间已有备注","正常保留","按用户要求有备注即可，不独立判不合格。",rows.filter(r=>r.time_status==="partial"&&r.time_note?.trim()),r=>r.time_note);
add("default_time","默认每日09:00–17:00","正常默认值","项目默认规划时间，不是官方确认的营业时间。",rows.filter(r=>isDefaultAttractionSchedule(parseSchedule(r.schedule_json))),r=>r.time_note);
add("default_budget","默认每人20元","正常默认值","数据库单位分，数值为2000；备注保留原来源的不确定价格说明。",rows.filter(r=>r.budget_note?.includes("默认预算：每人20元")),r=>r.budget_note);
add("paused","不开放，排除规划","正常保留但不规划","原暂停开放、未确认开放状态与高德明确内部专用共11条。未确认不等于已证实永久停业；均有不开放备注，status=paused。",rows.filter(r=>r.status==="paused"),r=>r.time_note);
add("unavailable_note_missing","不开放但缺少备注","需补充","所有暂停记录都应写明不开放原因。",rows.filter(r=>r.status==="paused"&&!r.time_note?.includes("不开放")),r=>r.time_note??"无备注");
add("scope","行政范围说明","范围事项","丝路欢乐世界行政城市按高德为咸阳市，作为既有西安周边目标保留；严格只收西安市时需从目标范围排除，这不是地址字段填写错误。",rows.filter(r=>r.city!=="西安市"),r=>r.city+"；"+r.address);
const names=new Map<string,Record<string,any>[]>();for(const r of rows){const key=r.title.normalize("NFKC").replace(/\(.*$/,"").replace(/^(?:西安市?|陕西省?)/,"").trim();names.set(key,[...(names.get(key)??[]),r]);}
const duplicates=[...names.entries()].filter(([,list])=>list.length>1);
groups.push({key:"possible_duplicates",title:"相同核心名称的近邻记录",kind:"疑似重复，未自动合并",count:duplicates.length,meaning:"坐标10米去重已通过；这里补查同名或别名。高德可能给出不同入口/子场馆，保留真实定位，需判断合并还是改名区分，避免主Agent重复安排。",items:duplicates.map(([name,list])=>({id:list.map(r=>r.id).join("、"),title:name,detail:list.map(r=>`${r.title}；高德${r.venue_name}（${r.amap_poi_id}）`).join(" / "),source_url:list[0].guide_url}))});
add("default_grade","暂无评级","正常默认值","暂无评级是允许的默认值，不据此判不合格。",rows.filter(r=>r.category==="暂无评级"),()=>"category=暂无评级");
const stats={checked_at:new Date().toISOString(),database_sha256:createHash("sha256").update(readFileSync(database)).digest("hex"),attractions:rows.length,known_A_level:rows.filter(r=>r.category!=="暂无评级").length,default_grade:rows.filter(r=>r.category==="暂无评级").length,with_images:rows.filter(r=>JSON.parse(r.image_urls).length).length,default_budget:groups.find(g=>g.key==="default_budget").count,unavailable:rows.filter(r=>r.status==="paused").length};
const output="docs/status/attraction-golden-classification-20261113";writeFileSync(output+".json",JSON.stringify({stats,groups},null,2)+"\n");
let md="# 按用户最新规则的景点黄金数据检查\n\n直接读取唯一数据库，合并原有信息、高德补充、百度图片及项目默认值。此前237条是旧的高德覆盖口径，不是实际不合格总数。各类可以重叠，不相加。\n\n";
md+=`245条景点，70条已有A级、175条暂无评级；图片覆盖${stats.with_images}/245；默认预算${stats.default_budget}条；不开放排除规划${stats.unavailable}条。20条活动未改动。默认时间和预算是项目估算，不宣称为官方事实。\n\n`;
md+="## 分类总览\n\n|类别|条数|性质|\n|---|---:|---|\n"+groups.map(g=>`|${g.title}|${g.count}|${g.kind}|`).join("\n")+"\n\n";
const safe=(s:string)=>String(s??"").replace(/\|/g,"\\|").replace(/\n/g,"；");
for(const g of groups){if(!g.count)continue;md+=`## ${g.title}（${g.count}条）\n\n${g.meaning}\n\n|景点|具体情况|ID|\n|---|---|---|\n`+g.items.map((r:any)=>`|${safe(r.title)}|${safe(r.detail)}|${r.id}|`).join("\n")+"\n\n";}
md+="[本次补图与默认规则报告](demo-attraction-completion-20261113.md) · [图片及原始页面来源清单](../data/baidu-attraction-images-20261113.json)。\n";writeFileSync(output+".md",md);console.log(JSON.stringify({stats,groups:groups.map(({key,count,kind})=>({key,count,kind}))}));

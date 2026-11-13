import {readFileSync,openSync,closeSync,unlinkSync} from "node:fs";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {collectionDatabasePath} from "./database.ts";
import {amapDetails,amapGrade,subjectProblem,simpleAmapHours,captureAmapAuthority,normalizeAmapHours} from "./amap-authority.ts";
import type {AmapHours,AmapAuthoritySnapshot} from "./amap-authority.ts";
import {parseSchedule,availabilityOnDate} from "../data/schedule.ts";
import type {Sidecar} from "./releases.ts";
import {normalizeScenicLevel} from "../data/categories.ts";

type Row=Record<string,any>;
export interface SupplementInput {
  baseline:{sha256:string;rows:Row[]};pois:Row[];hours:Record<string,AmapHours>;
  images:Record<string,{ok:boolean;url?:string}>;asOf:string;
  repairs?:Record<string,string>;
}
export interface AttractionReview {
  id:string;title:string;amap_poi_id:string|null;amap_name:string|null;golden:boolean;
  issues:string[];notes:string[];changed_fields:string[];current:Row;
}
export interface SupplementPlan {
  expected_sha256:string;asOf:string;updates:{before:Row;after:Row;authority?:AmapAuthoritySnapshot}[];
  reviews:AttractionReview[];
}
/** Re-normalization uses the already bound AMap text, without re-verifying or
 * overwriting unrelated fields. Raw map fetch time is retained separately. */
export async function planAmapTimeRepairs(baseline:{sha256:string;rows:Row[]},sidecar:Sidecar,items:{id:string;poi_id:string;hours:AmapHours}[],asOf:string):Promise<SupplementPlan>{
  if(!Number.isFinite(Date.parse(asOf))||new Set(items.map(i=>i.id)).size!==items.length)throw Error("INVALID_AMAP_TIME_REPAIRS");
  const plan:SupplementPlan={expected_sha256:baseline.sha256,asOf,updates:[],reviews:[]};
  const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date(asOf));
  for(const item of items){
    const before=baseline.rows.find(r=>r.id===item.id),old=sidecar.events[item.id]?.amap_authority;
    if(!before||before.record_type!=="attraction"||before.amap_poi_id!==item.poi_id||old?.poi_id!==item.poi_id)throw Error("AMAP_TIME_REPAIR_NOT_BOUND");
    const b=old.details.business,text=b.opentime_week||b.opentime_today;if(!text)throw Error("AMAP_TIME_REPAIR_MISSING_SOURCE");
    const validated=await normalizeAmapHours([{id:item.poi_id,name:before.venue_name,opentime_week:b.opentime_week??"",opentime_today:b.opentime_today??""}],today,async()=>JSON.stringify({items:[{id:item.poi_id,...item.hours}]}));
    const hours=validated.get(item.poi_id)!,after=structuredClone(before),authority=structuredClone(old);
    after.schedule_json=hours.schedule_json?JSON.stringify(hours.schedule_json):null;after.time_status=hours.time_status;
    after.time_note=`高德营业时间：${text}\n${hours.reason}`;after.valid_from=null;after.valid_to=null;after.start_at=null;after.end_at=null;after.updated_at=asOf;
    authority.details.hours=hours;authority.details.normalized_at=asOf;
    for(const key of ["time_status","time_note","valid_from","valid_to","start_at","end_at"])authority.fields[key]=after[key];
    authority.fields.schedule_json=hours.schedule_json;
    plan.updates.push({before,after,authority});
  }
  return plan;
}
export function planAmapSupplement(input:SupplementInput):SupplementPlan {
  if(!Number.isFinite(Date.parse(input.asOf)))throw Error("INVALID_SUPPLEMENT_CLOCK");
  const index=new Map(input.pois.map(p=>[p.id,p]));
  const plan:SupplementPlan={expected_sha256:input.baseline.sha256,asOf:input.asOf,updates:[],reviews:[]};
  const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date(input.asOf));
  for(const before of input.baseline.rows.filter(r=>r.record_type==="attraction")){
    const after=structuredClone(before),issues:string[]=[],notes:string[]=[];
    after.category=normalizeScenicLevel(after.category);
    const poi=index.get(input.repairs?.[before.amap_poi_id]??before.amap_poi_id);
    let authority:AmapAuthoritySnapshot|undefined;
    const d=poi?amapDetails(poi,input.asOf):undefined;
    const identity=poi&&d?subjectProblem(before.title,poi.name,d):"未获取到该景点的高德详情";
    if(identity){
      issues.push("地点待确认："+identity);
      issues.push(`A级：当前地点绑定未确认，无法用其等级为目标景点佐证；现值${after.category}`);
      if(!JSON.parse(after.image_urls).length)issues.push("图片：现有记录缺少图片，未使用不确定父地点的照片");
    }
    else if(poi&&d){
      const [lng,lat]=String(poi.location).split(",").map(Number);
      if(!Number.isFinite(lng)||!Number.isFinite(lat)||lng<107||lng>111||lat<33||lat>35.5)throw Error("INVALID_SUPPLEMENT_COORDINATES");
      after.venue_name=poi.name;after.address=[poi.pname,poi.cityname,poi.adname,poi.address].filter(v=>typeof v==="string"&&v).join("");
      after.latitude=lat;after.longitude=lng;after.amap_poi_id=poi.id;
      after.city=poi.cityname;
      if(poi.cityname!=="西安市")issues.push(`城市范围：高德行政城市为${poi.cityname}，城市字段已按高德更正；既有西安周边目标是否保留需确认`);
      const grade=amapGrade(d);if(grade)after.category=grade;
      d.photos=d.photos.filter(p=>{
        const hit=input.images[p.url]??Object.values(input.images).find(c=>c.url===p.url);
        return hit?.ok&&hit.url===p.url;
      });
      if(d.photos.length){after.image_urls=JSON.stringify([...new Set(d.photos.map(p=>p.url))]);after.thumbnail_url=d.photos[0].url;}
      const raw=d.business.opentime_week||d.business.opentime_today;
      if(raw){
        d.hours=(d.business.opentime_week?simpleAmapHours(d.business.opentime_week):null)??input.hours[poi.id]??{schedule_json:null,time_status:"unknown",reason:"复杂高德时间尚未规范；模型余额不足，保留原文待处理"};
        parseSchedule(d.hours.schedule_json);
        after.schedule_json=d.hours.schedule_json?JSON.stringify(d.hours.schedule_json):null;
        after.time_status=d.hours.time_status;after.time_note=`高德营业时间：${raw}\n${d.hours.reason}`;
        after.valid_from=null;after.valid_to=null;after.start_at=null;after.end_at=null;
      }
      if(/暂停开放|暂停营业|暂不开放|停业|已关闭/.test(poi.name))after.status="paused";
      if(d.business.cost)notes.push(`高德人均消费${d.business.cost}元，仅供参考，未作为门票写入budget字段`);
      const normalized={...after,image_urls:JSON.parse(after.image_urls),schedule_json:parseSchedule(after.schedule_json)};
      authority=captureAmapAuthority(normalized,{poi_id:poi.id,source_url:"https://restapi.amap.com/v5/place/detail",amap:d});
      if(!d.photos.length)issues.push("图片：高德未返回可访问的景点图片");
      if(!raw)issues.push("开放时间：高德未提供，现有时间仅沿用原来源");
      if(!grade)issues.push(`A级：高德未标注，当前${after.category}不能据此认定为未评级`);
      if(/内部专用|不对外/.test(poi.name))issues.push("参观资格：高德标注内部专用，尚未确认公众能否进入");
    }
    const schedule=parseSchedule(after.schedule_json);
    if(after.time_status!=="complete"){
      const explanation=String(after.time_note??"缺少开放时间说明")
        .replaceAll("INCOMPLETE_MODEL_RESPONSE","模型未完整返回结构化时间，尚未形成可用规则")
        .replaceAll("UNSUPPORTED_AMAP_CLOCK","模型钟点缺少高德原文支持，未采用该规则")
        .replaceAll("INVALID_STORED_SCHEDULE","时段结构或起止关系不合法，原文保留待规范");
      const status={partial:"仅部分时间可规范",unknown:"尚无可用结构化规则",conflicting:"时间存在尚未消除的冲突"}[after.time_status as "partial"|"unknown"|"conflicting"];
      issues.push(`时间规范：${status}；${explanation}`);
    }
    else {
      const days=Array.from({length:14},(_,i)=>new Date(Date.parse(today+"T12:00:00Z")+i*86400000).toISOString().slice(0,10));
      const states=days.map(date=>availabilityOnDate({recordType:"attraction",timeStatus:after.time_status,schedule,validFrom:after.valid_from,validTo:after.valid_to},date).state);
      if(states.some(s=>s==="unknown")||!states.includes("open"))issues.push("可规划时间：未来14天规则不完整或没有已确认的开放窗口");
    }
    if(after.status!=="active")issues.push(`开放状态：${after.status}${after.status==="paused"?"，高德标注暂停开放":"，尚未确认可正常参观"}`);
    if(after.budget_min===null||/未知|不详|未提供|未明确|未查到|估算|预估|待确认/.test(after.budget_note??""))issues.push(`费用：${after.budget_note??"缺少票价或免费依据"}`);
    else notes.push("费用沿用原来源，高德详情未提供可用于覆盖的门票字段");
    if(!after.description?.trim())issues.push("简介：缺少景点介绍");
    if(!after.suggested_duration_minutes)issues.push("建议停留时长：缺少规划参考值");
    else notes.push("建议时长沿用原值，仍需结合原provenance区分原文与估算");
    const changed_fields=Object.keys(before).filter(k=>JSON.stringify(before[k])!==JSON.stringify(after[k]));
    after.updated_at=input.asOf;
    plan.updates.push({before,after,authority});
    plan.reviews.push({id:before.id,title:after.title,amap_poi_id:after.amap_poi_id,amap_name:poi?.name??null,golden:issues.length===0,issues:[...new Set(issues)],notes,changed_fields,current:after});
  }
  return plan;
}

/** Apply a reviewed, collector-built plan to the sole database, with stale checks
 * and the same locks used by nightly collection. No activity rows are changed. */
export function applyAmapSupplement(path:string,plan:SupplementPlan,options:{batchId:string;beforeCommit?:()=>void}){
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(options.batchId)||!plan.updates.length)throw Error("INVALID_SUPPLEMENT_PLAN");
  const database=collectionDatabasePath(path),locks:{path:string;fd:number}[]=[];let db:DatabaseSync|undefined;
  try{
    for(const suffix of [".task.lock",".collection-write.lock"]){const lock=database+suffix;let fd:number;try{fd=openSync(lock,"wx");}catch{throw Error("COLLECTION_DATABASE_LOCKED");}locks.push({path:lock,fd});}
    if(createHash("sha256").update(readFileSync(database)).digest("hex")!==plan.expected_sha256)throw Error("SUPPLEMENT_BASELINE_CHANGED");
    db=new DatabaseSync(database);db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    try{
      const get=(key:string)=>JSON.parse(String(db!.prepare("SELECT value FROM _collection_metadata WHERE key=?").get(key)?.value??"null"));
      const state=get("state") as Sidecar;if(state?.schema_version!=="xian-release/2")throw Error("INVALID_SUPPLEMENT_METADATA");
      if(get("batch:"+options.batchId))throw Error("DUPLICATE_DATABASE_BATCH");
      const activityBefore=JSON.stringify(db.prepare("SELECT * FROM events WHERE record_type='activity' ORDER BY id").all());
      for(const {before,after,authority} of plan.updates){
        const current=db.prepare("SELECT * FROM events WHERE id=?").get(before.id);
        if(!current||before.record_type!=="attraction"||after.record_type!=="attraction"||after.id!==before.id||Object.keys(current).some(k=>current[k]!==before[k])||!state.events[before.id])throw Error("SUPPLEMENT_ROW_CHANGED");
        const columns=Object.keys(current).filter(k=>k!=="id");
        db.prepare(`UPDATE events SET ${columns.map(k=>`"${k}"=?`).join(",")} WHERE id=?`).run(...columns.map(k=>after[k]),before.id);
        const meta=state.events[before.id];
        meta.freshness.timeStatus=after.time_status;
        meta.freshness.confirmedStartDate=after.valid_from;meta.freshness.confirmedEndDate=after.valid_to;
        meta.window={start_at:after.start_at,end_at:after.end_at,record_type:"attraction",schedule_json:parseSchedule(after.schedule_json)};
        if(authority){
          meta.amap_authority=authority;meta.provenance.coordinates={system:"GCJ-02",source_url:authority.source_url,method:"geocoding",input_system:"GCJ-02",conversion:null};
          meta.provenance.city_evidence={source_url:authority.source_url,quote:after.address};
          meta.provenance.venue_key=`amap:${after.amap_poi_id}`;
          for(const identity of state.identities)if(identity.event_id===before.id)identity.venue_key=`amap:${after.amap_poi_id}`;
        }
      }
      if(activityBefore!==JSON.stringify(db.prepare("SELECT * FROM events WHERE record_type='activity' ORDER BY id").all()))throw Error("SUPPLEMENT_CHANGED_ACTIVITIES");
      state.batch_id=options.batchId;
      const receipt={schema_version:"amap-supplement/1",database_id:get("database_id"),batch_id:options.batchId,created_at:plan.asOf,records:plan.updates.length,before_sha256:plan.expected_sha256,changes:plan.updates};
      const put=db.prepare("INSERT INTO _collection_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
      put.run("state",JSON.stringify(state));put.run("batch:"+options.batchId,JSON.stringify(receipt));
      if(db.prepare("PRAGMA integrity_check").get()!.integrity_check!=="ok")throw Error("DATABASE_INTEGRITY_FAILED");
      options.beforeCommit?.();db.exec("COMMIT");return {batch_id:options.batchId,records:plan.updates.length,pending:plan.reviews.filter(r=>!r.golden).length};
    }catch(e){db.exec("ROLLBACK");throw e;}
  }finally{db?.close();for(const lock of locks.reverse()){closeSync(lock.fd);unlinkSync(lock.path);}}
}

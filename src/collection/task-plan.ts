import {Ajv2020} from "ajv/dist/2020.js";
import {createHash} from "node:crypto";
import {isCalendarDate} from "../itinerary/constraints.ts";
import {parseCollectionRunConfig} from "./run-config.ts";
import type {CollectionRunConfig,CollectionTarget} from "./run-config.ts";

export interface KeywordLibrary {
  schema_version:string;city:string;status:string;variables:Record<string,string>;
  area_groups:{id:string;areas:string[]}[];
  season_topics:{id:string;phrase:string;start_mmdd:string;end_mmdd:string}[];
  holiday_calendar:{enabled:boolean;date_policy:string;windows:{name:string;from:string;to:string}[];note?:string};
  groups:Record<string,{engine:string;record_type_hint:string;templates:string[]}>;
}
interface Contextual {enabled:boolean;every_n_runs:number;max_queries_per_run:1;priority:string[];seasonal_group:string;holiday_group:string;seasonal_slot?:string;holiday_slot?:string;replacement:string;}
interface Rules {strategy:"weekday_groups"|"slots";results_per_query:number;queries_per_run?:number;scope?:string;weekday_groups?:Record<string,string[]>;slots?:{id:string;groups:string[];queries_per_run:number;scope:string}[];contextual?:Contextual;}
export interface TaskEngine {name:string;enabled:boolean;search_method:"fixed_keywords"|"keyword_library"|"seed_list";limit:number;keywords?:string[];keyword_rules?:Rules;}
export interface TaskConfig {
  schema_version:"xian-collection-task/1";mode:"supplement"|"bootstrap";profile_id:string;city:"西安市";keyword_city:string;timezone:"Asia/Shanghai";
  keyword_library?:string;seed_file?:string;batch_size?:number;results_per_target?:number;
  state_file:string;engines:TaskEngine[];
  schedule:{enabled:boolean;backend:"windows_task_scheduler"|"cron"|"manual";task_name:string;poll_minutes:number;at:string;weekdays:number[];search_anchor_day_offset:number;catch_up_window_minutes:number;max_run_minutes:number};
  collection_defaults:Omit<CollectionRunConfig,"city"|"keywords"|"engines"|"base_date"|"targets">;
}
export interface SeedList {schema_version:string;city:string;targets:(CollectionTarget&{search_query:string;priority:number})[];}
export interface RotationState {runs:number;cursors:Record<string,number>;completed_seeds:string[];}
export interface CompiledTask {scheduled_date:string;anchor_date:string;config:CollectionRunConfig;next:RotationState;seed_ids:string[];}
export const initialRotation=():RotationState=>({runs:0,cursors:{},completed_seeds:[]});
const string={type:"string",minLength:1,maxLength:500};
const strings={type:"array",minItems:1,maxItems:20,items:string};
const contextual={type:"object",additionalProperties:false,required:["enabled","every_n_runs","max_queries_per_run","priority","seasonal_group","holiday_group","replacement"],properties:{enabled:{type:"boolean"},every_n_runs:{type:"integer",minimum:1,maximum:365},max_queries_per_run:{const:1},priority:{type:"array",minItems:1,maxItems:2,uniqueItems:true,items:{enum:["holiday","seasonal"]}},seasonal_group:string,holiday_group:string,seasonal_slot:string,holiday_slot:string,replacement:{enum:["replace_regular_query","round_robin_within_matching_slot"]}}};
const rules={type:"object",additionalProperties:false,required:["strategy","results_per_query"],properties:{strategy:{enum:["weekday_groups","slots"]},results_per_query:{type:"integer",minimum:1,maximum:20},queries_per_run:{type:"integer",minimum:1,maximum:10},scope:{enum:["city","rotating_area"]},weekday_groups:{type:"object",minProperties:7,maxProperties:7,propertyNames:{pattern:"^[1-7]$"},additionalProperties:strings},slots:{type:"array",minItems:1,maxItems:10,items:{type:"object",additionalProperties:false,required:["id","groups","queries_per_run","scope"],properties:{id:string,groups:strings,queries_per_run:{type:"integer",minimum:1,maximum:10},scope:{enum:["city","rotating_area"]}}}},contextual}};
const schema={type:"object",additionalProperties:false,required:["schema_version","mode","profile_id","city","keyword_city","timezone","state_file","engines","schedule","collection_defaults"],properties:{
  schema_version:{const:"xian-collection-task/1"},mode:{enum:["supplement","bootstrap"]},profile_id:{type:"string",pattern:"^[A-Za-z0-9_-]{1,60}$"},city:{const:"西安市"},keyword_city:string,timezone:{const:"Asia/Shanghai"},state_file:string,keyword_library:string,seed_file:string,batch_size:{type:"integer",minimum:1,maximum:10},results_per_target:{type:"integer",minimum:1,maximum:3},
  engines:{type:"array",minItems:1,maxItems:10,items:{type:"object",additionalProperties:false,required:["name","enabled","search_method","limit"],properties:{name:{type:"string",pattern:"^[a-z][a-z0-9_-]{0,39}$"},enabled:{type:"boolean"},search_method:{enum:["fixed_keywords","keyword_library","seed_list"]},limit:{type:"integer",minimum:1,maximum:100},keywords:strings,keyword_rules:rules}}},
  schedule:{type:"object",additionalProperties:false,required:["enabled","backend","task_name","poll_minutes","at","weekdays","search_anchor_day_offset","catch_up_window_minutes","max_run_minutes"],properties:{enabled:{type:"boolean"},backend:{enum:["windows_task_scheduler","cron","manual"]},task_name:{type:"string",pattern:"^[A-Za-z][A-Za-z0-9_-]{0,79}$"},poll_minutes:{type:"integer",minimum:1,maximum:60},at:{type:"string",pattern:"^(?:[01][0-9]|2[0-3]):[0-5][0-9]$"},weekdays:{type:"array",minItems:1,maxItems:7,uniqueItems:true,items:{type:"integer",minimum:1,maximum:7}},search_anchor_day_offset:{type:"integer",minimum:0,maximum:7},catch_up_window_minutes:{type:"integer",minimum:0,maximum:720},max_run_minutes:{type:"integer",minimum:1,maximum:120}},},
  collection_defaults:{type:"object",additionalProperties:false,required:["output_dir","publish_root","processing","budgets"],properties:{output_dir:string,publish_root:string,database_path:string,python:{type:"string",minLength:1,maxLength:2000},processing:{type:"object"},budgets:{type:"object"}}},
}};
const valid=new Ajv2020({allErrors:true}).compile(schema);
export function parseTaskConfig(input:unknown):TaskConfig {
  if(!valid(input))throw new Error("INVALID_TASK_CONFIG");
  const c=structuredClone(input) as unknown as TaskConfig;
  const names=new Set<string>();
  for(const e of c.engines){if(names.has(e.name))throw new Error("DUPLICATE_COLLECTION_ENGINE");names.add(e.name);}
  const engines=c.engines.filter(e=>e.enabled);if(!engines.length)throw new Error("NO_ENABLED_COLLECTION_ENGINE");
  if(c.mode==="bootstrap"){
    if(!c.seed_file||!c.batch_size||!c.results_per_target||engines.length!==1||engines[0].name!=="deepseek"||engines[0].search_method!=="seed_list")throw new Error("INVALID_BOOTSTRAP_CONFIG");
    if(c.batch_size*c.results_per_target>engines[0].limit)throw new Error("BOOTSTRAP_LIMIT_EXCEEDED");
    if(!c.collection_defaults.processing.enabled)throw new Error("BOOTSTRAP_REQUIRES_PROCESSING");
  }else for(const e of engines){
    if(e.search_method==="seed_list")throw new Error("SEED_LIST_REQUIRES_BOOTSTRAP");
    if(e.search_method==="fixed_keywords"&&!e.keywords?.length)throw new Error("COLLECTION_KEYWORDS_REQUIRED");
    if(e.search_method==="keyword_library"&&(!c.keyword_library||!e.keyword_rules))throw new Error("KEYWORD_RULES_REQUIRED");
  }
  // Reuse the effective-run validator for nested processing and budget fields.
  parseCollectionRunConfig({...c.collection_defaults,engines:[{name:"deepseek",keywords:["validation"],limit:1}],city:c.city});
  return c;
}
export function shiftDate(date:string,n:number){if(!isCalendarDate(date))throw new Error("INVALID_TASK_DATE");return new Date(Date.parse(date+"T12:00:00Z")+n*86400000).toISOString().slice(0,10);}
export const shanghaiDate=(instant:string)=>{if(!Number.isFinite(Date.parse(instant)))throw new Error("INVALID_TASK_CLOCK");return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date(instant));};
const weekday=(date:string)=>new Date(date+"T12:00:00Z").getUTCDay()||7;
export function dueDate(config:TaskConfig,instant:string):string|null {
  const today=shanghaiDate(instant),now=Date.parse(instant);
  for(const day of [today,shiftDate(today,-1)]){
    const at=Date.parse(`${day}T${config.schedule.at}:00+08:00`),age=(now-at)/60000;
    if(config.schedule.weekdays.includes(weekday(day))&&age>=0&&age<=config.schedule.catch_up_window_minutes)return day;
  }
  return null;
}
const pick=(state:RotationState,key:string,length:number)=>{if(!length)throw new Error("EMPTY_KEYWORD_POOL");const n=state.cursors[key]??0;state.cursors[key]=n+1;return n%length;};
function validateLibrary(value:KeywordLibrary):void {
  if(!value||value.schema_version!=="xian-keyword-library/1"||value.city!=="西安市"||!Array.isArray(value.area_groups)||!value.area_groups.length||!Array.isArray(value.season_topics)||!value.holiday_calendar||!value.groups)throw new Error("INVALID_KEYWORD_LIBRARY");
  const allowed=new Set(["city","area","year_month","weekend_range","next_weekend_range","season_topic","holiday"]);
  for(const g of Object.values(value.groups)){
    if(!g||typeof g.engine!=="string"||!Array.isArray(g.templates)||!g.templates.length)throw new Error("INVALID_KEYWORD_GROUP");
    for(const t of g.templates)if(typeof t!=="string"||!t.trim()||[...t.matchAll(/\{([^{}]+)\}/g)].some(m=>!allowed.has(m[1])))throw new Error("UNKNOWN_KEYWORD_VARIABLE");
  }
  for(const a of value.area_groups)if(!a.id||!Array.isArray(a.areas)||!a.areas.length||a.areas.some(s=>typeof s!=="string"||!s.trim()))throw new Error("INVALID_AREA_GROUP");
  for(const t of value.season_topics)if(!t.id||!t.phrase||![t.start_mmdd,t.end_mmdd].every(s=>isCalendarDate(`2000-${s}`)))throw new Error("INVALID_SEASON_WINDOW");
  for(const h of value.holiday_calendar.windows)if(!h.name||!isCalendarDate(h.from)||!isCalendarDate(h.to)||h.from>h.to)throw new Error("INVALID_HOLIDAY_WINDOW");
}
export function compileTask(c:TaskConfig,date:string,rotation:RotationState,library?:KeywordLibrary,seeds?:SeedList):CompiledTask {
  if(!isCalendarDate(date))throw new Error("INVALID_TASK_DATE");
  const next=structuredClone(rotation),anchor=shiftDate(date,c.schedule.search_anchor_day_offset),seed_ids:string[]=[];
  const targets:Record<string,CollectionTarget>={};
  const engines:CollectionRunConfig["engines"]=[];
  if(c.mode==="bootstrap"){
    if(!seeds||seeds.schema_version!=="xian-attraction-seed-plan/1"||seeds.city!==c.city||!Array.isArray(seeds.targets))throw new Error("INVALID_SEED_LIST");
    const ids=new Set<string>(),queries=new Set<string>();
    for(const t of seeds.targets){if(!t.seed_id||ids.has(t.seed_id)||!t.name?.trim()||!Array.isArray(t.aliases)||!Number.isInteger(t.priority)||typeof t.search_query!=="string"||!t.search_query.trim()||queries.has(t.search_query))throw new Error("INVALID_SEED_TARGET");ids.add(t.seed_id);queries.add(t.search_query);}
    const selected=seeds.targets.filter(t=>!next.completed_seeds.includes(t.seed_id)).sort((a,b)=>a.priority-b.priority||a.seed_id.localeCompare(b.seed_id)).slice(0,c.batch_size);
    if(!selected.length)throw new Error("BOOTSTRAP_COMPLETE");
    for(const t of selected){seed_ids.push(t.seed_id);targets[t.search_query]={seed_id:t.seed_id,name:t.name,aliases:[...t.aliases],area_hint:t.area_hint};}
    engines.push({name:"deepseek",enabled:true,keywords:selected.map(t=>t.search_query),limit:selected.length*c.results_per_target!});
  }else{
    if(c.engines.some(e=>e.enabled&&e.search_method==="keyword_library"))validateLibrary(library!);
    for(const e of c.engines.filter(e=>e.enabled)){
      if(e.search_method==="fixed_keywords"){engines.push({name:e.name,enabled:true,limit:e.limit,keywords:e.keywords});continue;}
      const lib=library!,r=e.keyword_rules!,slots:{id:string;group:string;scope:string}[]=[];
      const group=(id:string)=>{const g=lib.groups[id];if(!g||g.engine!==e.name)throw new Error("INVALID_ENGINE_GROUP_REFERENCE");return g;};
      const lists=[...Object.values(r.weekday_groups??{}),...(r.slots??[]).map(s=>s.groups)];for(const list of lists)for(const id of list)group(id);
      const context=r.contextual;if(context){group(context.seasonal_group);group(context.holiday_group);}
      if(r.strategy==="weekday_groups"){
        const list=r.weekday_groups?.[String(weekday(date))];if(!list?.length||!r.queries_per_run)throw new Error("INVALID_WEEKDAY_RULES");
        for(let i=0;i<r.queries_per_run;i++)slots.push({id:"weekday",group:list[pick(next,`${e.name}:weekday:${weekday(date)}`,list.length)],scope:r.scope??"city"});
      }else{
        if(!r.slots?.length||new Set(r.slots.map(s=>s.id)).size!==r.slots.length)throw new Error("INVALID_SLOTS");
        for(const s of r.slots)for(let i=0;i<s.queries_per_run;i++)slots.push({id:s.id,group:s.groups[pick(next,`${e.name}:slot:${s.id}`,s.groups.length)],scope:s.scope});
      }
      const vars:Record<string,string>={city:c.keyword_city,area:"",year_month:`${anchor.slice(0,4)}年${Number(anchor.slice(5,7))}月`,season_topic:"",holiday:""};
      const saturday=shiftDate(anchor,weekday(anchor)===7?-1:6-weekday(anchor));
      const range=(start:string,end:string)=>{const f=(s:string)=>`${s.slice(0,4)!==anchor.slice(0,4)?s.slice(0,4)+"年":""}${Number(s.slice(5,7))}月${Number(s.slice(8,10))}日`;return start===end?f(start):`${f(start)}—${f(end)}`;};
      vars.weekend_range=range(anchor>saturday?anchor:saturday,shiftDate(saturday,1));vars.next_weekend_range=range(shiftDate(saturday,7),shiftDate(saturday,8));
      if(context?.enabled&&(next.runs+1)%context.every_n_runs===0){
        const mmdd=anchor.slice(5),topics=lib.season_topics.filter(t=>t.start_mmdd<=t.end_mmdd?mmdd>=t.start_mmdd&&mmdd<=t.end_mmdd:mmdd>=t.start_mmdd||mmdd<=t.end_mmdd);
        const holidays=lib.holiday_calendar.enabled?lib.holiday_calendar.windows.filter(h=>anchor>=h.from&&anchor<=h.to):[];
        for(const kind of context.priority){
          const available=kind==="holiday"?holidays:topics;if(!available.length)continue;
          const slotId=kind==="holiday"?context.holiday_slot:context.seasonal_slot;
          const indexes=slots.flatMap((s,i)=>!slotId||s.id===slotId?[i]:[]);if(!indexes.length)throw new Error("INVALID_CONTEXT_SLOT");
          const i=indexes[pick(next,`${e.name}:replace:${kind}`,indexes.length)];slots[i].group=kind==="holiday"?context.holiday_group:context.seasonal_group;
          if(kind==="holiday")vars.holiday=holidays[pick(next,`${e.name}:holiday`,holidays.length)].name;else vars.season_topic=topics[pick(next,`${e.name}:season`,topics.length)].phrase;
          break;
        }
      }
      const words:string[]=[];let regionalIndex=0;
      const areaStart=slots.some(s=>s.scope==="rotating_area")?pick(next,`${e.name}:area_group`,lib.area_groups.length):0;
      for(const s of slots){
        if(s.scope==="rotating_area"){
          const a=lib.area_groups[(areaStart+regionalIndex++)%lib.area_groups.length];vars.area=a.areas[pick(next,`${e.name}:area:${a.id}`,a.areas.length)];
        }else vars.area="";
        const g=group(s.group);let word="";
        for(let attempt=0;attempt<g.templates.length;attempt++){
          word=g.templates[pick(next,`${e.name}:template:${s.group}`,g.templates.length)].replace(/\{([^{}]+)\}/g,(_,key)=>vars[key]).replace(/\s+/g," ").trim();
          if(!words.includes(word))break;
        }
        if(!word||word.length>100||/[{}]/.test(word)||words.includes(word))throw new Error("INVALID_RENDERED_KEYWORD");words.push(word);
      }
      const limit=words.length*r.results_per_query;if(limit>e.limit)throw new Error("TASK_QUERY_LIMIT_EXCEEDED");
      engines.push({name:e.name,enabled:true,limit,keywords:words});
    }
  }
  next.runs++;
  const config=parseCollectionRunConfig({...c.collection_defaults,city:c.city,engines,base_date:date,...(seed_ids.length?{targets}:{})});
  return {scheduled_date:date,anchor_date:anchor,config,next,seed_ids};
}
export const planFingerprint=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");

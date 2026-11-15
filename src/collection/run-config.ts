import {Ajv2020} from "ajv/dist/2020.js";
import {isCalendarDate} from "../itinerary/constraints.ts";

export interface CollectionEngineConfig {name:string;enabled:boolean;limit:number;keywords?:string[];}
export interface CollectionRunConfig {
  python?:string;
  city:"西安市";keywords:string[];engines:CollectionEngineConfig[];output_dir:string;publish_root?:string;database_path?:string;base_date?:string;
  processing:{enabled:boolean;ocr:boolean;ocr_max_images?:number;attraction_duplicate_meters:number};
  budgets:{model_requests:number;map_requests:number;level_searches:number};
  targets?: Record<string, CollectionTarget>;
}
export interface CollectionTarget {seed_id:string;name:string;aliases:string[];area_hint:string;}
const keywords={type:"array",minItems:1,maxItems:10,uniqueItems:true,items:{type:"string",minLength:1,maxLength:100}};
const schema={type:"object",additionalProperties:false,required:["engines","output_dir"],properties:{
  python:{type:"string",minLength:1,maxLength:2000},
  city:{const:"西安市"},keywords,output_dir:{type:"string",minLength:1},publish_root:{type:"string",minLength:1},database_path:{type:"string",minLength:1},base_date:{type:"string"},
  engines:{type:"array",minItems:1,maxItems:10,items:{type:"object",additionalProperties:false,required:["name"],properties:{name:{type:"string",pattern:"^[a-z][a-z0-9_-]{0,39}$"},enabled:{type:"boolean"},limit:{type:"integer",minimum:1,maximum:100},keywords}}},
  processing:{type:"object",additionalProperties:false,properties:{enabled:{type:"boolean"},ocr:{type:"boolean"},ocr_max_images:{type:"integer",minimum:1,maximum:20},attraction_duplicate_meters:{type:"number",minimum:0,maximum:100}}},
  budgets:{type:"object",additionalProperties:false,properties:{model_requests:{type:"integer",minimum:1,maximum:200},map_requests:{type:"integer",minimum:1,maximum:200},level_searches:{type:"integer",minimum:0,maximum:100}}},
  targets:{type:"object",maxProperties:10,additionalProperties:{type:"object",additionalProperties:false,required:["seed_id","name","aliases","area_hint"],properties:{seed_id:{type:"string",minLength:1,maxLength:80},name:{type:"string",minLength:1,maxLength:150},aliases:{type:"array",maxItems:20,items:{type:"string",minLength:1,maxLength:150}},area_hint:{type:"string",maxLength:200}}}},
}};
const validate=new Ajv2020({allErrors:true}).compile(schema);
/** Config files contain business parameters, never keys, cookies or endpoints. */
export function parseCollectionRunConfig(input:unknown):CollectionRunConfig {
  if(!validate(input))throw new Error("INVALID_COLLECTION_RUN_CONFIG");
  const value=structuredClone(input) as any;
  if(value.python!==undefined&&(!value.python.trim()||/[\r\n\x00]/.test(value.python)))throw new Error("INVALID_COLLECTION_PYTHON");
  value.city??="西安市";value.keywords??=[];
  value.processing={enabled:true,ocr:true,ocr_max_images:10,attraction_duplicate_meters:10,...value.processing};
  if(value.processing.enabled)value.database_path??="data/events.db";
  value.budgets={model_requests:80,map_requests:60,level_searches:10,...value.budgets};
  const names=new Set<string>();let enabled=0;
  for(const engine of value.engines){
    if(names.has(engine.name))throw new Error("DUPLICATE_COLLECTION_ENGINE");names.add(engine.name);
    engine.enabled??=true;engine.limit??=5;
    const words=engine.keywords??value.keywords;
    if(words.some((s:string)=>!s.trim()))throw new Error("EMPTY_COLLECTION_KEYWORD");
    if(engine.enabled){enabled++;if(!words.length)throw new Error("COLLECTION_KEYWORDS_REQUIRED");}
  }
  if(!enabled)throw new Error("NO_ENABLED_COLLECTION_ENGINE");
  if(value.base_date&&!isCalendarDate(value.base_date))throw new Error("INVALID_COLLECTION_BASE_DATE");
  if(value.publish_root&&!value.processing.enabled)throw new Error("PUBLISH_REQUIRES_PROCESSING");
  if(value.targets){
    const words=new Set(value.engines.filter((e:any)=>e.enabled).flatMap((e:any)=>e.keywords??value.keywords));
    if(Object.keys(value.targets).some(k=>!words.has(k)))throw new Error("TARGET_KEYWORD_NOT_IN_PLAN");
    if(value.engines.some((e:any)=>e.enabled&&e.name!=="deepseek"))throw new Error("BOOTSTRAP_REQUIRES_DEEPSEEK_ONLY");
  }
  return value;
}

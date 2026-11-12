import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { Ajv2020 } from "ajv/dist/2020.js";
import { isCalendarDate } from "../itinerary/constraints.ts";
import { eventId } from "./identity.ts";
import { datasetSchema } from "./contracts.ts";
import type { RealDataset, ValidationIssue, ValidationReport } from "./types.ts";
const ajv=new Ajv2020({allErrors:true});
const structural=ajv.compile(datasetSchema);
export interface SourceDocument { url: string; text: string; }
export interface ValidationOptions { asOf: string; documents: ReadonlyMap<string,SourceDocument>; }
const sha=(text:string)=>createHash("sha256").update(text).digest("hex");
const secret=/\bsk-(?:qovia-)?[A-Za-z0-9_-]{16,}|(?:api[_-]?key|authorization)\s*[=:]\s*["']?[A-Za-z0-9_-]{16,}/i;
/** Lexical public-URL check only. No network request is made; a fetcher must separately
 * validate DNS results and redirects to protect against SSRF/rebinding.
 */
export function publicUrl(value: string): boolean {
 try {const u=new URL(value);const host=u.hostname.replace(/^\[|\]$/g,"");
  if(!["http:","https:"].includes(u.protocol)||u.username||u.password||!host.includes(".")||isIP(host)||/^example\.(?:com|org|net)$/.test(host)||/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host))return false;
  return ![...u.searchParams.keys()].some(k=>/^(?:api[_-]?key|key|authorization|access_token|xsec_token|cookie|secret)$/i.test(k));
 } catch{return false;}
}
function localTime(value:string):number {
 if(!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)||!isCalendarDate(value.slice(0,10)))return NaN;
 return Date.parse(value+":00+08:00");
}
export function validateDataset(value:unknown,options:ValidationOptions):ValidationReport {
 const issues:ValidationIssue[]=[],stats:ValidationReport["stats"]={slots:0,projects:0,venues:0,categories:{},dates:{}};
 const issue=(code:string,event_id?:string,field?:string)=>issues.push({code,...(event_id?{event_id}:{}),...(field?{field}:{})});
 if(!structural(value)){for(const error of structural.errors??[])issue("SCHEMA_INVALID",undefined,error.instancePath);return {valid:false,issues,stats};}
 const data=value as RealDataset;
 if(secret.test(JSON.stringify(data)))issue("POSSIBLE_SECRET");
 if(!isCalendarDate(data.base_date))issue("INVALID_BASE_DATE");
 const asOf=Date.parse(options.asOf);
 if(!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(options.asOf)||!isCalendarDate(options.asOf.slice(0,10))||!Number.isFinite(asOf))issue("INVALID_AS_OF");
 const from=localTime(data.base_date+"T00:00"),until=from+data.days*86400000;
 const provenance=new Map(data.provenance.map(p=>[p.event_id,p]));
 if(provenance.size!==data.provenance.length)issue("DUPLICATE_PROVENANCE");
 const ids=new Set<string>(),slots=new Set<string>(),projects=new Set<string>(),venues=new Set<string>();
 for(const e of data.events){
  ids.add(e.id);stats.slots++;stats.categories[e.category]=(stats.categories[e.category]??0)+1;const date=e.start_at?.slice(0,10)??"unknown";stats.dates[date]=(stats.dates[date]??0)+1;
  const p=provenance.get(e.id);if(!p){issue("MISSING_PROVENANCE",e.id);continue;}
  projects.add(p.source_event_key);venues.add(p.venue_key);
  for(const [key,text] of Object.entries(e))if(typeof text==="string"&&text.trim().length===0)issue("BLANK_FIELD",e.id,key);
  if(/模拟|虚构|mock|fixture|example/i.test([e.title,e.description,e.venue_name,e.address].join(" ")))issue("SYNTHETIC_CONTENT",e.id);
  const start=e.start_at===null?NaN:localTime(e.start_at),end=e.end_at===null?NaN:localTime(e.end_at);
  if(e.start_at!==null&&!Number.isFinite(start)||e.end_at!==null&&!Number.isFinite(end)||Number.isFinite(start)&&Number.isFinite(end)&&(end<=start||end-start>86400000))issue("INVALID_SLOT",e.id);
  if(start<from||end>until)issue("OUTSIDE_BATCH",e.id);
  if(end<=asOf)issue("ALREADY_ENDED",e.id);
  if(e.suggested_duration_minutes!==null&&e.suggested_duration_minutes>(end-start)/60000)issue("DURATION_EXCEEDS_WINDOW",e.id);
  if(p.schedule_type==="fixed"&&e.suggested_duration_minutes!==null&&Number.isFinite(start)&&Number.isFinite(end)&&(e.suggested_duration_minutes!==(end-start)/60000||p.duration_basis!=="source"))issue("FIXED_DURATION_UNCONFIRMED",e.id);
  if(e.budget_min!==null&&e.budget_max!==null&&e.budget_min>e.budget_max)issue("INVALID_BUDGET_RANGE",e.id);
  if(e.id!==eventId(p.source_event_key,p.venue_key,p.slot_key))issue("UNSTABLE_ID",e.id);
  const slot=JSON.stringify([p.source_event_key,p.venue_key,p.slot_key]);if(slots.has(slot))issue("DUPLICATE_SLOT",e.id);slots.add(slot);
  if ((e.suggested_duration_minutes === null) !== (p.duration_basis === "unknown")) issue("DURATION_BASIS_MISMATCH", e.id);
  const verified=Date.parse(p.verified_at);
  if(!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(p.verified_at)||!isCalendarDate(p.verified_at.slice(0,10))||!Number.isFinite(verified)||verified>asOf||asOf-verified>36*3600000)issue("INVALID_VERIFICATION_TIME",e.id);
  // A coarse mainland check catches obvious Shanghai/wrong-axis data. City evidence
  // and the geocoder's administrative match remain mandatory; this is not a boundary polygon.
  if(e.latitude<33||e.latitude>35.5||e.longitude<107||e.longitude>110.5)issue("COORDINATE_OUTSIDE_COARSE_REGION",e.id);
  if(!p.city_evidence.quote.includes("西安")||!e.address.includes("西安"))issue("CITY_NOT_CONFIRMED",e.id);
  if(p.coordinates.input_system!=="WGS-84"&&!p.coordinates.conversion?.trim())issue("COORDINATE_CONVERSION_MISSING",e.id);
  if(e.guide_url!==null&&e.guide_url!==p.source_url)issue("SOURCE_URL_MISMATCH",e.id,"guide_url");
  const urls=[p.source_url,p.city_evidence.source_url,p.coordinates.source_url,...p.evidence.map(x=>x.source_url),...e.image_urls,...(e.thumbnail_url?[e.thumbnail_url]:[]),...(e.guide_url!==null?[e.guide_url]:[])];
  if(urls.some(u=>!publicUrl(u)))issue("INVALID_PUBLIC_URL",e.id);
  for(const ev of p.evidence){const doc=options.documents.get(ev.document_sha256);
   if(!doc||doc.url!==ev.source_url||sha(doc.text)!==ev.document_sha256)issue("EVIDENCE_NOT_FOUND",e.id,ev.field);
  }
  const documents=[...options.documents.values()];
  if(!documents.some(d=>d.url===p.city_evidence.source_url))issue("CITY_EVIDENCE_NOT_FOUND",e.id);
 }
 if(ids.size!==data.events.length)issue("DUPLICATE_EVENT_ID");
 if(data.provenance.some(p=>!ids.has(p.event_id)))issue("ORPHAN_PROVENANCE");
 stats.projects=projects.size;stats.venues=venues.size;
 return {valid:issues.length===0,issues,stats};
}

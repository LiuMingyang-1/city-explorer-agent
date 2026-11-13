import { mkdirSync,readFileSync,writeFileSync,existsSync } from "node:fs";
import { resolve,join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { collectionCredentials } from "../src/collection/config.ts";
import { createPilotApi,redact,PilotApiError } from "../src/collection/pilot-api.ts";
import type { Attempt } from "../src/collection/pilot-api.ts";
import { documentsFrom,checkCandidate,EXTRACTION_PROMPT } from "../src/collection/pilot-extract.ts";
import type { PilotDocument } from "../src/collection/pilot-extract.ts";
import { isCalendarDate } from "../src/itinerary/constraints.ts";
const QUERIES=["西安 展览","西安 演出","西安 市集","西安 读书会","西安 工作坊"];
const code=(e:unknown)=>e instanceof PilotApiError?e.code:"LOCAL_PROCESSING_ERROR";
export function latencySummary(attempts:Attempt[]){
 return ["qovia","deepseek"].map(provider=>{
  const rows=attempts.filter(a=>a.provider===provider&&a.operation==="search"),values=rows.map(a=>a.elapsed_ms).sort((a,b)=>a-b);
  const percentile=(p:number)=>values.length?values[Math.ceil(values.length*p)-1]:null;
  return {provider,attempts:rows.length,success:rows.filter(a=>a.code==="OK").length,p50_ms:percentile(.5),p95_ms:percentile(.95),max_ms:values.at(-1)??null,samples:rows.map(a=>({query:a.query,code:a.code,http_status:a.http_status,elapsed_ms:a.elapsed_ms,bytes:a.bytes}))};
 });
}
async function main(){
 process.loadEnvFile(resolve(".env"));
 const credentials=collectionCredentials();const secrets=[credentials.deepseekKey];
 const args=process.argv.slice(2),get=(key:string)=>args.find(a=>a.startsWith(`--${key}=`))?.slice(key.length+3);
 if(args.some(a=>!/^--(?:date|run|extract-url)=.+$/.test(a)&&!["--smoke","--search-only","--recheck"].includes(a)))throw new Error("INVALID_PILOT_ARGUMENTS");
 const recheck=args.includes("--recheck"),requestedUrls=args.filter(a=>a.startsWith("--extract-url=")).map(a=>a.slice(14));
 if(recheck&&(!requestedUrls.length||requestedUrls.length>2)||requestedUrls.length&&!recheck)throw new Error("RECHECK_REQUIRES_ONE_OR_TWO_CACHED_URLS");
 const base=get("date");if(!base||!isCalendarDate(base))throw new Error("PILOT_DATE_REQUIRED");
 const run=get("run")??`pilot-${base}-${Date.now()}`;if(!/^[a-zA-Z0-9_-]{1,100}$/.test(run))throw new Error("INVALID_RUN_NAME");
 const dir=resolve(".local-data/xian",run);mkdirSync(dir,{recursive:true});
 const save=(name:string,value:unknown)=>writeFileSync(join(dir,name),JSON.stringify(redact(value,secrets),null,2)+"\n");
 const until=base,since=new Date(Date.parse(base+"T00:00:00Z")-29*86400000).toISOString().slice(0,10);
 const attempts:Attempt[]=[];let activeName="";
 const api=createPilotApi({...credentials,record(a){attempts.push(a);save(activeName,a);console.log(JSON.stringify({provider:a.provider,operation:a.operation,code:a.code,http_status:a.http_status,elapsed_ms:a.elapsed_ms,bytes:a.bytes}));},searchLimit:10,extractLimit:5});
 const documents:PilotDocument[]=[];const disabled=new Set<string>();
 const queryCount=args.includes("--smoke")?1:5;
 for(let i=0;i<queryCount;i++)for(const provider of ["deepseek"] as const){
  activeName=`${provider}-search-${i}.json`;
  let attempt:Attempt;
  if(existsSync(join(dir,activeName))){attempt=JSON.parse(readFileSync(join(dir,activeName),"utf8"));attempts.push(attempt);}
  else {
   if(disabled.has(provider))continue;
   try{await api.search(provider,provider==="deepseek"?`${QUERIES[i]} ${base.slice(0,4)}年${Number(base.slice(5,7))}月`:QUERIES[i],since,until);}
   catch(e){console.log(JSON.stringify({provider,error:code(e)}));}
   const last=attempts.at(-1);if(!last||last.provider!==provider)continue;attempt=last;
  }
  if(["AUTH_FAILED","INSUFFICIENT_BALANCE","HTTP_404","HTTP_400"].includes(attempt.code))disabled.add(provider);
  if(attempt.code==="OK")try{documents.push(...documentsFrom(provider,attempt.response,QUERIES[i]));}catch{console.log(JSON.stringify({provider,error:"UNRECOGNIZED_SEARCH_RESPONSE"}));}
 }
 const unique=[...new Map(documents.map(d=>[d.url,d])).values()];save("documents.json",unique);
 const checks:any[]=[];
 if(!args.includes("--search-only")){
  const ranked=unique.map(d=>({d,score:(d.text.includes("2026")?3:0)+(d.text.includes("11月")||d.text.includes("2026-11")?3:0)+(d.content_kind==="content"?2:0)+Math.min(2,d.text.length/2000)})).sort((a,b)=>b.score-a.score);
  // Diversify by provider and query before filling the remaining pilot quota.
  const selected:PilotDocument[]=[];for(const provider of ["deepseek"]) {const match=ranked.find(x=>x.d.provider===provider);if(match)selected.push(match.d);}
  for(const {d} of ranked)if(selected.length<5&&!selected.some(x=>x.url===d.url)&&!selected.some(x=>x.query===d.query))selected.push(d);
  for(const {d} of ranked)if(selected.length<5&&!selected.some(x=>x.url===d.url))selected.push(d);
  if(recheck){selected.length=0;for(const url of requestedUrls){const d=unique.find(d=>d.url===url);if(!d)throw new Error("RECHECK_DOCUMENT_NOT_CACHED");selected.push(d);}}
  for(let i=0;i<selected.length;i++){
   const doc=selected[i];activeName=`deepseek-${recheck?"recheck":"extract"}-${createHash("sha256").update(doc.url).digest("hex").slice(0,16)}.json`;
   let raw:any;
   if(existsSync(join(dir,activeName))){const a=JSON.parse(readFileSync(join(dir,activeName),"utf8")) as Attempt;attempts.push(a);if(a.code!=="OK"){checks.push({url:doc.url,error:a.code});continue;}raw=a.response;}
   else try{raw=await api.extract(credentials.extractionModel,EXTRACTION_PROMPT,{target_start:base,target_end:new Date(Date.parse(base+"T00:00:00Z")+13*86400000).toISOString().slice(0,10),source_url:doc.url,content_kind:doc.content_kind,published_at:doc.published_at,text:doc.text.slice(0,18000)});}catch(e){checks.push({url:doc.url,error:code(e)});if(["AUTH_FAILED","INSUFFICIENT_BALANCE","HTTP_400","HTTP_404"].includes(code(e)))break;continue;}
   try {
    if(raw?.choices?.[0]?.finish_reason!=="stop")throw new Error("TRUNCATED_MODEL_RESPONSE");
    const content=raw.choices[0].message.content,parsed=JSON.parse(content);
    if(!Array.isArray(parsed.activities)||parsed.activities.length>3)throw new Error("INVALID_EXTRACTION_SCHEMA");
    const docInput={...doc,text:doc.text.slice(0,18000)};
    checks.push({url:doc.url,provider:doc.provider,content_kind:doc.content_kind,title:doc.title,activities:parsed.activities.map((candidate:any)=>({fields:{...candidate,id:null,guide_url:null,source_url:doc.url},check:checkCandidate(candidate,docInput,base)}))});
   }catch{checks.push({url:doc.url,error:"INVALID_MODEL_OUTPUT"});}
  }
 }
 save(recheck?"extractions-recheck.json":"extractions.json",checks);
 const report={base_date:base,days:14,scope:"pilot_only_no_database_write",model:credentials.extractionModel,search_latency:latencySummary(attempts),search_attempts:attempts.filter(a=>a.operation==="search").length,unique_documents:unique.length,document_providers:unique.reduce((n,d)=>(n[d.provider]=(n[d.provider]??0)+1,n),{} as Record<string,number>),extraction_documents:checks.length,extraction_attempts:attempts.filter(a=>a.operation==="extract").length,candidate_activities:checks.reduce((n,c)=>n+(c.activities?.length??0),0),schema_valid_candidates:checks.flatMap(c=>c.activities??[]).filter(a=>a.check.schema_valid).length,publication_approved:0,issues:checks.flatMap(c=>c.error?[c.error]:(c.activities??[]).flatMap((a:any)=>a.check.issues)),measured_at:new Date().toISOString()};
 save(recheck?"report-recheck.json":"report.json",report);console.log(JSON.stringify({output_dir:dir,unique_documents:unique.length,candidate_activities:report.candidate_activities,publication_approved:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error instanceof Error&&/^(?:MISSING|INVALID)_COLLECTION_CONFIG:/.test(error.message)?error.message:"PILOT_FAILED_SEE_LOCAL_REPORT");process.exitCode=1;});

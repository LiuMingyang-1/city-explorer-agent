/** Explicit live acceptance runner: five cached XHS posts + five new web docs.
 * All outputs are private. It never opens the production database for writing. */
import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import {resolve,relative,isAbsolute} from "node:path";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import assert from "node:assert/strict";
import {collectionCredentials,geocodingKey} from "../src/collection/config.ts";
import {cachedXhsDocuments} from "../src/collection/cached-input.ts";
import {createPilotApi,redact} from "../src/collection/pilot-api.ts";
import {documentsFrom} from "../src/collection/pilot-extract.ts";
import {createToolAnalysisExtractor,createAmapSearch} from "../src/collection/analysis-model.ts";
import {createLocalOcr} from "../src/collection/ocr.ts";
import {processCollection} from "../src/collection/pipeline.ts";
import {extractActivities} from "../src/collection/extraction.ts";
import type {ExtractionDocument} from "../src/collection/extraction.ts";
import {publishRelease,inspectRelease} from "../src/collection/releases.ts";

const [input,output]=process.argv.slice(2);
const privatePath=(p:string)=>{const full=resolve(p),child=relative(resolve(".local-data"),full);if(!child||child.startsWith("..")||isAbsolute(child))throw new Error("PATH_MUST_BE_PRIVATE");return full;};
if(!input||!output)throw new Error("Usage: node scripts/test-collection-sample.ts .local-data/input.json .local-data/new-output");
const root=privatePath(output);privatePath(input);mkdirSync(root);
process.loadEnvFile(".env");const credentials=collectionCredentials(),key=geocodingKey();
const save=(name:string,data:unknown)=>writeFileSync(`${root}/${name}`,JSON.stringify(redact(data,[credentials.deepseekKey,key]),null,2)+"\n");
const prodHash=()=>existsSync("data/events.db")?createHash("sha256").update(readFileSync("data/events.db")).digest("hex"):null;const before=prodHash();
const date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date());
const xhs=cachedXhsDocuments(JSON.parse(readFileSync(input,"utf8"))).slice(0,5);assert.equal(xhs.length,5);
let searchNo=0,attemptNo=0,active="",raw="",ocrText="";
const attempts:any[]=[],mapRequests:any[]=[],rows:any[]=[],empty:any[]=[],stats:any={},databases:any[]=[];
const search=createPilotApi({...credentials,searchLimit:5,extractLimit:0,searchResultCount:3,record:a=>{save(`search-${++searchNo}.json`,a);attempts.push({stage:"search",elapsed_ms:a.elapsed_ms,code:a.code});}});
const web:ExtractionDocument[]=[];const seen=new Set<string>();
const oldPath=".local-data/xian/runs/new-five-each-20261112/web-selected.json";
if(existsSync(oldPath))for(const d of JSON.parse(readFileSync(oldPath,"utf8")))seen.add(d.url);
const start=Date.now();
for(const query of ["西安 大雁塔北广场 音乐喷泉 开放时间","西安 兴庆宫公园 开放时间 游览","西安 2026年11月 免费 展览","西安 2026年11月 周末 市集 活动","西安 2026年11月 音乐会 演出"]){
  const data=await search.search("deepseek",query,date,date);
  const d=documentsFrom("deepseek",data,query).find(d=>!seen.has(d.url));
  if(!d)throw new Error("NOT_ENOUGH_UNIQUE_WEB_RESULTS");seen.add(d.url);
  web.push({url:d.url,text:d.text.slice(0,30000),published_at:d.published_at&&Number.isFinite(Date.parse(d.published_at))?new Date(d.published_at).toISOString():null,fetched_at:new Date().toISOString(),authority:"unverified",content_scope:d.content_kind==="content"?"exported_text":"excerpt",image_urls:[]});
}
const searchMs=Date.now()-start;save("web-documents.json",web);
const map=createAmapSearch({key,requestLimit:60,onRequest:e=>mapRequests.push({document:active,...e})});
const invoke=createToolAnalysisExtractor({...credentials,model:credentials.extractionModel,map,extractLimit:80,searchLimit:0,record:a=>{
  save(`analysis-${++attemptNo}.json`,a);attempts.push({stage:"analysis",document:active,elapsed_ms:a.elapsed_ms,code:a.code});
  const message=(a.response as any)?.choices?.[0]?.message;if(typeof message?.content==="string"&&!message.tool_calls?.length)raw=message.content.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"");
}});
const ocr=createLocalOcr({python:resolve(".local-data/tools/mediacrawler-venv/Scripts/python.exe"),record:(url,r)=>{save(`ocr-${active}.json`,{url,...r});ocrText=r.pages.map(p=>`【图片${p.image}】\n${p.text}`).join("\n\n");}});
const processingStart=Date.now();
for(const [provider,docs] of [["xiaohongshu",xhs],["deepseek_web",web]] as const){
  const t=Date.now();let accepted=0,rejected=0,candidates=0,emptyCount=0;
  for(let index=0;index<docs.length;index++){
    active=`${provider}-${index+1}`;raw="";ocrText="";const doc=docs[index],asOf=new Date().toISOString(),started=Date.now();
    const result=await processCollection([{document:doc}],{asOf,baseDate:date,now:()=>new Date().toISOString(),invoke,ocr:provider==="xiaohongshu"?ocr:undefined,modelBudget:2,eventLimit:3,geocoder:{resolve:async()=>{throw new Error("UNEXPECTED_MECHANICAL_GEOCODING");}}});
    const merged=ocrText?{...doc,text:(doc.text.slice(0,15000)+"\n\n【图片OCR，可能存在识别错误】\n"+ocrText.slice(0,14000)).slice(0,30000)}:doc;
    const extracted=raw?await extractActivities(merged,{asOf:new Date().toISOString(),structured:JSON.parse(raw)}):{activities:[]};
    save(`result-${active}.json`,{dataset:result.prepared.dataset,rejected:result.rejected,deduplicated:result.deduplicated,metrics:result.metrics});
    let database:string|null=null;
    if(result.prepared.dataset.events.length){
      const folder=`${root}/release-${active}`;await publishRelease(folder,result.prepared,{batchId:"sample",asOf:new Date().toISOString()});database=inspectRelease(folder).database;
      const db=new DatabaseSync(database,{readOnly:true});try{
        assert.equal(db.prepare("PRAGMA table_info(events)").all().length,31);
        assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check,"ok");
        for(const event of result.prepared.dataset.events){const stored=db.prepare("SELECT * FROM events WHERE id=?").get(event.id)!;
          for(const [field,v] of Object.entries(event))assert.equal(stored[field],field==="image_urls"||field==="schedule_json"&&v!==null?JSON.stringify(v):v);
        }
      }finally{db.close();}databases.push({document:active,path:database,count:result.prepared.dataset.events.length});
    }
    let failIndex=0;
    for(const {facts:f} of extracted.activities){
      const e=result.prepared.dataset.events.find(e=>e.title===f.title),reasons=e?[]:result.rejected[failIndex++]?.reasons??["NOT_ACCEPTED"];
      rows.push({provider,document:index+1,source_url:doc.url,accepted:!!e,reasons,event:e??f,database:e?database:null});
    }
    if(!extracted.activities.length){emptyCount++;empty.push({document:active,source_url:doc.url,reasons:result.rejected,ocr_errors:result.metrics.ocr_errors});}
    accepted+=result.prepared.dataset.events.length;rejected+=result.rejected.length;candidates+=extracted.activities.length;
    console.log(JSON.stringify({document:active,accepted:result.prepared.dataset.events.length,rejected:result.rejected,candidates:extracted.activities.length,elapsed_ms:Date.now()-started,ocr_errors:result.metrics.ocr_errors}));
    save("progress.json",{rows,empty,attempts,mapRequests});
  }
  stats[provider]={documents:docs.length,candidates,accepted,rejected,empty:emptyCount,processing_ms:Date.now()-t};
}
assert.equal(prodHash(),before);
const accepted=rows.filter(r=>r.accepted).map(r=>{const {start_at,end_at,...business}=r.event;return business;});
save("accepted-events.json",accepted);save("all-candidates.json",rows);save("empty-documents.json",empty);save("sample-databases.json",databases);
save("summary.json",{date,...stats,web_search_ms:searchMs,processing_ms:Date.now()-processingStart,total_ms:Date.now()-start,model_http_requests:attempts.filter(a=>a.stage==="analysis").length,attempts,mapRequests,production_database_unchanged:true});
const reasonsZh:Record<string,string>={MODEL_LOCATION_NOT_BOUND:"模型没有选中本轮高德工具返回的地点，或返回坐标与该地点不一致",NOT_ACTIVE:"活动明确已结束、取消或暂停",ALREADY_ENDED:"已确认的最后日期或场次已经结束",INVALID_EXTRACTION_SCHEMA:"模型结果不是约定的JSON字段结构",INVALID_PUBLICATION_TIME:"来源发布时间晚于本次处理时间或格式不合法"};
const esc=(v:unknown)=>String(v??"NULL").replaceAll("|","\\|").replaceAll("\n","<br>");
let md=`# 正文＋OCR＋高德工具：真实样本\n\n日期：${date}。费用单位分；坐标GCJ-02。通过表示程序校验通过，不代表每个来源事实经过独立核实。\n\n`;
for(const [i,r]of rows.entries()){
  md+=`## ${i+1}. ${r.event.title}（${r.provider}，${r.accepted?"保留":"未保留"}）\n\n来源：${r.source_url}\n\n原因：${r.accepted?"通过字段、时间降级及高德工具结果绑定校验":r.reasons.map((c:string)=>reasonsZh[c]??c).join("；")}\n\n| 字段 | 值 |\n| --- | --- |\n`;
  const {start_at,end_at,...fields}=r.event;for(const[k,v]of Object.entries(fields))md+=`| ${k} | ${esc(typeof v==="object"&&v!==null?JSON.stringify(v):v)} |\n`;md+="\n";
}
md+="## 未提取出对象的文档\n\n"+JSON.stringify(empty,null,2);writeFileSync(`${root}/preview.md`,md);
console.log(JSON.stringify({summary:stats,accepted:accepted.length,model_http_requests:attemptNo,map_requests:mapRequests.length,production_database_unchanged:true}));

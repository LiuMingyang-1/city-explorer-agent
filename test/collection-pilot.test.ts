import {test} from "node:test";
import assert from "node:assert/strict";
import {createPilotApi,redact} from "../src/collection/pilot-api.ts";
import type {Attempt} from "../src/collection/pilot-api.ts";
import {documentsFrom,checkCandidate} from "../src/collection/pilot-extract.ts";
import {latencySummary} from "../scripts/collect-pilot.ts";
const keys={qoviaKey:"qovia-fixture-credential-123",deepseekKey:"deepseek-fixture-credential-123"};

test("web sample uses an explicit result cap and rejects invalid caps before any network call",async()=>{
 let sent=0;
 const options={...keys,record:()=>{},fetch:async(_url:unknown,init?:RequestInit)=>{sent=JSON.parse(init!.body as string).count;return Response.json({results:[]});}};
 const api=createPilotApi({...options,searchResultCount:5});
 await api.search("deepseek","西安 展览","2026-11-12","2026-11-12");assert.equal(sent,5);
 for(const count of [0,21,1.5,NaN])assert.throws(()=>createPilotApi({...options,searchResultCount:count}),/INVALID_SEARCH_RESULT_COUNT/);
});
test("search calls use correct endpoints and headers; records omit credentials",async()=>{
 const records:Attempt[]=[];const calls:{url:string;body:any;headers:any}[]=[];
 const api=createPilotApi({...keys,record:a=>records.push(a),fetch:async(url,init)=>{calls.push({url:String(url),body:JSON.parse(init!.body as string),headers:init!.headers});return Response.json({results:[],echo:keys.deepseekKey});}});
 await api.search("deepseek","西安 展览","2026-10-14","2026-11-12");await assert.rejects(api.search("qovia","西安 展览","2026-10-14","2026-11-12"),/QOVIA_DISABLED/);
 assert.equal(calls[0].url,"https://api.deepseek.com/v1/tools/search");assert.equal(calls[0].body.need_content,true);assert.equal(calls.length,1);assert.equal(calls[0].headers.Authorization,`Bearer ${keys.deepseekKey}`);
 assert(!JSON.stringify(records).includes(keys.deepseekKey));assert(!JSON.stringify(records).includes(keys.qoviaKey));assert.equal(records.length,1);
});
test("budgets prevent extra calls and HTTP errors do not echo body",async()=>{
 const records:Attempt[]=[];let calls=0;const api=createPilotApi({...keys,searchLimit:1,record:a=>records.push(a),fetch:async()=>{calls++;return Response.json({error:"private message"},{status:401});}});
 await assert.rejects(api.search("deepseek","西安","2026-10-14","2026-11-12"),/AUTH_FAILED/);await assert.rejects(api.search("deepseek","西安","2026-10-14","2026-11-12"),/BUDGET/);assert.equal(calls,1);assert.equal(records[0].http_status,401);
});
test("malformed JSON and network failure are measured without raw exception details",async()=>{
 for(const fn of [async()=>new Response("invalid"),async()=>{throw new Error(keys.deepseekKey);}]){
  const records:Attempt[]=[];const api=createPilotApi({...keys,record:a=>records.push(a),fetch:fn});
  await assert.rejects(api.search("deepseek","西安","2026-10-14","2026-11-12"),error=>!String(error).includes(keys.deepseekKey));assert.equal(records.length,1);assert(records[0].elapsed_ms>=0);
 }
});
test("model is explicitly flash with JSON output and bounded calls",async()=>{
 let body:any;const api=createPilotApi({...keys,extractLimit:1,record:()=>{},fetch:async(_u,init)=>{body=JSON.parse(init!.body as string);return Response.json({choices:[]});}});
 await api.extract("deepseek-flash","json",{text:"活动正文"});assert.equal(body.model,"deepseek-flash");assert.equal(body.thinking.type,"disabled");assert.equal(body.response_format.type,"json_object");await assert.rejects(api.extract("deepseek-flash","json",{}),/BUDGET/);
});
test("document mapping distinguishes excerpts from full content and filters unsafe URLs",()=>{
 const docs=documentsFrom("deepseek",{results:[{url:"https://www.sxhm.com/a",title:"a",content:"全文",snippet:"摘要"},{url:"http://127.0.0.1/a",content:"x"} ]},"q");assert.equal(docs.length,1);assert.equal(docs[0].content_kind,"content");
 const q=documentsFrom("qovia",{data:{items:[{url:"https://weibo.com/a",title:"a",text:"正文片段",platform:"weibo"}]}},"q");assert.equal(q[0].content_kind,"excerpt");assert.throws(()=>documentsFrom("qovia",{},"q"));
});
test("candidate check never promotes partial extraction into a published event",()=>{
 const doc={provider:"deepseek" as const,platform:"web",url:"https://www.sxhm.com/a",title:"展览",text:"西安展览",published_at:null,query:"q",content_kind:"content" as const};
 assert.equal(checkCandidate({title:"展览"},doc,"2026-11-12").schema_valid,false);
 const c={title:"展览",description:"介绍",category:"展览",venue_name:null,address:null,latitude:null,longitude:null,coordinate_system:null,start_at:null,end_at:null,suggested_duration_minutes:null,budget_min:null,budget_max:null,currency:"CNY",budget_note:null,thumbnail_url:null,image_urls:[],schedule_type:null,schedule_note:null,evidence:{title:"展览"}};
 const r=checkCandidate(c,doc,"2026-11-12");assert.equal(r.schema_valid,true);assert(r.issues.includes("MISSING:latitude"));assert.equal(r.ready_for_publication,false);
 c.start_at="2026-11-01T20:00" as any;c.evidence={...c.evidence,start_at:"展览"} as any;
 assert(checkCandidate(c,doc,"2026-11-12").issues.includes("OUTSIDE_TARGET_PERIOD"));
 c.evidence.title="原文没有";assert(checkCandidate(c,doc,"2026-11-12").issues.includes("EVIDENCE_MISSING:title"));
});
test("latency summaries include failures and unknown providers have null percentiles",()=>{
 const rows=[{provider:"qovia",operation:"search",query:"q",elapsed_ms:100,http_status:200,code:"OK",bytes:10,response:{}},{provider:"qovia",operation:"search",query:"q",elapsed_ms:200,http_status:null,code:"TIMEOUT",bytes:0,response:null}] as Attempt[];
 const [q,d]=latencySummary(rows);assert.equal(q.p50_ms,100);assert.equal(q.p95_ms,200);assert.equal(q.success,1);assert.equal(d.p50_ms,null);assert(!JSON.stringify(redact({key:keys.qoviaKey},[keys.qoviaKey])).includes(keys.qoviaKey));
});

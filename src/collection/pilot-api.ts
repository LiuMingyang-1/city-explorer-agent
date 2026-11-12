import { performance } from "node:perf_hooks";
export interface Attempt { provider: "qovia" | "deepseek"; operation: "search" | "extract"; query: string; elapsed_ms: number; http_status: number | null; code: string; bytes: number; response: unknown; }
export class PilotApiError extends Error { code:string; constructor(code:string) { super(code);this.code=code; } }
export function redact(value:unknown,secrets:string[]):unknown {
 let text=JSON.stringify(value);
 for(const secret of secrets.filter(s=>s.length>=8))text=text.split(secret).join("[REDACTED]");
 text=text.replace(/sk-(?:qovia-)?[A-Za-z0-9_-]{16,}/g,"[REDACTED]");
 return JSON.parse(text);
}
export interface ApiOptions {qoviaKey?:string;deepseekKey:string;fetch?:typeof fetch;record:(attempt:Attempt)=>void;searchLimit?:number;extractLimit?:number;searchResultCount?:number;}
export function createPilotApi(options:ApiOptions) {
 if(options.searchResultCount!==undefined&&(!Number.isInteger(options.searchResultCount)||options.searchResultCount<1||options.searchResultCount>20))throw new PilotApiError("INVALID_SEARCH_RESULT_COUNT");
 let searches=0,extractions=0;
 const post=async(provider:Attempt["provider"],operation:Attempt["operation"],query:string,body:unknown,timeout:number):Promise<any>=>{
  if(provider==="qovia")throw new PilotApiError("QOVIA_DISABLED");
  if(operation==="search"){if(searches>=(options.searchLimit??10))throw new PilotApiError("SEARCH_BUDGET_EXHAUSTED");searches++;}
  else {if(extractions>=(options.extractLimit??5))throw new PilotApiError("EXTRACTION_BUDGET_EXHAUSTED");extractions++;}
  const endpoint=operation==="search"?"https://api.deepseek.com/v1/tools/search":"https://api.deepseek.com/chat/completions";
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout),start=performance.now();
  let status:number|null=null,bytes=0,raw:unknown=null,code="OK";
  try {
   const r=await (options.fetch??fetch)(endpoint,{method:"POST",headers:{Authorization:`Bearer ${options.deepseekKey}`,"Content-Type":"application/json"},body:JSON.stringify(body),signal:controller.signal,redirect:"error"});status=r.status;
   const reader=r.body?.getReader();if(!reader)throw new PilotApiError("EMPTY_RESPONSE");
   const chunks:Uint8Array[]=[];
   try {while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>8*1024*1024){await reader.cancel();throw new PilotApiError("RESPONSE_TOO_LARGE");}chunks.push(part.value);}}
   finally{reader.releaseLock();}
   const text=Buffer.concat(chunks).toString("utf8");
   try{raw=JSON.parse(text);}catch{if(r.ok)throw new PilotApiError("INVALID_JSON");raw={non_json_response:true};}
   if(!r.ok)throw new PilotApiError(status===401||status===403?"AUTH_FAILED":status===402?"INSUFFICIENT_BALANCE":status===429?"RATE_LIMITED":`HTTP_${status}`);
   return raw;
  }catch(e){code=e instanceof PilotApiError?e.code:controller.signal.aborted?"TIMEOUT":"NETWORK_ERROR";throw new PilotApiError(code);}
  finally {clearTimeout(timer);options.record(redact({provider,operation,query,elapsed_ms:Math.round(performance.now()-start),http_status:status,code,bytes,response:raw},[options.deepseekKey,...(options.qoviaKey?[options.qoviaKey]:[])]) as Attempt);}
 };
 return {
  search(provider:"qovia"|"deepseek",query:string,since:string,until:string){
   const max=provider==="qovia"?200:128;
   if(!query.trim()||[...query].length>max)throw new PilotApiError("INVALID_QUERY");
   const body=provider==="qovia"?{query,since,until,platforms:["xiaohongshu","wechat","weibo","douyin"],types:["original","repost"],match:["title","content"],page:1,limit:20}:{query,count:options.searchResultCount??20,need_content:true};
   return post(provider,"search",query,body,provider==="qovia"?20000:15000);
  },
  extract(model:string,system:string,input:unknown){return post("deepseek","extract","activity-fields",{model,messages:[{role:"system",content:system},{role:"user",content:JSON.stringify(input)}],response_format:{type:"json_object"},thinking:{type:"disabled"},temperature:0,max_tokens:6000},60000);}
 };
}

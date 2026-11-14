import type{ExtractionDocument}from"./extraction.ts";
import type{OcrResult}from"./ocr.ts";
export interface CloudOcrOptions{key:string;baseUrl?:string;model?:string;maxImages?:number;timeoutMs?:number;concurrency?:number;maxTokens?:number;deadline?:number;fetch?:typeof fetch;record?:(url:string,result:CloudOcrResult)=>void;}
export interface CloudOcrResult extends OcrResult{provider:"siliconflow";model:string;pages:(OcrResult["pages"][number]&{elapsed_ms:number;attempts:number;usage?:{prompt_tokens:number;completion_tokens:number;total_tokens:number}})[];}
export function cloudOcrEnvironment(env:NodeJS.ProcessEnv=process.env){
 const number=(key:string,fallback:number)=>env[key]===undefined?fallback:Number(env[key]);
 return{key:env.SILICONFLOW_API_KEY??"",baseUrl:env.SILICONFLOW_OCR_BASE_URL??"https://api.siliconflow.cn/v1",model:env.SILICONFLOW_OCR_MODEL??"deepseek-ai/DeepSeek-OCR",timeoutMs:number("SILICONFLOW_OCR_TIMEOUT_MS",60000),concurrency:number("SILICONFLOW_OCR_CONCURRENCY",2),maxTokens:number("SILICONFLOW_OCR_MAX_TOKENS",4096)};
}
const error=(code:string)=>new Error(code);
function mime(b:Buffer){if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return"image/png";if(b[0]===255&&b[1]===216&&b[2]===255)return"image/jpeg";if(b.subarray(0,4).toString()==="RIFF"&&b.subarray(8,12).toString()==="WEBP")return"image/webp";if(/^GIF8[79]a/.test(b.subarray(0,6).toString()))return"image/gif";throw error("OCR_UNSUPPORTED_IMAGE");}
async function boundedBody(response:Response,limit:number){const reader=response.body?.getReader();if(!reader)throw error("OCR_EMPTY_RESPONSE");const chunks:Uint8Array[]=[];let size=0;try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw error("OCR_RESPONSE_TOO_LARGE");}chunks.push(value);}}finally{reader.releaseLock();}return Buffer.concat(chunks);}
// Natural-scene photos can trigger decoder loops even with finish_reason=stop.
// Keep obvious loops out of downstream facts, without removing normal repeats.
function repetitive(text:string){const lines=text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),counts=new Map<string,number>();for(const line of lines)counts.set(line,(counts.get(line)??0)+1);return lines.length>=8&&Math.max(...counts.values())>=Math.ceil(lines.length*.8);}
/** Same public OCR contract as the local implementation. No Python, cookies or
 * API credentials are passed to image CDNs; only validated bytes go to OCR. */
export function createCloudOcr(options:CloudOcrOptions){
 if(!options.key.trim())throw error("SILICONFLOW_API_KEY_REQUIRED");
 const max=options.maxImages??10,timeout=options.timeoutMs??60000,concurrency=options.concurrency??2,tokens=options.maxTokens??4096;
 if(!Number.isInteger(max)||max<1||max>20||!Number.isInteger(timeout)||timeout<10||timeout>120000||!Number.isInteger(concurrency)||concurrency<1||concurrency>4||!Number.isInteger(tokens)||tokens<512||tokens>8192)throw error("INVALID_CLOUD_OCR_CONFIG");
 let base:URL;try{base=new URL(options.baseUrl??"https://api.siliconflow.cn/v1");}catch{throw error("INVALID_CLOUD_OCR_ENDPOINT");}
 if(base.protocol!=="https:"||base.username||base.password||base.search||base.hash)throw error("INVALID_CLOUD_OCR_ENDPOINT");
 const endpoint=base.href.replace(/\/$/,"")+"/chat/completions",model=options.model??"deepseek-ai/DeepSeek-OCR",fetcher=options.fetch??fetch;
 if(!model.trim())throw error("INVALID_CLOUD_OCR_MODEL");
 return async(doc:ExtractionDocument):Promise<{text:string;errors:string[]} >=>{
  const started=Date.now(),deadline=Math.min(started+180000,options.deadline??Infinity),urls=doc.image_urls.slice(0,max);
  const pages:CloudOcrResult["pages"]=Array(urls.length);let next=0,terminal:string|null=null;
  const signal=(limit:number)=>{const left=deadline-Date.now();if(left<=0)throw error("OCR_BATCH_TIMEOUT");return AbortSignal.timeout(Math.max(1,Math.min(limit,left)));};
  async function page(index:number){const began=Date.now();let attempts=0,code:string|null=null,text="",usage:CloudOcrResult["pages"][number]["usage"];
   for(let attempt=0;attempt<2;attempt++){
    if(terminal){code=terminal;break;}attempts++;
    try{
     let url:URL;try{url=new URL(urls[index]);}catch{throw error("IMAGE_HOST_NOT_ALLOWED");}
     if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.port||!url.hostname.endsWith(".xhscdn.com"))throw error("IMAGE_HOST_NOT_ALLOWED");url.protocol="https:";url.hash="";
     const imageResponse=await fetcher(url,{headers:{"User-Agent":"Mozilla/5.0"},redirect:"error",signal:signal(15000)});
     if(!imageResponse.ok){await imageResponse.body?.cancel();throw error(imageResponse.status===429||imageResponse.status>=500?"OCR_IMAGE_TRANSIENT":"OCR_IMAGE_HTTP_ERROR");}
     const bytes=await boundedBody(imageResponse,12*1024*1024),type=mime(bytes);if(terminal)throw error(terminal);
     const response=await fetcher(endpoint,{method:"POST",redirect:"error",signal:signal(timeout),headers:{Authorization:`Bearer ${options.key}`,"Content-Type":"application/json"},body:JSON.stringify({model,temperature:0,frequency_penalty:1.2,max_tokens:tokens,stream:false,messages:[{role:"user",content:[{type:"image_url",image_url:{url:`data:${type};base64,${bytes.toString("base64")}`}},{type:"text",text:"<image>\nFree OCR."}]}]})});
     if(!response.ok){const status=response.status;if(status===401||status===403)terminal="OCR_AUTH_FAILED";if(status===402)terminal="OCR_BALANCE_DEPLETED";await response.body?.cancel();throw error(terminal??(status===429?"OCR_RATE_LIMITED":status>=500?"OCR_SERVER_ERROR":"OCR_API_REJECTED"));}
     const responseBytes=await boundedBody(response,1024*1024);let body:any;try{body=JSON.parse(responseBytes.toString("utf8"));}catch{throw error("OCR_INVALID_RESPONSE");}
     if(!body||typeof body!=="object")throw error("OCR_INVALID_RESPONSE");
     const u=body.usage;if(u&&[u.prompt_tokens,u.completion_tokens,u.total_tokens].every(v=>Number.isSafeInteger(v)&&v>=0))usage={prompt_tokens:u.prompt_tokens,completion_tokens:u.completion_tokens,total_tokens:u.total_tokens};
     const choice=body.choices?.[0];if(choice?.finish_reason==="length")throw error("OCR_TRUNCATED_RESPONSE");
     if(choice?.finish_reason!=="stop"||typeof choice.message?.content!=="string")throw error("OCR_INVALID_RESPONSE");text=choice.message.content.trim();if(!text)throw error("OCR_EMPTY_TEXT");
     if(repetitive(text))throw error("OCR_REPETITIVE_RESPONSE");
     code=null;break;
    }catch(e){code=e instanceof Error&&/^(?:OCR_|IMAGE_)[A-Z_]+$/.test(e.message)?e.message:e instanceof Error&&["AbortError","TimeoutError"].includes(e.name)?"OCR_TIMEOUT":"OCR_NETWORK_ERROR";
     text="";if(attempt===1||!["OCR_RATE_LIMITED","OCR_SERVER_ERROR","OCR_TIMEOUT","OCR_NETWORK_ERROR","OCR_IMAGE_TRANSIENT"].includes(code)||Date.now()>=deadline)break;
     await new Promise(resolve=>setTimeout(resolve,250));
    }
   }
   pages[index]={image:index+1,text,error:code,elapsed_ms:Date.now()-began,attempts,...(usage?{usage}:{})};
  }
  async function worker(){for(;;){const index=next++;if(index>=urls.length)return;await page(index);}}
  await Promise.all(Array.from({length:Math.min(concurrency,urls.length)},worker));
  const result:CloudOcrResult={provider:"siliconflow",model,pages,elapsed_ms:Date.now()-started};
  // Provider errors and exception bodies are never recorded. Redact a key even
  // if a malformed provider response happened to echo it in recognized text.
  for(const p of pages)p.text=p.text.split(options.key).join("[REDACTED]");
  options.record?.(doc.url,structuredClone(result));
  const errors=pages.flatMap(p=>p.error?[`图片${p.image}：${p.error}`]:[]);if(doc.image_urls.length>max)errors.push(`OCR_IMAGE_LIMIT：仅识别前${max}张，共${doc.image_urls.length}张`);
  return{text:pages.map(p=>`【图片${p.image}】\n${p.text}`).join("\n\n"),errors};
 };
}

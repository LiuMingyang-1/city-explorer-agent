import{test}from"node:test";import assert from"node:assert/strict";import{createCloudOcr,cloudOcrEnvironment}from"../src/collection/cloud-ocr.ts";import{extractionFixture}from"./collection-downstream-fixture.ts";
import {processCollection} from "../src/collection/pipeline.ts";
import {locatedFixture} from "./collection-downstream-fixture.ts";
const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
const success=(text:string)=>Response.json({choices:[{finish_reason:"stop",message:{content:text}}],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}});
const doc=(n=3)=>({...extractionFixture().document,image_urls:Array.from({length:n},(_,i)=>`https://a.xhscdn.com/${i+1}`)});

test("cloud OCR text reaches analysis and validated publication; partial image failure stays visible",async()=>{
 const {item,asOf}=await locatedFixture();
 const document={...item.document,image_urls:["https://a.xhscdn.com/poster","https://a.xhscdn.com/unavailable"]};
 const ocr=createCloudOcr({key:"test-only-key",fetch:async(url)=>String(url).endsWith("unavailable")?new Response("",{status:403}):String(url).includes("xhscdn")?new Response(png):success("海报场馆 开放时间 09:00-17:00")});
 let calls=0;
 const result=await processCollection([{document}],{asOf,baseDate:"2026-11-12",ocr,invoke:async(_system,input)=>{
  calls++;assert.match(input.text,/【图片1】\n海报场馆 开放时间 09:00-17:00/);
  assert.match(input.text,/【图片2】/);assert(input.text.includes(item.document.text));
  return JSON.stringify({activities:[item.facts]});
 },geocoder:{resolve:async()=>({ok:true,location:item.location,cached:false})}});
 assert.equal(calls,1);assert.equal(result.prepared.dataset.events.length,1);
 assert.deepEqual(result.metrics.ocr_errors,["图片2：OCR_IMAGE_HTTP_ERROR"]);
});
test("cloud OCR preserves numbering with out-of-order completions and retries only transient failed image",async()=>{
 const calls=new Map<string,number>();let active=0,peak=0,recorded:any;
 const ocr=createCloudOcr({key:"private-test-key",concurrency:2,record:(_u,r)=>recorded=r,fetch:async(url,init)=>{
  if(String(url).includes("xhscdn")){assert.equal((init?.headers as any)?.Authorization,undefined);assert.equal((init?.headers as any)?.Cookie,undefined);return new Response(Buffer.concat([png,Buffer.from(String(url).slice(-1))]));}
  assert.equal(String(url),"https://api.siliconflow.cn/v1/chat/completions");assert.equal((init!.headers as any).Authorization,"Bearer private-test-key");assert.equal(init?.redirect,"error");
  const body=JSON.parse(String(init!.body)),value=body.messages[0].content[0].image_url.url;const id=Buffer.from(value.split(",")[1],"base64").toString().slice(-1);assert.equal(body.model,"deepseek-ai/DeepSeek-OCR");assert.match(body.messages[0].content[1].text,/Free OCR/);
  calls.set(id,(calls.get(id)??0)+1);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,id==="1"?20:2));active--;if(id==="2"&&calls.get(id)===1)return new Response("untrusted error body private-test-key",{status:429});return success("图"+id);
 }});const result=await ocr(doc());assert.deepEqual(result.errors,[]);assert.equal(result.text,"【图片1】\n图1\n\n【图片2】\n图2\n\n【图片3】\n图3");assert.equal(calls.get("1"),1);assert.equal(calls.get("2"),2);assert(peak<=2);assert.equal(recorded.pages[1].attempts,2);assert.equal(recorded.pages[0].usage.total_tokens,13);
});
for(const [status,code]of [[401,"OCR_AUTH_FAILED"],[402,"OCR_BALANCE_DEPLETED"],[400,"OCR_API_REJECTED"],[429,"OCR_RATE_LIMITED"],[503,"OCR_SERVER_ERROR"]] as const)test(`HTTP ${status} is diagnosed and bounded without returning response body`,async()=>{
 let calls=0;const ocr=createCloudOcr({key:"secret-key",concurrency:1,fetch:async(url)=>{if(String(url).includes("xhscdn"))return new Response(png);calls++;return new Response("secret-key private body",{status});}});const result=await ocr(doc(1));assert.equal(calls,status===429||status===503?2:1);assert.deepEqual(result.errors,[`图片1：${code}`]);assert(!JSON.stringify(result).includes("secret-key"));
});
test("auth failure stops later requests and invalid images do not contact OCR",async()=>{
 let api=0;const ocr=createCloudOcr({key:"key",concurrency:1,fetch:async(url)=>{if(String(url).includes("xhscdn"))return new Response(png);api++;return new Response("",{status:403});}});const result=await ocr(doc(3));assert.equal(api,1);assert.equal(result.errors.length,3);
 const forbidden=createCloudOcr({key:"key",fetch:async()=>{throw Error("must not fetch");}});assert.match((await forbidden({...doc(1),image_urls:["https://a.xhscdn.com.evil.test/x"]})).errors[0],/IMAGE_HOST_NOT_ALLOWED/);
});
test("partial success and malformed, empty or truncated responses retain per-image errors",async()=>{
 for(const [response,code]of [[new Response("not-json"),"OCR_INVALID_RESPONSE"],[Response.json(null),"OCR_INVALID_RESPONSE"],[success(""),"OCR_EMPTY_TEXT"],[success("咱们在\n".repeat(30)),"OCR_REPETITIVE_RESPONSE"],[Response.json({choices:[{finish_reason:"length",message:{content:"half"}}]}),"OCR_TRUNCATED_RESPONSE"]] as const){let n=0;const ocr=createCloudOcr({key:"key",fetch:async(url)=>String(url).includes("xhscdn")?new Response(png):++n===1?success("第一张"):response});const out=await ocr(doc(2));assert(out.text.includes("第一张"));assert.match(out.errors[0],new RegExp(code));}
});
test("timeout, deadline and image size caps are observable and bounded",async()=>{
 let calls=0;const timeout=createCloudOcr({key:"key",timeoutMs:10,fetch:async(url,init)=>{if(String(url).includes("xhscdn"))return new Response(png);calls++;return new Promise((_r,reject)=>init!.signal!.addEventListener("abort",()=>reject(new DOMException("timeout","TimeoutError")),{once:true}));}});const keepAlive=setInterval(()=>{},1000);try{assert.match((await timeout(doc(1))).errors[0],/OCR_TIMEOUT/);assert.equal(calls,2);}finally{clearInterval(keepAlive);}
 const past=createCloudOcr({key:"key",deadline:Date.now()-1,fetch:async()=>{throw Error("no IO");}});assert.match((await past(doc(1))).errors[0],/OCR_BATCH_TIMEOUT/);
 const big=createCloudOcr({key:"key",fetch:async()=>new Response(new Uint8Array(12*1024*1024+1))});assert.match((await big(doc(1))).errors[0],/OCR_RESPONSE_TOO_LARGE/);
});
test("independent environment settings, config errors, limits and echoed secret redaction",async()=>{
 assert.equal(cloudOcrEnvironment({DEEPSEEK_API_KEY:"not-an-ocr-key"}).key,"");assert.throws(()=>createCloudOcr({key:""}),/SILICONFLOW_API_KEY_REQUIRED/);assert.throws(()=>createCloudOcr({key:"x",baseUrl:"http://insecure.test"}),/ENDPOINT/);assert.throws(()=>createCloudOcr({key:"x",concurrency:8}),/CONFIG/);
 let recorded:any;const ocr=createCloudOcr({key:"secret-key",maxImages:1,record:(_u,r)=>recorded=r,fetch:async(url)=>String(url).includes("xhscdn")?new Response(png):success("secret-key 日期")});const out=await ocr(doc(3));assert.match(out.errors[0],/OCR_IMAGE_LIMIT/);assert(!JSON.stringify(recorded).includes("secret-key"));assert.equal(recorded.pages.length,1);
});

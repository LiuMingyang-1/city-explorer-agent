'use strict';
// JSON and SSE use the same existing /api/chat endpoint. Mocks are an explicit opt-in.
(() => {
 const presets=new Set(['comparison','single','partial','clarification','error']);
 const requested=new URLSearchParams(window.location?.search||'').get('mock');
 const selected=presets.has(requested)?requested:window.WANDER_CONFIG?.mock;
 const mock=presets.has(selected)?selected:null;
 function failure(data,fallback='暂时无法完成规划'){
  const detail=data?.error;const error=new Error(typeof detail==='string'?detail:detail?.message||fallback);
  error.retryable=detail?.retryable!==false;error.code=detail?.code;return error;
 }
 function parser(onEvent){
  let pending='',event='message',data=[];
  function line(value){
   if(value===''){if(data.length)onEvent(event,data.join('\n'));event='message';data=[];return;}
   if(value.startsWith(':'))return;
   const at=value.indexOf(':'),field=at<0?value:value.slice(0,at);let content=at<0?'':value.slice(at+1);if(content.startsWith(' '))content=content.slice(1);
   if(field==='event')event=content;else if(field==='data')data.push(content);
  }
  function push(chunk,final=false){
   pending+=chunk;let i=0,start=0;
   for(;i<pending.length;i++){
    const c=pending[i];if(c!=='\n'&&c!=='\r')continue;
    if(c==='\r'&&i===pending.length-1&&!final)break;
    line(pending.slice(start,i));if(c==='\r'&&pending[i+1]==='\n')i++;start=i+1;
   }
   pending=pending.slice(start);
   if(final){if(pending)line(pending);line('');pending='';}
  }
  return {push};
 }
 function eventHandler({onProgress,onMeta,isCurrent=()=>true}={}){
  let result,terminalError;
  return {handle(event,value){
   if(!isCurrent())return;let data;
   try{data=JSON.parse(value);}catch{throw new Error('流式回复格式不正确');}
   if(event==='meta')onMeta?.(data);
   else if(event==='progress')onProgress?.(data);
   else if(event==='result'){if(result!==undefined)throw new Error('收到重复的最终方案');result=data;}
   else if(event==='error')terminalError=failure(data);
  },result(){if(terminalError)throw terminalError;if(result===undefined)throw new Error('连接已结束，尚未收到完整方案');return result;}};
 }
 async function readStream(response,options){
  if(!response.body?.getReader)throw new Error('浏览器无法读取流式回复');
  const handler=eventHandler(options),events=parser(handler.handle),decoder=new TextDecoder(),reader=response.body.getReader();
  try{while(true){if(options.signal?.aborted)throw new DOMException('Cancelled','AbortError');const {done,value}=await reader.read();if(done)break;events.push(decoder.decode(value,{stream:true}));}events.push(decoder.decode(),true);return handler.result();}
  catch(error){try{await reader.cancel();}catch{}throw error;}
  finally{reader.releaseLock();}
 }
 function delay(ms,signal){return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(new DOMException('Cancelled','AbortError'));return;}
  const abort=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});
 });}
 async function mockRequest(body,options){
  const base=window.WANDER_CONFIG?.mockBase||'/__mocks/day0/';
  const file={comparison:'stream.sse',single:'response-single.json',partial:'response-partial.json',clarification:'response-clarification.json',error:'stream-error.sse'}[mock];
  const response=await fetch(base+file,{signal:options.signal});if(!response.ok)throw new Error('示例数据加载失败');
  let data;
  if(file.endsWith('.sse')){
   const frames=[],events=parser((event,value)=>frames.push({event,value}));events.push(await response.text(),true);
   const handler=eventHandler(options);
   for(const frame of frames){await delay(window.WANDER_CONFIG?.mockDelay??350,options.signal);handler.handle(frame.event,frame.value);}
   data=handler.result();
  }else data=await response.json();
  // Reuse the selected plan from the canonical comparison sample for continuation.
  if(body.active_plan&&data.kind==='plans'&&data.plans.some(p=>p.plan_id===body.active_plan))data={...data,mode:'single',active_plan:body.active_plan,plans:data.plans.filter(p=>p.plan_id===body.active_plan)};
  return data;
 }
 async function request(body,{signal,onProgress,onMeta,isCurrent}={}){
  const controller=new AbortController(),abort=()=>controller.abort();if(signal?.aborted)abort();signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(),210000),options={signal:controller.signal,onProgress,onMeta,isCurrent};
  try{
   if(mock)return await mockRequest(body,options);
   const response=await fetch('/api/chat',{method:'POST',body:JSON.stringify(body),credentials:'same-origin',signal:controller.signal,headers:{Accept:'application/json, text/event-stream','Content-Type':'application/json'}});
   if(!response.ok)throw failure(await response.json().catch(()=>null),'HTTP '+response.status);
   if((response.headers?.get('Content-Type')||'').includes('text/event-stream'))return await readStream(response,options);
   return await response.json();
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 window.WanderTransport={request,parser,readStream,eventHandler,mock};
})();

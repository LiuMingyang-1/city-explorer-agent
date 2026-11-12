'use strict';
let ready=true,activeChatRequest;
window.addEventListener('wander:reset',()=>{activeChatRequest?.abort();activeChatRequest=null;});
function scrollMessages(){const list=$('messages');list.scrollTo({top:list.scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}
function makeMessage(role){
 $('empty-state')?.remove();const message=document.createElement('div');message.className='message '+role;
 const label=document.createElement('span');label.className='message-label';label.textContent=role==='user'?'你':'漫游 · 城市向导';
 const bubble=document.createElement('div');bubble.className='bubble';message.append(label,bubble);$('messages').append(message);scrollMessages();return {message,bubble};
}
function appendMessage(role,text){const {message,bubble}=makeMessage(role);bubble.textContent=text;state.messages.push({role,text});return message;}
// Retain these entry points for existing local history snapshots.
function itineraryText(itinerary,events){return window.WanderPlans.summary({itinerary,events});}
function appendItinerary(itinerary,events){return window.WanderPlans.append({itinerary,events});}
function showSendError(text,error){
 const {message,bubble}=makeMessage('assistant');
 const detail=error?.name==='AbortError'?'请求超时':error?.message||'网络异常';
 const note=document.createElement('span');note.textContent='本次规划未完成（'+detail+'）。';bubble.append(note);
 if(error?.retryable!==false){const retry=document.createElement('button');retry.type='button';retry.className='retry-button';retry.textContent='重试';retry.addEventListener('click',()=>{if(state.busy)return;message.remove();deliver(text);});bubble.append(retry);}
 scrollMessages();
}
function buildChatBody(text){
 const body={message:text},loc=window.WanderAMap?window.WanderAMap.backendLocation(state.location):state.location;
 if(loc&&Number.isFinite(loc.lat)&&Number.isFinite(loc.lng))body.location={lat:loc.lat,lng:loc.lng};
 if(typeof state.sessionId==='string'&&state.sessionId)body.session_id=state.sessionId;
 // Legacy /api/chat rejects extra keys: only plans-capable replies enable this field.
 if(state.latestPlan?.kind==='plans'&&typeof state.activePlanId==='string')body.active_plan=state.activePlanId;
 if(typeof state.referencedEventId==='string'&&state.referencedDraft===text)body.referenced_event_id=state.referencedEventId;
 return body;
}
async function deliver(text){
 const generation=window.WanderHistory?.generation(),isCurrent=()=>!window.WanderHistory||generation===window.WanderHistory.generation();
 const request=new AbortController();activeChatRequest=request;state.busy=true;updateSendButton();
 const pending=document.createElement('div');pending.className='message assistant';
 const label=document.createElement('span');label.className='message-label';label.textContent=window.WanderTransport.mock?'漫游 · 示例演示':'漫游 · 正在规划';
 const status=document.createElement('div');status.className='bubble planning-progress';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.textContent='正在连接城市向导';pending.append(label,status);$('messages').append(pending);scrollMessages();
 const stageNames={searching_events:'正在检索活动',exploring_plans:'正在比较方案 A 与方案 B',routing:'正在获取站间道路路线',validating_schedule:'正在校验路线时间'};
 const slow=setTimeout(()=>{if(isCurrent())status.textContent='仍在规划中，请稍候…';},15000);
 try{
  const data=await window.WanderTransport.request(buildChatBody(text),{signal:request.signal,isCurrent,
   onMeta:meta=>{if(isCurrent()&&typeof meta.session_id==='string')state.sessionId=meta.session_id;},
   onProgress:progress=>{if(isCurrent()){clearTimeout(slow);status.textContent=String(progress.message||stageNames[progress.stage]||'正在整理方案').slice(0,160);scrollMessages();}}
  });
  if(!isCurrent())return;pending.remove();
  if(data&&typeof data.session_id==='string'&&data.session_id)state.sessionId=data.session_id;
  if(data&&(data.kind==='plans'||data.kind==='itinerary'))window.WanderPlans.append(data);
  else if(data&&data.kind==='clarification'&&typeof data.question==='string'&&data.question)appendMessage('assistant',data.question);
  else throw new Error('收到的方案格式暂不支持');
 }catch(error){if(!isCurrent())return;pending.remove();showSendError(text,error);}
 finally{clearTimeout(slow);pending.remove();if(isCurrent()){state.referencedEventId=null;state.referencedDraft=null;activeChatRequest=null;state.busy=false;updateSendButton();window.WanderHistory?.capture();$('message-input').focus({preventScroll:true});}}
}
async function sendMessage(text){
 text=String(text).trim();if(!text||!ready||state.busy)return;
 state.manual=true;window.WanderHistory?.setExpanded(false);appendMessage('user',text);$('message-input').value='';window.WanderHistory?.capture();await deliver(text);
}
window.sendMessage=sendMessage;
function updateSendButton(){$('send-button').disabled=!ready||state.busy||!$('message-input').value.trim();}
$('message-input').addEventListener('input',()=>{if($('message-input').value!==state.referencedDraft){state.referencedEventId=null;state.referencedDraft=null;}updateSendButton();});
$('chat-form').addEventListener('submit',event=>{event.preventDefault();if(!event.isComposing)sendMessage($('message-input').value);});
$('message-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&event.isComposing)event.preventDefault();});
updateSendButton();

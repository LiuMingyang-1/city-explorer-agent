'use strict';
let ready=false,initializing=false;
async function apiJSON(url,{method='GET',body,timeout=10000}={}){
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeout);
 try{
  const response=await fetch(url,{method,body,credentials:'same-origin',signal:controller.signal,
   headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})}});
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(data&&typeof data.error==='string'&&data.error?data.error:'HTTP '+response.status);
  return data;
 }finally{clearTimeout(timer);}
}
function scrollMessages(){const list=$('messages');list.scrollTo({top:list.scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}
function makeMessage(role){
 $('empty-state')?.remove();
 const message=document.createElement('div');message.className='message '+role;
 const label=document.createElement('span');label.className='message-label';label.textContent=role==='user'?'你':'漫游 · 城市向导';
 const bubble=document.createElement('div');bubble.className='bubble';
 message.append(label,bubble);$('messages').append(message);scrollMessages();
 return {message,bubble};
}
function appendMessage(role,text){const {message,bubble}=makeMessage(role);bubble.textContent=text;state.messages.push({role,text});return message;}
function eventMap(events){
 const byId=new Map();
 (Array.isArray(events)?events:[]).forEach(event=>{if(event&&event.event_id!==undefined&&event.event_id!==null)byId.set(event.event_id,event);});
 return byId;
}
function fmtTime(value){
 const s=String(value||'').trim();if(!s)return'';
 const clock=s.match(/(\d{1,2}:\d{2})/);if(clock)return clock[1];
 const date=new Date(s);if(Number.isNaN(date.getTime()))return s;
 return String(date.getHours()).padStart(2,'0')+':'+String(date.getMinutes()).padStart(2,'0');
}
function fmtRange(arrive,leave){const from=fmtTime(arrive),to=fmtTime(leave);return from&&to?from+' – '+to:from||to;}
function itineraryText(itinerary,events){
 const byId=eventMap(events);
 const lines=[itinerary.summary||''];
 (Array.isArray(itinerary.stops)?itinerary.stops:[]).forEach(stop=>{
  const event=byId.get(stop.event_id)||{};
  lines.push([fmtRange(stop.arrive_at,stop.leave_at),event.title||stop.event_id].filter(Boolean).join(' '));
 });
 return lines.filter(Boolean).join('\n');
}
function routeStops(itinerary,events){
 const byId=eventMap(events);
 return (itinerary&&Array.isArray(itinerary.stops)?itinerary.stops:[]).map(stop=>{
  const event=stop&&byId.get(stop.event_id);if(!event)return null;
  const lat=Number(event.latitude),lng=Number(event.longitude);
  return Number.isFinite(lat)&&Number.isFinite(lng)?{lat,lng,title:String(event.title||'')}:null;
 }).filter(Boolean);
}
function drawRoute(points){
 if(!map)return;
 if(routeLayer){map.removeLayer(routeLayer);routeLayer=null;}
 if(!points||!points.length)return;
 const dots=points.map((point,index)=>L.circleMarker([point.lat,point.lng],{radius:6,color:'#b87552',weight:2,fillColor:'#f7f8f3',fillOpacity:.95})
  .bindTooltip(index+1+'. '+point.title));
 if(points.length<2){routeLayer=L.layerGroup(dots).addTo(map);map.flyTo([points[0].lat,points[0].lng],14,{duration:.9});return;}
 const line=L.polyline(points.map(p=>[p.lat,p.lng]),{color:'#b87552',weight:3,opacity:.8,dashArray:'5 9'});
 line.bindTooltip('游玩顺序示意 · 非导航路线',{sticky:true});
 routeLayer=L.layerGroup([line,...dots]).addTo(map);
 const card=document.querySelector('.glass-card').getBoundingClientRect();
 map.fitBounds(line.getBounds(),{paddingTopLeft:innerWidth>700?[card.right+45,110]:[30,100],paddingBottomRight:innerWidth>700?[100,90]:[45,card.height+45],maxZoom:14,animate:true});
}
function appendItinerary(itinerary,events){
 const {message,bubble}=makeMessage('assistant');
 bubble.classList.add('itinerary');
 if(itinerary.date){const date=document.createElement('p');date.className='itinerary-date';date.textContent=itinerary.date;bubble.append(date);}
 const summary=document.createElement('p');summary.className='itinerary-summary';summary.textContent=itinerary.summary||'';bubble.append(summary);
 const byId=eventMap(events);
 const list=document.createElement('ol');list.className='itinerary-stops';
 (Array.isArray(itinerary.stops)?itinerary.stops:[]).forEach(stop=>{
  const event=byId.get(stop.event_id)||{};
  const item=document.createElement('li');
  const head=document.createElement('div');head.className='stop-head';
  const time=document.createElement('span');time.className='stop-time';time.textContent=fmtRange(stop.arrive_at,stop.leave_at);
  const title=document.createElement('span');title.className='stop-title';title.textContent=event.title||String(stop.event_id||'行程点');
  head.append(time,title);item.append(head);
  if(event.venue_name&&event.venue_name!==event.title){const venue=document.createElement('span');venue.className='stop-venue';venue.textContent=event.venue_name;item.append(venue);}
  if(stop.reason){const reason=document.createElement('p');reason.className='stop-reason';reason.textContent=stop.reason;item.append(reason);}
  list.append(item);
 });
 bubble.append(list);
 state.messages.push({role:'assistant',text:itineraryText(itinerary,events)});
 scrollMessages();
 drawRoute(routeStops(itinerary,events));
 return message;
}
function showSendError(text,detail){
 const {message,bubble}=makeMessage('assistant');
 const note=document.createElement('span');note.textContent='消息没有发出去'+(detail?'（'+detail+'）':'')+'。';
 const retry=document.createElement('button');retry.type='button';retry.className='retry-button';retry.textContent='重试';
 retry.addEventListener('click',()=>{if(state.busy)return;message.remove();deliver(text);});
 bubble.append(note,retry);scrollMessages();
}
async function deliver(text){
 state.busy=true;updateSendButton();
 const pending=document.createElement('div');pending.className='message assistant';
 pending.innerHTML='<span class="message-label">漫游正在整理灵感</span><div class="bubble typing" aria-label="正在回复">···</div>';
 $('messages').append(pending);scrollMessages();
 try{
  const data=await apiJSON('/api/chat',{method:'POST',body:JSON.stringify({message:text}),timeout:60000});
  pending.remove();
  if(data&&data.kind==='itinerary'&&data.itinerary&&typeof data.itinerary==='object')appendItinerary(data.itinerary,data.events);
  else if(data&&data.kind==='clarification'&&typeof data.question==='string'&&data.question)appendMessage('assistant',data.question);
  else appendMessage('assistant','收到了意料之外的回复，再告诉我一次你的想法吧。');
 }catch(error){
  pending.remove();
  showSendError(text,error&&error.name==='AbortError'?'请求超时':(error&&error.message)||'网络异常');
 }finally{
  state.busy=false;updateSendButton();$('message-input').focus({preventScroll:true});
 }
}
async function sendMessage(text){
 text=String(text).trim();if(!text||!ready||state.busy)return;
 appendMessage('user',text);$('message-input').value='';
 await deliver(text);
}
window.sendMessage=sendMessage;
function updateSendButton(){$('send-button').disabled=!ready||state.busy||!$('message-input').value.trim();}
function showInitError(detail){
 const {message,bubble}=makeMessage('assistant');
 const note=document.createElement('span');note.textContent='历史对话暂时没有加载出来，发送前请重试'+(detail?'（'+detail+'）':'')+'。 ';
 const retry=document.createElement('button');retry.type='button';retry.className='retry-button';retry.textContent='重试';
 retry.addEventListener('click',()=>{if(ready||initializing)return;message.remove();initHistory();});
 bubble.append(note,retry);scrollMessages();
}
async function initHistory(){
 if(ready||initializing)return;
 initializing=true;updateSendButton();
 const pending=document.createElement('div');pending.className='message assistant';
 pending.innerHTML='<span class="message-label">漫游正在恢复历史对话</span><div class="bubble typing" aria-label="正在加载">···</div>';
 $('messages').append(pending);scrollMessages();
 let data;
 try{data=await apiJSON('/api/chat/history');}
 catch(error){
  pending.remove();initializing=false;updateSendButton();
  showInitError(error&&error.name==='AbortError'?'请求超时':(error&&error.message)||'网络异常');
  return;
 }
 pending.remove();ready=true;initializing=false;updateSendButton();
 (data&&Array.isArray(data.messages)?data.messages:[]).forEach(entry=>{
  if(entry&&(entry.role==='user'||entry.role==='assistant')&&typeof entry.text==='string')appendMessage(entry.role,entry.text);
 });
 if(data&&data.itinerary&&typeof data.itinerary==='object')appendItinerary(data.itinerary,data.events);
}
$('message-input').addEventListener('input',updateSendButton);
$('chat-form').addEventListener('submit',event=>{event.preventDefault();if(!event.isComposing)sendMessage($('message-input').value);});
$('message-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&event.isComposing)event.preventDefault();});
initHistory();

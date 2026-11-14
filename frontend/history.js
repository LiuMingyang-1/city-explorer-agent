'use strict';
// Local navigation for both the static demo and the repository's API-backed chat.
(() => {
 const MAX_SESSIONS=20;
 // History is bucketed per identity: account buckets are 'u-<userId>', the
 // anonymous identity is 'guest'. localStorage is shared browser-wide, so a
 // single bucket would leak one identity's snapshots to the next after a
 // login/logout switch. The anonymous userId lives in an HttpOnly cookie and
 // is unreadable here, but the browser's anonymous identity is stable.
 const BASE_KEY='wander.chat-history.v1'+(window.WanderTransport?.mock?'.demo':'');
 // Between page load and the first /api/me reply the identity is unresolved:
 // captures land in a 'pending' bucket, and setIdentity flushes it into the
 // resolved bucket — writes made in that window can never fall into the
 // wrong identity.
 let storageKey=BASE_KEY+'.pending';
 // One-time migration: the pre-bucket key folds into the guest bucket —
 // legacy data predates the login feature, so it can only be anonymous.
 try{
  const legacy=window.localStorage.getItem(BASE_KEY),guestKey=BASE_KEY+'.guest';
  if(legacy!==null){
   if(window.localStorage.getItem(guestKey)===null)window.localStorage.setItem(guestKey,legacy);
   window.localStorage.removeItem(BASE_KEY);
  }
 }catch{}
 let entries=loadEntries(),epoch=0,expanded=false,closing=false,closeTimer=0;
 const makeId=()=>window.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
 const still=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
 // Which entry each rendered row stands for — lets an interrupted exit run in
 // reverse on the same nodes instead of rebuilding from scratch.
 const rowMeta=new WeakMap();
 let activeId=makeId(),createdAt=Date.now();
 function safeMessages(messages){return (Array.isArray(messages)?messages:[]).filter(m=>m&&['user','assistant'].includes(m.role)&&typeof m.text==='string').slice(-60).map(m=>({role:m.role,text:m.text.slice(0,4000)}));}
 function loadEntries(){
  try{
   const saved=JSON.parse(window.localStorage.getItem(storageKey)||'[]');
   if(Array.isArray(saved))return saved.filter(s=>s&&typeof s.id==='string'&&Number.isFinite(s.createdAt)&&Number.isFinite(s.updatedAt)).slice(0,MAX_SESSIONS).map(s=>({...s,messages:safeMessages(s.messages),title:String(s.title||'西安游玩规划').slice(0,60)})).filter(s=>s.messages.length);
  }catch{}
  return [];
 }
 function write(){try{window.localStorage.setItem(storageKey,JSON.stringify(entries));}catch{ /* Storage may be blocked or full; history stays available in this page. */ }}
 function title(){
  const first=state.messages.find(m=>m.role==='user')?.text||'';
  if(/半天|半日|下午|上午/.test(first))return '西安半日游';
  if(/一日|一天|全天/.test(first))return '西安一日游';
  return String(window.WanderPlans?.active(state.latestPlan)?.itinerary?.summary||state.latestPlan?.itinerary?.summary||first||'西安游玩规划').replace(/\s+/g,' ').slice(0,22);
 }
 function capture(){
  const messages=safeMessages(state.messages);if(!messages.length)return;
  // The card-carrying message is identified by position only — never by
  // summary text, which a plain answer can quote verbatim. planMessageIndex
  // is the live index shifted into the trimmed window; a card scrolled out
  // of the window records null ("not in this snapshot") instead of guessing.
  const planText=window.WanderPlans?.summary(state.latestPlan);
  let planIndex=null;
  if(planText){
   const live=typeof state.planMessageIndex==='number'?state.planMessageIndex-(state.messages.length-messages.length):-1;
   if(live>=0&&messages[live]?.role==='assistant')planIndex=live;
  }
  const entry={id:activeId,createdAt,updatedAt:Date.now(),title:title(),messages,planIndex,
   sessionId:typeof state.sessionId==='string'?state.sessionId:null,
   latestPlan:state.latestPlan||null,routeNames:Array.isArray(state.routeNames)?state.routeNames:[],
   location:state.location?{lat:state.location.lat,lng:state.location.lng,name:state.location.name,coordinateSystem:state.location.coordinateSystem,wgs84:state.location.wgs84}:null};
  entries=[entry,...entries.filter(s=>s.id!==activeId)].sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,MAX_SESSIONS);
  write();render();
 }
 // Collapse keeps the expanded layout mounted while the rows sink and fade
 // out; only after the exit settles is the class dropped and the collapsed
 // list rebuilt. A fast re-expand reverses the same rows in place — they rise
 // back from wherever they faded to, never vanishing mid-motion.
 function finishClose(){
  if(!closing)return;
  closing=false;clearTimeout(closeTimer);
  document.querySelector('.glass-card').classList.toggle('history-expanded',false);
  $('messages').hidden=false;render(true);
 }
 function setExpanded(value){
  value=Boolean(value);
  // A programmatic collapse (open/newChat/setIdentity) abandons an in-flight
  // exit immediately rather than waiting for the exit timer.
  if(closing&&!value)return finishClose();
  if(value===expanded)return render();
  const card=document.querySelector('.glass-card');
  expanded=value;$('more-history').setAttribute('aria-expanded',String(value));
  if(value){
   const list=$('history-list'),rows=list?[...list.children]:[],past=entries.filter(s=>s.id!==activeId);
   const reversible=closing&&!still()&&rows.length===past.length&&past.every((e,i)=>{const m=rowMeta.get(rows[i]);return m?.id===e.id&&m?.title===e.title;});
   closing=false;clearTimeout(closeTimer);card.classList.toggle('history-expanded',true);$('messages').hidden=true;
   if(reversible){
    rows.forEach((row,index)=>{
     row.classList.remove('history-exit');
     if(typeof getComputedStyle==='function'){
      const from=getComputedStyle(row);
      row.animate?.([{opacity:from.opacity,transform:from.transform==='none'?'translateY(0)':from.transform},{opacity:1,transform:'translateY(0)'}],{duration:220,delay:Math.min(index,5)*22,easing:'cubic-bezier(.22,.8,.32,1)',fill:'forwards'});
     }
    });
    $('more-history').textContent='收起历史规划';$('more-history').disabled=!past.length;return;
   }
   render(!still());return;
  }
  const list=$('history-list'),rows=list?[...list.children]:[];
  if(!rows.length||still()){
   card.classList.toggle('history-expanded',false);$('messages').hidden=false;render();return;
  }
  // The exit is driven by WAAPI from each row's live computed style, so a row
  // caught mid-enter keeps fading down from its in-flight opacity/transform —
  // swapping animation/transition classes here would snap back to opaque
  // first. Without WAAPI the teardown still defers on the timer; the rows
  // simply stay static until it lands.
  closing=true;render();
  rows.forEach((row,index)=>{
   row.classList.add('history-exit');
   const from=getComputedStyle(row);
   row.animate?.([{opacity:from.opacity,transform:from.transform==='none'?'translateY(0)':from.transform},{opacity:0,transform:'translateY(12px)'}],{duration:240,delay:Math.min(index,5)*22,easing:'cubic-bezier(.4,0,1,1)',fill:'forwards'});
  });
  closeTimer=setTimeout(finishClose,400);
 }
 function clearConversation(){
  epoch++;window.dispatchEvent(new Event('wander:reset'));
  state.messages=[];state.busy=false;state.sessionId=null;state.latestPlan=null;state.activePlanId=null;state.routeNames=[];state.eventChip=null;state.planMessageIndex=null;
  $('messages').replaceChildren();$('message-input').value='';
  window.WanderAMap?.cancelPending?.();
  window.WanderAMap?.clearRoutes();
  if(map&&routeLayer){map.removeLayer(routeLayer);routeLayer=null;}
  if(map)updatePlaceMarkers([]);
  updateSendButton();window.updateChatLayout?.();
 }
 function newChat(){
  capture();clearConversation();activeId=makeId();createdAt=Date.now();setExpanded(false);
  $('message-input').focus({preventScroll:true});
 }
 function open(id){
  const entry=entries.find(s=>s.id===id);if(!entry)return;
  capture();clearConversation();activeId=entry.id;createdAt=entry.createdAt;
  const restoreEpoch=epoch;
  state.sessionId=typeof entry.sessionId==='string'?entry.sessionId:null;
  // Snapshots written after this change carry an authoritative planIndex:
  // an integer locates the card, null means the card scrolled out of the
  // message window — never re-match by summary text in that case. Only
  // snapshots predating the field fall back to the legacy text match.
  const planText=window.WanderPlans?.summary(entry.latestPlan),isPlan=m=>m?.role==='assistant'&&m.text===planText;
  const planIndex=planText?('planIndex' in entry?(Number.isInteger(entry.planIndex)&&entry.messages[entry.planIndex]?.role==='assistant'?entry.planIndex:-1):entry.messages.map(isPlan).lastIndexOf(true)):-1;
  entry.messages.forEach((m,index)=>{if(index===planIndex)window.WanderPlans.append(entry.latestPlan,{drawMap:false});else appendMessage(m.role,m.text);});
  function finish(){
   if(restoreEpoch!==epoch)return;
   if(entry.latestPlan&&window.WanderPlans){
    state.latestPlan=window.WanderPlans.normalize(entry.latestPlan);state.activePlanId=state.latestPlan?.active_plan;window.WanderPlans.draw(state.latestPlan);
   }else if(Array.isArray(entry.routeNames)&&entry.routeNames.length&&typeof drawRoute==='function')drawRoute(entry.routeNames);
   setExpanded(false);scrollMessages();$('message-input').focus({preventScroll:true});
  }
  const locationJob=entry.location&&Number.isFinite(entry.location.lat)&&Number.isFinite(entry.location.lng)?selectLocation(entry.location.lat,entry.location.lng,String(entry.location.name||'西安市'),13,false,entry.location.coordinateSystem||'WGS84',entry.location.wgs84):null;
  if(locationJob?.then)return locationJob.then(finish);finish();
 }
 function render(animate=false){
  const list=$('history-list');if(!list)return;
  const past=entries.filter(s=>s.id!==activeId);
  // While a collapse animation runs the exiting rows stay mounted; only the
  // toggle's label and disabled state track the new (collapsed) state.
  if(closing){$('more-history').textContent='更多历史规划';$('more-history').disabled=!past.length;return;}
  list.replaceChildren();const visible=expanded?past:past.slice(0,2);
  if(!visible.length){const empty=document.createElement('p');empty.className='history-empty';empty.textContent='暂无历史规划';list.append(empty);}
  visible.forEach(entry=>{
   const row=document.createElement('button');row.type='button';row.className='history-entry';
   const date=new Date(entry.createdAt),time=document.createElement('span');time.className='history-date';
   time.textContent=String(date.getMonth()+1).padStart(2,'0')+'.'+String(date.getDate()).padStart(2,'0');
   const name=document.createElement('span');name.className='history-title';name.textContent=entry.title;
   row.title=time.textContent+' '+entry.title;row.append(time,name);row.addEventListener('click',()=>open(entry.id));rowMeta.set(row,{id:entry.id,title:entry.title});list.append(row);
  });
  // Entering rows rise from below and fade in with a capped stagger — the
  // whole visible list reads as one sheet springing up from the footer.
  if(animate)[...list.children].forEach((row,index)=>{row.classList.add('history-enter');row.style.setProperty('--i',Math.min(index,6));});
  $('more-history').textContent=expanded?'收起历史规划':'更多历史规划';$('more-history').disabled=!past.length;
 }
 /**
  * Identity switch: capture the current conversation into the CURRENT bucket,
  * then swap storageKey and load the resolved identity's bucket — buckets
  * never cross. When leaving 'pending', its entries merge into the resolved
  * bucket and the pending key is cleared. clearConversation keeps the
  * generation/epoch semantics (in-flight replies from the old identity die
  * on the bumped epoch). Same-bucket calls are a no-op.
  */
 function setIdentity(identity){
  let clean=String(identity||'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,64)||'guest';
  if(clean==='pending')clean='guest'; // 'pending' is internal-only
  const nextKey=BASE_KEY+'.'+clean;
  if(nextKey===storageKey)return;
  capture();
  const flushing=storageKey===BASE_KEY+'.pending',carried=flushing?entries:null;
  storageKey=nextKey;
  entries=loadEntries();
  if(flushing){
   if(carried.length){entries=[...carried,...entries].sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,MAX_SESSIONS);write();}
   try{window.localStorage.removeItem(BASE_KEY+'.pending');}catch{}
   // Resolving to guest only confirms the assumed anonymous identity: the live
   // conversation (and an in-flight request) carries on in the guest bucket
   // instead of being reset mid-window.
   if(nextKey===BASE_KEY+'.guest'){render();return;}
  }
  clearConversation();
  activeId=makeId();createdAt=Date.now();setExpanded(false);
 }
 window.WanderHistory={capture,newChat,open,setExpanded,generation:()=>epoch,setIdentity};
 $('new-chat').addEventListener('click',newChat);
 $('more-history').addEventListener('click',()=>setExpanded(!expanded));
 render();
})();

'use strict';
// Map candidate layer + clone anchors — issue #41 (I41-D), contract
// docs/issue-41/coordination.md §3. window.WanderCandidates consumes the same
// real PlannerProcessEvent frames the card facade fans out: stamped
// search_events tool_call.candidates and subagent_done.stops (GCJ-02 only).
// Clone identity (letter/palette/title) comes exclusively from the team
// snapshot context the facade passes in — this module never invents hat
// colors or dispatch letters. All drawing goes through the narrow
// WanderAMap.candidates renderer (single convert entry, isolated marker set);
// when the native map is missing or the Leaflet fallback is active nothing
// draws and every anchor reports anchored=false so the card keeps its faces.
(() => {
const PER_SUB_LIMIT=32,TOTAL_LIMIT=96,STOP_LIMIT=24,HIGHLIGHT_MS=480,FADE_MS=450,FLIGHT_MS=560;
let round=null,closed=true,destroyed=false,epoch=0,renderSeq=0;
let context={clones:[],origin:null},dropped=0;
const subs=new Map(),anchored=new Set(),timers=new Set();
let mascotModule=null,renderQueued=false;
const stats={dots:0,anchors:0};

const str=v=>typeof v==='string'?v:'';
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const validPoint=(lat,lng)=>finite(lat)&&finite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180;
const mapApi=()=>window.WanderAMap?.candidates??null;
const reduced=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
const cloneOf=sub=>context.clones.find(c=>c.id===sub.id)??null;
const totalPoints=()=>[...subs.values()].reduce((n,s)=>n+s.points.size,0);
function later(fn,ms){const t=setTimeout(()=>{timers.delete(t);fn();},ms);timers.add(t);return t;}
function loadMascot(){
 if(!mascotModule)mascotModule=Promise.resolve().then(async()=>{
  // __WANDER_MASCOT_MODULE__ is a test seam; production always takes the import.
  const m=await (window.__WANDER_MASCOT_MODULE__??import('./wander-mascot.js'));
  return m?.createWanderMascot??null;
 }).catch(()=>null);
 return mascotModule;
}
function notifyAnchor(id,show){
 if(show===anchored.has(id))return;
 if(show)anchored.add(id);else anchored.delete(id);
 if(!show){const sub=subs.get(id);if(sub)endFlight(sub,sub.flight);}
 if(typeof CustomEvent==='function')try{window.dispatchEvent(new CustomEvent('wander:candidate-anchor',{detail:{round,subagent_id:id,anchored:show}}));}catch{}
}
function ensureSub(id){
 let sub=subs.get(id);
 if(!sub){sub={id,title:'',status:'working',points:new Map(),highlight:new Set(),stopCount:0,retired:false,dim:false,
  anchorEl:null,anchorVisual:null,anchorFace:null,anchorLetterEl:null,anchorTitleEl:null,anchorMascot:null,anchorPalette:null,anchorLetter:null,anchorTitle:null,anchorPos:null,entered:false,flight:null};
  subs.set(id,sub);}
 return sub;
}
function ensureAnchor(sub,clone){
 if(!sub.anchorEl){
  const el=document.createElement('div');el.className='wander-candidate-anchor';
  // Inner visual wrapper owns everything the user sees; the SDK positions the
  // outer node and may inline its own transform there, so decoration only
  // ever touches this inner element (or a proxy carrying it).
  const visual=document.createElement('div');visual.className='wander-candidate-visual';
  const face=document.createElement('boop-face');face.setAttribute('aria-hidden','true');
  const letter=document.createElement('span');letter.className='wander-candidate-letter';letter.hidden=true;
  const title=document.createElement('span');title.className='wander-candidate-title';title.hidden=true;
  visual.append(face,letter,title);el.append(visual);
  sub.anchorEl=el;sub.anchorVisual=visual;sub.anchorFace=face;sub.anchorLetterEl=letter;sub.anchorTitleEl=title;
  // The import can resolve after this round ended: only create the face while
  // the same sub record still owns this element (teardown nulls the refs).
  const held=sub,heldFace=face;
  loadMascot().then(create=>{
   if(destroyed||!create||subs.get(held.id)!==held||held.anchorFace!==heldFace)return;
   try{held.anchorMascot=create(heldFace,{palette:held.anchorPalette||'moss',pointerFollow:false});held.anchorMascot?.setState?.('thinking');}catch{/* degraded anchor keeps letter+title */}
  });
 }
 if(sub.anchorPalette!==clone.palette){sub.anchorPalette=clone.palette;sub.anchorEl.setAttribute('data-palette',str(clone.palette)||'neutral');try{sub.anchorMascot?.setPalette?.(clone.palette);}catch{}}
 const letter=str(clone.letter);
 if(sub.anchorLetter!==letter){sub.anchorLetter=letter;sub.anchorLetterEl.textContent=letter;sub.anchorLetterEl.hidden=!letter;}
 const title=str(clone.title)||sub.title;
 if(sub.anchorTitle!==title){sub.anchorTitle=title;sub.anchorTitleEl.textContent=title;sub.anchorTitleEl.hidden=!title;}
}
function centroid(points){
 let lng=0,lat=0;for(const p of points.values()){lng+=p.lng;lat+=p.lat;}
 const n=Math.max(1,points.size);return[lng/n,lat/n];
}
function buildSpec(){
 const dots=[],anchors=[];
 for(const sub of subs.values()){
  const clone=cloneOf(sub),tone=clone?str(clone.palette)||'neutral':'neutral';
  for(const [eid,p] of sub.points)dots.push({id:`${sub.id}|${eid}`,position:[p.lng,p.lat],tone,dim:sub.dim,highlight:sub.highlight.has(eid),title:`${clone?str(clone.letter)+' · ':''}${eid}`});
  if(clone&&!sub.retired&&sub.points.size){
   sub.anchorPos=centroid(sub.points);
   ensureAnchor(sub,clone);
   anchors.push({id:sub.id,position:sub.anchorPos,node:sub.anchorEl,title:`分身 ${str(clone.letter)} · ${str(clone.title)||sub.title}`});
  }
 }
 stats.dots=dots.length;stats.anchors=anchors.length;
 return{dots,anchors,onAnchor:notifyAnchor};
}
function rectCenter(el){
 try{const r=el?.getBoundingClientRect?.();
  if(r&&finite(r.left)&&finite(r.top)&&(r.width>0||r.height>0))return{x:r.left+(finite(r.width)?r.width/2:0),y:r.top+(finite(r.height)?r.height/2:0)};}catch{}
 return null;
}
function originCenter(){
 const o=context.origin;
 return o&&finite(o.left)&&finite(o.top)?{x:o.left+(finite(o.width)?o.width/2:0),y:o.top+(finite(o.height)?o.height/2:0)}:null;
}
function startCenter(sub){
 // Preferred origin: this clone's own card-row face in the team strip — its
 // layout box survives the anchored visibility handoff. ctx.origin (the card
 // main face rect) is the documented fallback when the row isn't found.
 try{
  const strip=document.getElementById?.('mascot-team-strip');
  for(const row of strip?.querySelectorAll?.('[data-subagent-id]')??[])
   if(row.getAttribute?.('data-subagent-id')===sub.id)
    return rectCenter(row.querySelector?.('boop-face'))??rectCenter(row)??originCenter();
 }catch{}
 return originCenter();
}
// A flight ends exactly once: the WAAPI handle is cancelled, the proxy node
// leaves the DOM, and the visual always returns to its real geo anchor — a
// cancelled flight lands instantly rather than stranding an empty marker.
function endFlight(sub,flight){
 if(!flight||sub.flight!==flight)return;
 sub.flight=null;
 if(flight.timer){clearTimeout(flight.timer);timers.delete(flight.timer);}
 try{flight.animation?.cancel?.();}catch{}
 try{flight.proxy?.remove?.();}catch{}
 if(sub.anchorEl&&sub.anchorVisual){sub.anchorVisual.remove?.();sub.anchorEl.append(sub.anchorVisual);}
}
function decorateEntrance(sub){
 // Decorative card→map flight: the anchor's own visual rides a fixed overlay
 // proxy from the clone's card face to the geo point the marker is already
 // anchored at (map host + card sit below the overlay, so the whole path is
 // visible). The marker itself never moves — SDK positioning, geo anchoring
 // and anchored reporting are untouched; no WAAPI/reduced-motion → the
 // anchor simply appears in place.
 if(sub.entered||!sub.anchorEl||sub.flight)return;
 sub.entered=true;
 if(reduced())return;
 const visual=sub.anchorVisual,from=startCenter(sub),to=mapApi()?.point?.(sub.anchorPos);
 if(!visual||!from||!to||!finite(to.x)||!finite(to.y))return;
 const dx=to.x-from.x,dy=to.y-from.y,dist=Math.hypot(dx,dy);
 if(!Number.isFinite(dist)||dist<24)return;         // coincident → just appear
 const body=typeof document!=='undefined'?document.body:null;
 const proxy=body?document.createElement('div'):null;
 if(!proxy||typeof proxy.animate!=='function')return;
 proxy.className='wander-candidate-flight';
 proxy.setAttribute('aria-hidden','true');
 const lift=Math.min(64,dist*.16);
 const keys=[
  {transform:`translate(${from.x}px,${from.y}px) scale(.82)`,offset:0},
  {transform:`translate(${from.x+dx*.55}px,${Math.min(from.y,to.y)-lift}px) scale(.98)`,offset:.55},
  {transform:`translate(${to.x}px,${to.y}px) scale(1)`,offset:1}];
 proxy.style.transform=keys[0].transform;
 visual.remove?.();proxy.append(visual);body.append(proxy);
 const flight={proxy,visual,pos:sub.anchorPos?[sub.anchorPos[0],sub.anchorPos[1]]:null,animation:null,timer:null};
 sub.flight=flight;
 const finish=()=>endFlight(sub,flight);
 try{flight.animation=proxy.animate(keys,{duration:FLIGHT_MS,easing:'cubic-bezier(.3,.7,.25,1)',fill:'forwards'});}
 catch{finish();return;}
 if(flight.animation?.finished?.then)flight.animation.finished.then(finish,finish);
 else{finish();return;}
 flight.timer=later(finish,FLIGHT_MS+240);          // failsafe vs a stalled clock
}
// Renders stay legal while closed so settle can paint the final dim/retract
// frame; only stale tokens (guarded callers) or a destroyed facade block work.
// epoch invalidates in-flight renders: a render that resolves after teardown
// belongs to a dead round and must neither draw nor clear the newer layer.
async function render(){
 if(destroyed||round===null)return;
 const map=mapApi();
 if(!map||!map.ready)return;               // recorded only; wander:map-ready retries
 const r=round,ep=epoch,seq=++renderSeq;
 const ok=await map.render(buildSpec()).catch(()=>false);
 // epoch catches cross-round staleness; renderSeq catches same-round races: a
 // superseded render (the renderer itself may report it stale via `false`)
 // must not clear, revoke, or decorate over the newer render's layer.
 if(destroyed||round!==r||epoch!==ep||seq!==renderSeq)return;
 if(ok!==true){
  // Current-round failure: clear the renderer and revoke every real anchor so
  // the card restores faces; subs keep their real points and the next
  // applyEvent/sync/viewport retries the draw.
  try{map.clear?.();}catch{}
  for(const id of[...anchored])notifyAnchor(id,false);
  return;
 }
 // A new centroid (late-arriving candidates) repositions the marker at once;
 // a proxy still flying to the stale point would land off-target — land the
 // visual inside the moved anchor instead.
 for(const sub of subs.values()){const p=sub.flight?.pos;if(p&&sub.anchorPos&&(p[0]!==sub.anchorPos[0]||p[1]!==sub.anchorPos[1]))endFlight(sub,sub.flight);}
 for(const sub of subs.values())if(!sub.entered&&sub.anchorEl&&anchored.has(sub.id))decorateEntrance(sub);
}
function scheduleRender(){if(renderQueued)return;renderQueued=true;Promise.resolve().then(()=>{renderQueued=false;render().catch(()=>{});});}
function mergeContext(ctx){
 if(Array.isArray(ctx.clones))context={...context,clones:ctx.clones.slice(0,8).filter(c=>c&&typeof c.id==='string'&&c.id).map(c=>({id:c.id,title:str(c.title),letter:str(c.letter),palette:str(c.palette)}))};
 if(ctx.origin&&typeof ctx.origin==='object'&&finite(ctx.origin.left)&&finite(ctx.origin.top))context={...context,origin:{left:ctx.origin.left,top:ctx.origin.top,width:finite(ctx.origin.width)?ctx.origin.width:0,height:finite(ctx.origin.height)?ctx.origin.height:0}};
}
function ingestPoint(sub,eid,lat,lng,stop){
 if(typeof eid!=='string'||!eid||eid.length>256||!validPoint(lat,lng))return false;
 const known=sub.points.get(eid);
 if(known){known.lat=lat;known.lng=lng;if(stop)known.stop=true;return true;}
 if(sub.points.size>=PER_SUB_LIMIT||totalPoints()>=TOTAL_LIMIT){dropped++;return false;}
 sub.points.set(eid,{lat,lng,stop});
 return true;
}
function onSpawn(evt){
 const id=str(evt.subagent_id);if(!id)return;
 const sub=ensureSub(id);
 if(!sub.title)sub.title=str(evt.title);
}
function onTool(evt){
 const sid=str(evt.subagent_id);if(!sid)return;
 if(evt.name==='search_events'&&evt.status==='completed'&&Array.isArray(evt.candidates)){
  const sub=ensureSub(sid);
  for(const c of evt.candidates)if(c&&typeof c==='object')ingestPoint(sub,c.event_id,c.latitude,c.longitude,false);
  scheduleRender();
 }
}
function onDone(evt){
 const sid=str(evt.subagent_id),sub=subs.get(sid);if(!sub)return;
 sub.status=str(evt.status)||'completed';
 if(sub.status==='completed'&&evt.kind==='itinerary'&&Array.isArray(evt.stops)){
  let count=0;
  for(const s of evt.stops){
   if(count>=STOP_LIMIT)break;
   if(s&&typeof s==='object'&&ingestPoint(sub,s.event_id,s.latitude,s.longitude,true)){sub.highlight.add(str(s.event_id));count++;sub.stopCount++;}
  }
 }
 const beat=!reduced()&&sub.status==='completed'&&sub.highlight.size>0;
 if(beat){scheduleRender();later(()=>{sub.retired=true;sub.highlight.clear();scheduleRender();},HIGHLIGHT_MS);}
 else{sub.retired=true;sub.highlight.clear();scheduleRender();}
}
function adoptedIds(result){
 const ids=new Set(),scan=it=>{if(Array.isArray(it?.stops))for(const s of it.stops)if(s&&typeof s.event_id==='string'&&s.event_id)ids.add(s.event_id);};
 if(result&&typeof result==='object'){
  if(Array.isArray(result.plans))for(const p of result.plans)scan(p?.itinerary);
  scan(result.itinerary);
 }
 return ids;
}
function teardownAll(){
 epoch++;                                        // invalidate in-flight renders
 for(const t of timers)clearTimeout(t);timers.clear();
 for(const sub of subs.values())endFlight(sub,sub.flight);
 for(const sub of subs.values()){sub.anchorEl?.remove?.();sub.anchorEl=sub.anchorVisual=sub.anchorFace=sub.anchorLetterEl=sub.anchorTitleEl=sub.anchorMascot=sub.anchorPos=null;}
 subs.clear();dropped=0;
 for(const id of [...anchored])notifyAnchor(id,false);
 try{mapApi()?.clear?.();}catch{}
 context={clones:[],origin:null};
 stats.dots=stats.anchors=0;
}
function guard(api,token){
 if(token===undefined||token===null)throw new TypeError(`WanderCandidates.${api}: round token is required`);
 if(destroyed||closed||token!==round)return null;
 return true;
}
const onMapReady=()=>scheduleRender();
// Viewport moves/focus re-target the anchor mid-flight: the fixed proxy would
// land on a stale point, so the visual lands instantly at the true position.
const onRefresh=()=>{for(const sub of subs.values())if(sub.flight)endFlight(sub,sub.flight);try{mapApi()?.refresh?.();}catch{}scheduleRender();};
// Global reset has no token: it unconditionally clears layer+timers and
// invalidates pending renders (incl. a settle still inside its gray fade).
// Round-scoped cancel(token) stays the strict path that can't hit a new round.
const onReset=()=>{if(round===null)return;closed=true;teardownAll();};
if(typeof window!=='undefined'&&window.addEventListener){
 window.addEventListener('wander:map-ready',onMapReady);
 window.addEventListener('wander:viewport',onRefresh);
 window.addEventListener('wander:itinerary-focus',onRefresh);
 window.addEventListener('wander:reset',onReset);
}
window.WanderCandidates={
 begin(token){
  if(token===undefined||token===null)throw new TypeError('WanderCandidates.begin: round token is required');
  if(destroyed)return null;
  teardownAll();
  round=token;closed=false;
  return{round};
 },
 applyEvent(evt,token,ctx){
  if(guard('applyEvent',token)!==true)return null;
  if(ctx&&typeof ctx==='object')mergeContext(ctx);
  if(!evt||typeof evt!=='object')return{};
  const type=evt.type??'stage';
  if(type==='subagent_spawned')onSpawn(evt);
  else if(type==='tool_call')onTool(evt);
  else if(type==='subagent_done')onDone(evt);
  return{};
 },
 sync(token,ctx){
  if(guard('sync',token)!==true)return null;
  if(ctx&&typeof ctx==='object')mergeContext(ctx);
  scheduleRender();
  return{};
 },
 settle(result,token){
  if(guard('settle',token)!==true)return null;
  closed=true;
  const ids=adoptedIds(result);
  if(!ids.size){teardownAll();return{adopted:0};}
  // Adopted ids hand off to the route layer immediately (no double-draw);
  // losers gray out, then the whole layer is reclaimed on a short beat.
  for(const sub of subs.values()){
   for(const eid of [...sub.points.keys()])if(ids.has(eid))sub.points.delete(eid);
   sub.retired=true;sub.highlight.clear();sub.dim=true;
  }
  scheduleRender();
  later(teardownAll,FADE_MS);
  return{adopted:ids.size};
 },
 cancel(token){
  if(guard('cancel',token)!==true)return null;
  closed=true;
  teardownAll();
  return{};
 },
 dispose(){
  if(destroyed)return;
  destroyed=true;closed=true;
  teardownAll();
  if(typeof window!=='undefined'&&window.removeEventListener){
   window.removeEventListener('wander:map-ready',onMapReady);
   window.removeEventListener('wander:viewport',onRefresh);
   window.removeEventListener('wander:itinerary-focus',onRefresh);
   window.removeEventListener('wander:reset',onReset);
  }
 },
 snapshot(){
  return{round,closed,destroyed,
   subs:[...subs.values()].map(s=>{const c=cloneOf(s);return{id:s.id,title:c?.title||s.title,letter:c?.letter??null,palette:c?.palette??null,status:s.status,points:s.points.size,stops:s.stopCount,retired:s.retired,anchored:anchored.has(s.id),flying:Boolean(s.flight),anchorPos:s.anchorPos?[s.anchorPos[0],s.anchorPos[1]]:null};}),
   aggregate:[...subs.values()].reduce((n,s)=>n+(cloneOf(s)?0:s.points.size),0),
   anchored:[...anchored],dots:stats.dots,anchors:stats.anchors,dropped};
 },
};
})();

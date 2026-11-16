'use strict';
// Card mascot + clone-team facade (issue #41). One persistent boop-face lives
// in the card header; per-request subagent clones mount into #mascot-team-strip
// via mascot-team.js, an ES module loaded lazily behind the face module.
// The facade stays synchronous so chat.js can drive everything before either
// import resolves: begin() mints a local monotonic round and the current
// round's frames buffer in order until the team lands, then replay once —
// replay never re-fans the map layer. If the round already settled/cancelled
// the late module must not resurrect clones; the terminal face still commits.
// Round discipline: applyEvent/settle/cancel require the live facade round —
// a missing token throws, a stale one noops. team.begin() mints its own
// token; the facade maps round → teamRound and never assumes they are equal.
// Every real frame fans out to window.WanderCandidates exactly once, carrying
// the team's real snapshot (≤3 visible clones + card-face origin) as context.
(() => {
 const STAGE_STATE=Object.assign(Object.create(null),{searching_events:'searching',exploring_plans:'thinking',routing:'thinking',validating_schedule:'validating'});
 const KIND_STATE=Object.assign(Object.create(null),{plans:'happy',itinerary:'happy',answer:'happy',clarification:'asking',error:'confused'});
 const BUFFER_LIMIT=400;    // replay bound — a live round emits a handful of frames
 let controller=null,current='idle',pending='idle';
 function commit(next){pending=next;current=next;if(controller)try{controller.setState(next);}catch{/* a broken face must not break chat */}}
 const card=document.querySelector('.glass-card');
 const strip=document.getElementById?.('mascot-team-strip')||document.querySelector?.('#mascot-team-strip')||null;
 let face=null;
 let round=0,open=false;              // open: live round not yet settled/cancelled
 let team=null,teamRound=null;        // lazily imported orchestrator + its own round token
 let buffer=[];                       // ordered real frames awaiting the team import
 const anchoredIds=new Map();         // map-anchored clone ids this round; replays into late mounts
 const fanout=(method,...args)=>{try{window.WanderCandidates?.[method]?.(...args);}catch{/* the map layer must never break the card */}};
 function rectOf(el){try{const r=el?.getBoundingClientRect?.();return r?{left:r.left,top:r.top,width:r.width,height:r.height}:null;}catch{return null;}}
 function ctx(){
  if(!team)return undefined;          // no snapshot yet — the map records raw frames only
  const clones=team.snapshot().clones.map(({id,title,letter,palette})=>({id,title,letter,palette})),origin=rectOf(face)||rectOf(strip);
  return origin?{clones,origin}:{clones};
 }
 function syncStrip(){                // zero footprint when nothing is mounted
  if(!strip)return;
  const snap=team?team.snapshot():null;
  const active=Boolean(snap&&(snap.active>0||snap.overflow>0||snap.nested>0));
  strip.hidden=!active;card?.classList.toggle('team-live',active);
 }
 const frameType=e=>e&&typeof e==='object'?e.type??'stage':'stage';
 function bufferEvent(evt){
  if(buffer.length<BUFFER_LIMIT){buffer.push(evt);return;}
  const at=buffer.findIndex(e=>frameType(e)!=='subagent_spawned'&&frameType(e)!=='subagent_done');
  if(at<0)return;                    // lifecycle frames are never dropped
  buffer.splice(at,1);buffer.push(evt);
 }
 function safeApply(evt){
  if(!team||teamRound===null)return null;
  try{return team.applyEvent(evt,teamRound);}catch{return null;}
 }
 function onTeamReady(){
  if(open&&team){
   const res=team.begin();teamRound=res?res.round:null;
   let faceHint;                       // frames already drove the face live — replay commits once
   for(const evt of buffer){const out=safeApply(evt);if(out?.mainFace)faceHint=out.mainFace;}
   if(faceHint&&faceHint!==current)commit(faceHint);
   buffer=[];
   for(const[id,on]of anchoredIds)try{team.setAnchored(id,on,teamRound);}catch{/* display-only */}
   if(open)fanout('sync',round,ctx());   // one backfill after replay — real identities, not guesses
  }else buffer=[];
  syncStrip();
 }
 function guard(api,token){
  if(token===undefined||token===null)throw new TypeError(`WanderMascot.${api}: round token is required`);
  return token===round&&open?true:null;
 }
 const api={
  get state(){return current;},
  begin(){
   round+=1;open=true;teamRound=null;buffer=[];anchoredIds.clear();
   commit('thinking');
   if(team){const res=team.begin();teamRound=res?res.round:null;}
   fanout('begin',round);syncStrip();
   return{round};
  },
  applyEvent(evt,token){
   if(guard('applyEvent',token)!==true)return null;
   let mainFace;
   if(team&&teamRound!==null){const out=safeApply(evt);if(out?.mainFace)mainFace=out.mainFace;}
   else{
    bufferEvent(evt);
    const stage=frameType(evt)==='stage'?evt.stage:undefined;
    if(typeof stage==='string'&&Object.hasOwn(STAGE_STATE,stage))mainFace=STAGE_STATE[stage];
   }
   if(mainFace)commit(mainFace);
   fanout('applyEvent',evt,round,ctx());
   syncStrip();
   return mainFace?{mainFace}:{};
  },
  settle(result,token){
   if(guard('settle',token)!==true)return null;
   open=false;buffer=[];anchoredIds.clear();
   const raw=typeof result==='string'?result:result?.kind;
   const kind=typeof raw==='string'&&Object.hasOwn(KIND_STATE,raw)?raw:'error';
   let mainFace=KIND_STATE[kind];
   if(team&&teamRound!==null){try{const out=team.settle(kind,teamRound);if(out?.mainFace)mainFace=out.mainFace;}catch{}}
   teamRound=null;commit(mainFace);
   fanout('settle',result&&typeof result==='object'?result:{kind},round);
   syncStrip();
   return{mainFace};
  },
  cancel(token){
   if(guard('cancel',token)!==true)return null;
   open=false;buffer=[];anchoredIds.clear();
   let mainFace='idle';
   if(team&&teamRound!==null){try{const out=team.cancel(teamRound);if(out?.mainFace)mainFace=out.mainFace;}catch{}}
   teamRound=null;commit(mainFace);
   fanout('cancel',round);
   syncStrip();
   return{mainFace};
  },
 };
 window.WanderMascot=api;
 window.addEventListener('wander:reset',()=>{if(open)api.cancel(round);else commit('idle');});
 window.addEventListener('wander:candidate-anchor',event=>{
  // The map layer reports real anchors as {round,subagent_id,anchored} — only
  // the live round applies; the flag replays into clones that mount later.
  const d=event&&event.detail;
  if(!d||d.round!==round||!open||typeof d.subagent_id!=='string')return;
  anchoredIds.set(d.subagent_id,d.anchored===true);
  if(team&&teamRound!==null)try{team.setAnchored(d.subagent_id,d.anchored===true,teamRound);}catch{/* display-only */}
 });
 if(!card)return;
 Promise.resolve().then(()=>import('./wander-mascot.js')).then(({createWanderMascot})=>{
  face=document.createElement('boop-face');
  face.className='card-mascot';
  face.setAttribute('aria-hidden','true');
  face.setAttribute('color','#26382d');
  face.setAttribute('auto-sleep','0');
  face.setAttribute('press-squeeze','false');
  face.setAttribute('antenna-drag','false');
  face.setAttribute('motion','auto');
  card.append(face);
  controller=createWanderMascot(face,{palette:'moss',pointerFollow:true});
  if(pending!=='idle')commit(pending);
  Promise.resolve().then(()=>import('./mascot-team.js')).then(({createMascotTeam})=>{
   if(!strip)return;
   try{team=createMascotTeam(strip,{createMascot:(el,opts)=>createWanderMascot(el,opts),cloneSize:44});onTeamReady();}
   catch(error){console.error('分身编排初始化失败:',error);}
  }).catch(error=>{
   // Degraded: no clone team — the face, stages and map fanout keep working.
   console.error('分身编排加载失败:',error);
  });
 }).catch(error=>{
  // Degraded: no mascot, but every WanderMascot call stays a safe no-op and
  // the text progress bubble keeps reporting the real request state.
  face?.remove();face=null;
  console.error('漫游小伙伴加载失败:',error);
 });
})();

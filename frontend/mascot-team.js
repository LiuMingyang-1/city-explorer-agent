// Mascot clone team — issue #40 (I40-F2), contract docs/issue-40/mascot-states.md.
// Consumes real PlannerProcessEvent frames only. Owns clone DOM (boop-face +
// badge/title/note + overflow/nested aggregates), never the main face — calls
// return a mainFace suggestion for the caller (preview driver / #41 facade).
// Honesty: stage NEVER reclaims pending clones (only same-id subagent_done, a
// real round end, or destroy); tool_call is an end event (badge pulse + real
// result_count, no fake searching); late frames need the live round token —
// missing token throws, stale token noops.

const STAGE_FACE=new Map([['searching_events','searching'],['exploring_plans','thinking'],
 ['routing','thinking'],['validating_schedule','validating']]);
const SETTLE_FACE=new Map([['plans','happy'],['itinerary','happy'],['answer','happy'],
 ['clarification','asking'],['error','confused']]);
const DONE_FACE=new Map([['completed','happy'],['failed','confused'],['cancelled','idle']]);
const LETTERS='ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ENTER_MS=220,EXIT_MS=380,PULSE_MS=900; // decorative beats; business state never waits on them

export function createMascotTeam(container,{
 createMascot,maxVisible=3,palettes=['sand','clay','moss'],cloneSize=56,reduced,now,
}={}){
 if(!container||typeof container.append!=='function')throw new TypeError('mascot-team: container element is required');
 if(typeof createMascot!=='function')throw new TypeError('mascot-team: createMascot(faceEl, opts) is required');
 const clock=typeof now==='function'?now:()=>Date.now();
 const isReduced=typeof reduced==='function'?reduced
  :()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
 const slotCount=Math.max(1,Math.floor(maxVisible)||1);
 const paletteAt=i=>palettes[((i%palettes.length)+palettes.length)%palettes.length]||'moss';
 container.classList.add('mascot-team');

 let round=null,closed=true,destroyed=false;      // round token: null until first begin()
 let phase='idle',beat=null,stageHint='thinking';
 let rootRunId,dispatchSeq=0;                     // rootRunId: first spawn's parent_run_id = round root run
 const alive=new Map(),waiting=[],tombstones=new Map(),nested=new Map(),orphans=new Set();
 const exiting=new Set();     // done recs still playing their decorative exit beat
 const slotOwner=new Array(slotCount).fill(null);
 let overflowEl=null,nestedEl=null;

 const attached=el=>Boolean(el&&(el.parentNode||el.parent));
 const attrs=(el,pairs)=>{for(const k in pairs)el.setAttribute(k,pairs[k]);};
 const pinIndicators=()=>{                        // indicators always trail the clone row
  for(const el of [overflowEl,nestedEl]){
   if(!el||!el.textContent)continue;              // '' textContent keeps an indicator detached
   if(attached(el))el.remove();
   container.append(el);
  }
 };
 function renderIndicator(which,cls,n,text,label){
  let el=which==='overflow'?overflowEl:nestedEl;
  if(n>0){
   if(!el){el=document.createElement('span');el.className=cls;}
   el.textContent=text;
   attrs(el,{title:label,'aria-label':label});
  }else if(el){el.textContent='';if(attached(el))el.remove();}
  if(which==='overflow')overflowEl=el;else nestedEl=el;
  pinIndicators();
 }
 const nestedCount=()=>orphans.size+[...nested.values()].filter(item=>!item.done).length;
 const renderOverflow=()=>renderIndicator('overflow','mascot-team-overflow',waiting.length,`+${waiting.length}`,`等待池还有 ${waiting.length} 个分身`);
 const renderNested=()=>renderIndicator('nested','mascot-team-nested',nestedCount(),`⧉${nestedCount()}`,`嵌套子任务活动 ${nestedCount()} 个`);

 const labelClone=rec=>attrs(rec.el,{title:`分身·${rec.title||rec.letter}·${rec.status}`,'aria-label':`分身·${rec.title||rec.letter}·${rec.status}`});
 function armPulse(rec){
  if(!rec.el)return;
  if(rec.pulseTimer)clearTimeout(rec.pulseTimer);
  rec.pulseTimer=setTimeout(()=>{
   rec.pulseTimer=null;rec.activity='';
   if(rec.el)rec.el.setAttribute('data-activity','');
  },PULSE_MS);
 }
 const domFaces=()=>exiting.size+[...alive.values()].reduce((n,r)=>n+(r.el?1:0),0);
 function mount(rec,slotIndex){
  // A real arrival outranks a still-playing exit beat: visible faces never exceed slots.
  while(exiting.size&&domFaces()>=slotCount)dropEl(exiting.values().next().value);
  rec.slot=slotIndex;
  rec.palette=paletteAt(slotIndex);                // palette follows the slot, not the clone
  slotOwner[slotIndex]=rec;
  const el=document.createElement('div');
  el.className='mascot-team-clone';
  attrs(el,{'data-palette':rec.palette,'data-status':isReduced()?'working':'entering','data-activity':rec.activity});
  const face=document.createElement('boop-face');
  face.style.width=face.style.height=`${cloneSize}px`;
  if(isReduced())face.setAttribute('motion','reduce');
  const badge=document.createElement('span');
  badge.className='mascot-team-badge';
  badge.textContent=rec.letter;                    // dispatch-order letter, never innerHTML
  attrs(badge,{title:`派发序 ${rec.letter}`,'aria-label':`派发序 ${rec.letter}`});
  const title=document.createElement('span');
  title.className='mascot-team-title';
  title.textContent=rec.title;
  const note=document.createElement('span');
  note.className='mascot-team-note';
  note.textContent=rec.noteText;
  el.append(face,badge,title,note);
  container.append(el);
  rec.el=el;rec.noteEl=note;
  labelClone(rec);
  try{
   rec.mascot=createMascot(face,{palette:rec.palette,pointerFollow:false});
   rec.mascot?.setState?.('thinking');              // working posture; a broken face never breaks the team
  }catch{/* degraded clone stays a static DOM marker */}
  if(rec.activity)armPulse(rec);
  if(isReduced())rec.entered=true;
  else rec.enterTimer=setTimeout(()=>{
   rec.enterTimer=null;
   if(alive.get(rec.id)===rec&&rec.el&&!rec.entered){rec.entered=true;rec.el.setAttribute('data-status','working');}
  },ENTER_MS);
  pinIndicators();
 }
 function dropEl(rec){
  exiting.delete(rec);
  for(const key of ['enterTimer','exitTimer','pulseTimer'])if(rec[key]){clearTimeout(rec[key]);rec[key]=null;}
  if(rec.el)rec.el.remove();                       // vendor disconnectedCallback stops its rAF
  rec.el=rec.noteEl=rec.mascot=null;
 }
 function assignSlots(){
  while(waiting.length){
   const free=slotOwner.indexOf(null);
   if(free<0)break;
   mount(waiting.shift(),free);                    // backfill in real spawn order
  }
  renderOverflow();
 }

 function onSpawn(evt){
  const id=typeof evt.subagent_id==='string'?evt.subagent_id:'';
  if(!id||tombstones.has(id)||alive.has(id))return;        // late/finished/duplicate: idempotent
  if(rootRunId===undefined)rootRunId=evt.parent_run_id??null;
  else if(evt.parent_run_id!==rootRunId){                  // real nested dispatch: aggregate only
   orphans.delete(id);
   if(!nested.has(id))nested.set(id,{done:false});
   return renderNested();
  }
  if(orphans.delete(id))renderNested();                    // orphan promoted to top-level: refresh aggregate chip
  dispatchSeq+=1;
  const planId=typeof evt.plan_id==='string'&&evt.plan_id?evt.plan_id:null;
  const rec={id,title:String(evt.title??''),
   letter:(planId??LETTERS[(dispatchSeq-1)%LETTERS.length]).slice(0,2),
   slot:null,palette:null,status:'working',activity:'',noteText:'',entered:false,
   el:null,noteEl:null,mascot:null,enterTimer:null,exitTimer:null,pulseTimer:null};
  alive.set(id,rec);
  beat='dispatching';                                      // each top-level spawn is a dispatch beat
  phase='exploring';
  waiting.push(rec);
  assignSlots();
 }
 function onDone(evt){
  const id=typeof evt.subagent_id==='string'?evt.subagent_id:'';
  if(!id)return;
  const status=typeof evt.status==='string'?evt.status:'completed';
  const title=String(evt.title??'');
  const rec=alive.get(id);
  if(!rec){                                                // done-before-spawn / dup done / nested / orphan
   if(nested.has(id))nested.get(id).done=true;
   else orphans.delete(id);
   if(!tombstones.has(id))tombstones.set(id,{status,title,at:clock()});
   return renderNested();
  }
  tombstones.set(id,{status,title:rec.title||title,at:clock()});
  alive.delete(id);
  const wi=waiting.indexOf(rec);
  if(wi>=0)waiting.splice(wi,1);
  if(rec.slot!==null)slotOwner[rec.slot]=null;             // slot freed for backfill immediately
  rec.status=status;
  if(rec.el){                                              // decorative exit beat, detached from business
   rec.el.setAttribute('data-status',status);
   labelClone(rec);
   try{rec.mascot?.setState?.(DONE_FACE.get(status)??'idle');}catch{/* broken face never breaks the team */}
   exiting.add(rec);
   if(isReduced())dropEl(rec);
   else rec.exitTimer=setTimeout(()=>{rec.exitTimer=null;dropEl(rec);},EXIT_MS);
  }
  assignSlots();
  if(alive.size===0){                                      // every pending clone got its real done
   beat='merging';
   phase=stageHint==='validating'?'validating':'thinking';
  }
 }
 function onTool(evt){
  const sid=typeof evt.subagent_id==='string'?evt.subagent_id:'';
  if(!sid)return;                                          // parent-side end event: not clone business
  const rec=alive.get(sid);
  if(rec){
   const errored=evt.status==='error';
   const searched=!errored&&evt.name==='search_events';
   rec.activity=errored?'error':searched?'searched':'tool';
   if(errored)rec.noteText='调用出错';
   else if(searched)rec.noteText=Number.isFinite(evt.result_count)?`已检索 ${evt.result_count}`:'已检索';
   if(rec.el){
    rec.el.setAttribute('data-activity',rec.activity);
    rec.noteEl.textContent=rec.noteText;
    armPulse(rec);
   }
   return;
  }
  if(nested.has(sid)||tombstones.has(sid))return;          // known nested / late for a finished id
  orphans.add(sid);                                        // unknown stamp: may later promote to top-level
  renderNested();
 }
 function onStage(evt){
  const stage=typeof evt.stage==='string'?evt.stage:'';
  const mainFace=STAGE_FACE.get(stage);                    // own-set only: inherited keys miss
  if(mainFace===undefined)return{};                        // unknown/future stage: nothing changes
  stageHint=stage==='validating_schedule'?'validating':'thinking';
  // Parent stage NEVER touches clone lifecycle: pending clones stay pending.
  phase=stage==='validating_schedule'?'validating':alive.size>0?'exploring':'thinking';
  return{mainFace};
 }

 // Stale token or ended round → null, zero side effects; a missing token is a
 // contract violation: throw, never silently default to the current round.
 function guard(api,token){
  if(token===undefined||token===null)throw new TypeError(`mascot-team.${api}: round token is required`);
  if(destroyed||closed||token!==round)return null;
  return true;
 }
 // Real round end: pending clones removed as "round closed", never marked done.
 function teardown(){
  for(const rec of [...alive.values(),...exiting])dropEl(rec);
  exiting.clear();
  alive.clear();
  waiting.length=0;
  nested.clear();
  orphans.clear();
  slotOwner.fill(null);
  dispatchSeq=0;
  rootRunId=undefined;
  for(const el of [overflowEl,nestedEl])if(el){el.textContent='';if(attached(el))el.remove();}
 }

 return{
  begin(){
   if(destroyed)return null;
   teardown();
   tombstones.clear();
   round=(round??0)+1;
   closed=false;
   phase='thinking';
   stageHint='thinking';
   beat=null;
   return{round,mainFace:'thinking'};
  },
  applyEvent(evt,token){
   if(guard('applyEvent',token)!==true)return null;
   if(!evt||typeof evt!=='object')return{};
   const type=evt.type??'stage';
   if(type==='subagent_spawned'){onSpawn(evt);return{};}
   if(type==='subagent_done'){onDone(evt);return{};}
   if(type==='tool_call'){onTool(evt);return{};}
   if(type==='stage')return onStage(evt);
   return{};                                                // future frame kinds: forward-compat ignore
  },
  settle(kind,token){
   if(guard('settle',token)!==true)return null;
   const mainFace=SETTLE_FACE.get(kind);
   if(mainFace===undefined)throw new TypeError(`mascot-team.settle: unknown kind '${kind}'`);
   teardown();
   closed=true;
   phase='done';
   return{mainFace};
  },
  cancel(token){
   if(guard('cancel',token)!==true)return null;
   teardown();
   closed=true;
   phase='idle';
   return{mainFace:'idle'};
  },
  destroy(){
   if(destroyed)return;
   destroyed=true;
   teardown();
   tombstones.clear();
   container.replaceChildren();                             // every node we ever mounted
   phase='idle';
  },
  snapshot(){
   const clones=[...alive.values()].filter(rec=>rec.slot!==null).sort((a,b)=>a.slot-b.slot)
    .map(rec=>({id:rec.id,title:rec.title,letter:rec.letter,
     palette:rec.palette,status:rec.status,activity:rec.activity}));
   return{round,phase,beat,clones,
    overflow:waiting.length,nested:nestedCount(),
    active:clones.length,pending:alive.size,
    finished:tombstones.size,destroyed};
  },
 };
}

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {Element} from './frontend-fixture.ts';

const previewSource=readFileSync(new URL('../frontend/candidate-preview.js',import.meta.url),'utf8');
const amapSource=readFileSync(new URL('../frontend/amap.js',import.meta.url),'utf8');
const routeVisualsSource=readFileSync(new URL('../frontend/route-visuals.js',import.meta.url),'utf8');
const mapLayoutSource=readFileSync(new URL('../frontend/map-layout.js',import.meta.url),'utf8');
const flush=async()=>{await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));};

const spawnEvt=(id:string,title='探路',plan='A',run='run_p')=>({type:'subagent_spawned',subagent_id:id,plan_id:plan,parent_run_id:run,title,task_summary:'',message:'m'});
const candEvt=(sid:string,cands:any[])=>({type:'tool_call',tool_call_id:'tc'+Math.random(),name:'search_events',args_summary:'',result_count:cands.length,status:'completed',subagent_id:sid,candidates:cands,message:'m'});
const doneEvt=(sid:string,status='completed',stops:any[]|null=null)=>({type:'subagent_done',subagent_id:sid,plan_id:'A',status,...(stops?{kind:'itinerary',stops_count:stops.length,stops}:{kind:'itinerary',stops_count:0}),title:'探路',summary:'',child_run_id:'run_c',child_run_status:'completed',message:'m'});
const ctx1={clones:[{id:'s1',title:'曲江看展',letter:'A',palette:'sand'}],origin:{left:40,top:40,width:88,height:88}};

// ---- WanderCandidates state machine against a stub narrow renderer ----
function setupPreview(){
 const specLog:any[]=[];const anchorCb:{fn:any}= {fn:null};let cleared=0;
 const media={matches:false};
 // WAAPI probe: every element gets a spy animate() whose finished promise
 // stays pending until the test resolves it (or real code cancels it).
 const animCalls:{keyframes:any;options:any;cancelled:boolean;resolve:()=>void}[]=[];
 const mkEl=()=>{const el=new Element();
  (el as any).animate=(keyframes:any,options:any)=>{const h={keyframes,options,cancelled:false,resolve:()=>{}} as any;
   h.finished=new Promise<void>((r:any)=>h.resolve=r);animCalls.push(h);
   return {cancel(){h.cancelled=true},finished:h.finished,onfinish:null};};
  return el;};
 const body=new Element();
 let timerSeq=0;const timers=new Map<number,{cancelled:boolean}>();
 const win=Object.assign(new EventTarget(),{location:{search:''}});
 const context=vm.createContext({
  window:win,console,URL,
  document:{createElement:()=>mkEl(),body,getElementById:()=>null,querySelector:()=>null},
  Event,Promise,queueMicrotask,
  CustomEvent:class extends Event{detail:any;constructor(t:string,i?:any){super(t);this.detail=i?.detail;}},
  matchMedia:()=>media,
  setTimeout:(cb:()=>void,ms=0)=>{if(ms>500)return 0;const id=++timerSeq,token={cancelled:false};timers.set(id,token);queueMicrotask(()=>{timers.delete(id);if(!token.cancelled)cb();});return id;},
  clearTimeout:(id:number)=>{const t=timers.get(id);if(t)t.cancelled=true;timers.delete(id);},
 });
 // The real renderer reports anchor visibility transitions inside render();
 // the stub mirrors that so decorateEntrance sees anchored subs immediately.
 let anchoredNow=new Set<string>();
 const renderer={get ready(){return true},
  render(spec:any){specLog.push(spec);anchorCb.fn=spec.onAnchor;
   const now=new Set<string>((spec.anchors??[]).map((a:any)=>a.id));
   for(const id of now)if(!anchoredNow.has(id))anchorCb.fn?.(id,true);
   for(const id of anchoredNow)if(!now.has(id))anchorCb.fn?.(id,false);
   anchoredNow=now;return Promise.resolve(true);},
  clear(){cleared++;anchoredNow=new Set()},refresh(){},point(){return{x:200,y:200}}};
 context.window.WanderAMap={candidates:renderer};
 const anchorEvents:any[]=[];
 win.addEventListener('wander:candidate-anchor',(e:any)=>anchorEvents.push(e.detail));
 vm.runInContext(previewSource,context);
 const api=context.window.WanderCandidates;
 return {context,specLog,anchorCb,anchorEvents,api,renderer,media,animCalls,body,get cleared(){return cleared}};
}

test('candidate facade requires round tokens and ignores stale rounds',async()=>{
 const h=setupPreview();const api=h.api;
 assert.throws(()=>api.applyEvent(spawnEvt('s1')),/round token is required/);
 assert.throws(()=>api.settle(null),/round token is required/);
 assert.throws(()=>api.cancel(),/round token is required/);
 assert.throws(()=>api.begin(),/round token is required/);
 assert.equal(api.applyEvent(spawnEvt('s1'),99),null,'no active round → noop');
 api.begin(1);
 assert.equal(api.applyEvent(spawnEvt('s1'),42),null,'stale round → zero side effects');
 assert.equal(api.snapshot().subs.length,0);
 api.cancel(1);assert.equal(api.applyEvent(spawnEvt('s1'),1),null,'closed round rejects late frames');
});

test('stamped candidates draw palette dots and a centroid anchor only for real clones',async()=>{
 const h=setupPreview(),api=h.api;api.begin(1);
 api.applyEvent(spawnEvt('s1','曲江看展'),1);
 api.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9},{event_id:'e2',latitude:34.2,longitude:109.0},
  {event_id:'bad-lat',latitude:Number.NaN,longitude:108.9},{event_id:'bad-lng',latitude:34.2},{latitude:34.2,longitude:108.9},
  {event_id:'bad-range',latitude:123,longitude:108.9}]),1,ctx1);
 await flush();
 const spec=h.specLog.at(-1);
 assert.equal(spec.dots.length,2,'missing/non-finite/out-of-range coords are skipped, never plotted');
 assert(spec.dots.every((d:any)=>d.tone==='sand'),'clone palette comes from context, never guessed');
 assert.equal(spec.anchors.length,1);assert.equal(spec.anchors[0].id,'s1');
 assert.deepEqual([...spec.anchors[0].position],[108.95,34.2],'anchor is the real candidates centroid');
 h.anchorCb.fn('s1',true);
 assert.equal(h.anchorEvents.length,1);
 assert.deepEqual({...h.anchorEvents[0]},{round:1,subagent_id:'s1',anchored:true});
 h.anchorCb.fn('s1',false);h.anchorCb.fn('s1',false);
 assert.equal(h.anchorEvents.length,2,'only real transitions dispatch');
});

test('unknown or waiting ids stay aggregated without identity or anchors',async()=>{
 const h=setupPreview(),api=h.api;api.begin(1);
 api.applyEvent(candEvt('ghost',[{event_id:'g1',latitude:34.21,longitude:108.96}]),1,ctx1);
 await flush();
 const spec=h.specLog.at(-1);
 assert.equal(spec.dots.length,1);assert.equal(spec.dots[0].tone,'neutral');
 assert.equal(spec.anchors.length,0,'no clone in context → no fake avatar');
 const snap=api.snapshot();
 assert.equal(snap.aggregate,1);assert.equal(snap.subs.find((s:any)=>s.id==='ghost').palette,null);
 api.sync(1,{clones:[{id:'ghost',title:'转正',letter:'B',palette:'clay'}],origin:ctx1.origin});
 await flush();
 const next=h.specLog.at(-1);
 assert.equal(next.dots[0].tone,'clay','promoted clone gets real palette on sync');
 assert.equal(next.anchors.length,1);
});

test('done stops highlight briefly then the anchor retracts while candidates remain',async()=>{
 const h=setupPreview(),api=h.api;api.begin(1);
 api.applyEvent(spawnEvt('s1','曲江看展'),1);
 api.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
 await flush();
 api.applyEvent(doneEvt('s1','completed',[{event_id:'e1',latitude:34.2,longitude:108.9},{event_id:'e3',latitude:34.22,longitude:108.92}]),1);
 await flush();
 const beat=h.specLog.find((s:any)=>s.dots.some((d:any)=>d.highlight));
 assert(beat,'stops are highlighted during the beat');
 assert.equal(beat.dots.length,2,'real stops join the candidate set');
 assert.equal(beat.anchors.length,1,'anchor survives the short highlight beat');
 const after=h.specLog.at(-1);
 assert.equal(after.anchors.length,0,'anchor retracts after the beat');
 assert(after.dots.every((d:any)=>!d.highlight));
});

test('settle hands adopted ids to the route layer, dims losers, then reclaims',async()=>{
 const h=setupPreview(),api=h.api;api.begin(1);
 api.applyEvent(candEvt('s1',[{event_id:'keep',latitude:34.2,longitude:108.9},{event_id:'lose',latitude:34.21,longitude:108.91}]),1,ctx1);
 await flush();
 const result=api.settle({kind:'plans',plans:[{plan_id:'a',itinerary:{stops:[{event_id:'keep'}]}}]},1);
 assert.equal(result.adopted,1);
 await flush();
 const spec=h.specLog.at(-1);
 assert.equal(spec.dots.length,1);assert.equal(spec.dots[0].id,'s1|lose');assert.equal(spec.dots[0].dim,true);
 assert.equal(spec.anchors.length,0);
 await flush();
 assert(h.cleared>0,'layer fully reclaimed after the gray beat');
 assert.equal(api.snapshot().subs.length,0);
});

test('non-plan settle and cancel clear immediately; new begin breaks old fades',async()=>{
 const h=setupPreview(),api=h.api;api.begin(1);
 api.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
 await flush();
 api.settle({kind:'answer'},1);
 assert(h.cleared>0);assert.equal(api.snapshot().dots,0);
 api.begin(2);
 api.applyEvent(candEvt('s2',[{event_id:'x1',latitude:34.2,longitude:108.9}]),2,{clones:[{id:'s2',title:'t',letter:'A',palette:'moss'}]});
 await flush();assert.equal(h.specLog.at(-1).dots.length,1);
 api.cancel(2);assert.equal(api.snapshot().subs.length,0);
 // A begin arriving mid-fade must still wipe the prior round completely.
 api.begin(3);api.applyEvent(candEvt('s3',[{event_id:'y1',latitude:34.2,longitude:108.9},{event_id:'y2',latitude:34.21,longitude:108.91}]),3,{clones:[{id:'s3',title:'t',letter:'A',palette:'sand'}]});
 await flush();api.settle({kind:'plans',plans:[{itinerary:{stops:[{event_id:'y1'}]}}]},3);
 api.begin(4);
 await flush();assert.equal(api.snapshot().subs.length,0);assert.equal(h.specLog.at(-1)?.dots?.length??0,0);
});

test('candidate ingest is bounded per sub and overall',async()=>{
 const h=setupPreview(),api=h.api;api.begin(1);
 api.applyEvent(candEvt('s1',Array.from({length:40},(_,i)=>({event_id:'e'+i,latitude:34.2,longitude:108.9}))),1,ctx1);
 api.applyEvent(candEvt('s2',Array.from({length:40},(_,i)=>({event_id:'f'+i,latitude:34.22,longitude:108.92}))),1,ctx1);
 api.applyEvent(candEvt('s3',Array.from({length:40},(_,i)=>({event_id:'g'+i,latitude:34.23,longitude:108.93}))),1,ctx1);
 await flush();
 const snap=api.snapshot();
 assert.equal(snap.subs[0].points,32,'per-sub cap holds');
 assert(snap.dropped>0);
 assert(snap.subs.reduce((n:number,s:any)=>n+s.points,0)<=96,'global cap holds across tool_calls');
});

test('renderer failure revokes real anchors and the next event redraws',async()=>{
 const h=setupPreview(),api=h.api;
 let failNext=false;
 h.renderer.render=(spec:any)=>{h.specLog.push(spec);h.anchorCb.fn=spec.onAnchor;return failNext?Promise.reject(new Error('renderer down')):Promise.resolve(true);};
 api.begin(1);
 api.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
 await flush();
 h.anchorCb.fn('s1',true);
 failNext=true;
 api.applyEvent(candEvt('s1',[{event_id:'e2',latitude:34.21,longitude:108.91}]),1);
 await flush();
 assert(h.cleared>0,'a current-round failure clears the drawn layer');
 assert.deepEqual({...h.anchorEvents.at(-1)},{round:1,subagent_id:'s1',anchored:false},'card face restored on failure');
 assert.equal(api.snapshot().subs[0].points,2,'real points are retained for redraw');
 failNext=false;
 api.applyEvent(candEvt('s1',[{event_id:'e3',latitude:34.22,longitude:108.92}]),1);
 await flush();
 assert.equal(h.specLog.at(-1).dots.length,3,'recovery re-renders the retained set');
});

test('a stale render failure cannot clear a newer round',async()=>{
 const h=setupPreview(),api=h.api;
 const pending:((v:boolean)=>void)[]=[];
 h.renderer.render=(spec:any)=>{h.specLog.push(spec);h.anchorCb.fn=spec.onAnchor;return new Promise(r=>pending.push(r));};
 api.begin(1);
 api.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
 await flush();
 api.begin(2);
 const clearedAfterBegin=h.cleared;
 api.applyEvent(candEvt('s2',[{event_id:'x1',latitude:34.3,longitude:109.1}]),2,{clones:[{id:'s2',title:'t',letter:'A',palette:'moss'}]});
 await flush();
 assert.equal(pending.length,2);
 pending[0](false);                       // round-1 render fails late
 await flush();
 assert.equal(h.cleared,clearedAfterBegin,'stale failure must not wipe the new round');
 assert.equal(api.snapshot().subs.length,1);
 assert.equal(api.snapshot().subs[0].id,'s2');
 pending[1](true);                        // round-2 render succeeds
 await flush();
 assert.equal(h.specLog.at(-1).dots.length,1);
});

test('a superseded render resolving late cannot wipe the newer spec',async()=>{
 const h=setupPreview(),api=h.api;
 // Faithful narrow renderer: an internal epoch like WanderAMap.candidates' —
 // a superseded call resolves `false` without touching markers it did not apply.
 const pending:{mine:number;spec:any;res:(v:boolean)=>void}[]=[];let inner=0;const applied=new Set<string>();
 h.renderer.render=(spec:any)=>{h.specLog.push(spec);h.anchorCb.fn=spec.onAnchor;const mine=++inner;
  return new Promise<boolean>(res=>pending.push({mine,spec,res}));};
 const complete=(i:number)=>{const p=pending[i];
  if(p.mine!==inner){p.res(false);return;}
  for(const id of[...applied])if(!p.spec.anchors.some((a:any)=>a.id===id)){applied.delete(id);h.anchorCb.fn(id,false);}
  for(const a of p.spec.anchors)if(!applied.has(a.id)){applied.add(a.id);h.anchorCb.fn(a.id,true);}
  p.res(true);};
 api.begin(1);
 api.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
 await flush();                                      // render A pending
 api.applyEvent(candEvt('s1',[{event_id:'e2',latitude:34.21,longitude:108.91}]),1);
 await flush();                                      // render B pending
 assert.equal(pending.length,2);
 complete(1);                                        // B (newest) applies: 2 dots + real anchor
 await flush();
 assert.equal(h.specLog.at(-1).dots.length,2);
 assert.deepEqual({...h.anchorEvents.at(-1)},{round:1,subagent_id:'s1',anchored:true});
 const clearedAfter=h.cleared;
 complete(0);                                        // A resolves stale → renderer returns false
 await flush();
 assert.equal(h.cleared,clearedAfter,'a superseded render failure never clears newer markers');
 assert.equal(h.anchorEvents.at(-1).anchored,true,'B anchor stays anchored');
 assert.equal(api.snapshot().subs[0].points,2);
});

test('a superseded render resolving true cannot act on newer state',async()=>{
 const h=setupPreview(),api=h.api;
 const pending:((v:boolean)=>void)[]=[];let points=0;
 h.renderer.render=(spec:any)=>{h.specLog.push(spec);h.anchorCb.fn=spec.onAnchor;return new Promise(r=>pending.push(r));};
 h.renderer.point=()=>{points++;return{x:200,y:200};};
 api.begin(1);
 api.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
 await flush();
 api.applyEvent(candEvt('s1',[{event_id:'e2',latitude:34.21,longitude:108.91}]),1);
 await flush();
 pending[1](true);h.anchorCb.fn('s1',true);await flush();   // newest succeeds + entrance decorates once
 assert(points>0,'entrance ran for the newest render');
 const pts=points,clearedAfter=h.cleared;
 pending[0](true);await flush();                            // stale resolves true late
 assert.equal(points,pts,'stale success re-runs no decoration');
 assert.equal(h.cleared,clearedAfter,'stale success clears nothing');
});

test('a late mascot import never creates a face for a dead round',async()=>{
 const h=setupPreview(),api=h.api;
 const calls:any[]=[];let resolveModule:(m:any)=>void=()=>{};
 h.context.window.__WANDER_MASCOT_MODULE__=new Promise(r=>{resolveModule=r;});
 api.begin(1);
 api.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
 await flush();
 api.cancel(1);                            // round dies while the import is in flight
 resolveModule({createWanderMascot:(_f:any,o:any)=>{calls.push(o);return {setState(){},setPalette(){}};}});
 await flush();
 assert.equal(calls.length,0,'no detached face materializes for a dead round');
 api.begin(2);
 api.applyEvent(candEvt('s2',[{event_id:'x1',latitude:34.3,longitude:109.1}]),2,{clones:[{id:'s2',title:'t',letter:'A',palette:'moss'}]});
 await flush();
 assert.equal(calls.length,1,'a live round still gets its real face');
 assert.equal(calls[0].palette,'moss');
});

test('reset inside the gray fade clears at once and nothing revives',async()=>{
 const h=setupPreview(),api=h.api;api.begin(1);
 api.applyEvent(candEvt('s1',[{event_id:'keep',latitude:34.2,longitude:108.9},{event_id:'lose',latitude:34.21,longitude:108.91}]),1,ctx1);
 await flush();
 api.settle({kind:'plans',plans:[{itinerary:{stops:[{event_id:'keep'}]}}]},1);
 await flush();
 const clearedBefore=h.cleared,specsBefore=h.specLog.length;
 h.context.window.dispatchEvent(new Event('wander:reset'));
 assert.equal(h.cleared,clearedBefore+1,'reset reclaims even a round already settling');
 assert.equal(api.snapshot().subs.length,0);
 await flush();await flush();
 assert.equal(h.specLog.length,specsBefore,'the killed fade cannot paint again');
});

test('a missing or degraded map records without drawing and resets cleanly',async()=>{
 const h=setupPreview(),api=h.api;
 h.context.window.WanderAMap={candidates:{get ready(){return false},render(){return Promise.resolve(false)},clear(){},refresh(){},point(){return null}}};
 api.begin(1);
 api.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
 await flush();
 assert.equal(h.specLog.length,0,'not ready → nothing drawn, state kept');
 assert.equal(api.snapshot().subs[0].points,1);
 // wander:reset tears down an open round the same way facade.cancel does.
 h.context.window.dispatchEvent(new Event('wander:reset'));
 assert.equal(api.snapshot().subs.length,0);
});

// ---- Entrance flight: fixed overlay proxy + WAAPI (decorative only) ----
const flightProxy=(h:any)=>h.body.children.find((c:any)=>c.classes.has('wander-candidate-flight'));
const anchorNode=(h:any)=>h.specLog.map((s:any)=>s.anchors).flat().at(-1)?.node;

test('entrance rides a fixed proxy from the card face to the geo point, then lands',async()=>{
 const h=setupPreview(),api=h.api;api.begin(1);
 api.applyEvent(spawnEvt('s1','曲江看展'),1);
 api.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
 await flush();
 assert.equal(h.animCalls.length,1,'WAAPI drives exactly one flight');
 const call=h.animCalls[0];
 assert(call.options.duration>=450&&call.options.duration<=650,'flight sits in the visible beat window');
 const first=call.keyframes[0].transform,last=call.keyframes.at(-1).transform;
 assert.match(first,/^translate\(84px,84px\)/,'starts at the ctx.origin face center (40+44,40+44)');
 assert.match(last,/translate\(200px,200px\)/,'ends at the real geo point from map.point()');
 const proxy=flightProxy(h);
 assert(proxy,'proxy is mounted on document.body');
 assert.equal(api.snapshot().subs[0].flying,true);
 assert.equal(anchorNode(h).children.length,0,'marker shell is empty while its visual flies');
 call.resolve();await flush();
 assert.equal(api.snapshot().subs[0].flying,false);
 assert(!h.body.children.includes(proxy),'proxy leaves the DOM after landing');
 const inner=anchorNode(h).children[0];
 assert(inner?.classes.has('wander-candidate-visual'),'visual returns inside the real anchor');
 assert.equal(inner.children.length,3,'face + letter + title all land');
});

test('flight origin prefers the clone strip row over the card-face fallback',async()=>{
 const h=setupPreview(),api=h.api;
 const strip=new Element(),row=new Element(),face=new Element();
 (row as any).getAttribute=(n:string)=>n==='data-subagent-id'?'s1':null;
 (row as any).querySelector=(sel:string)=>sel==='boop-face'?face:null;
 (row as any).getBoundingClientRect=()=>({left:500,top:300,width:56,height:80});
 (face as any).getBoundingClientRect=()=>({left:500,top:300,width:44,height:44});
 (strip as any).querySelectorAll=(sel:string)=>sel==='[data-subagent-id]'?[row]:[];
 (h.context.document as any).getElementById=(id:string)=>id==='mascot-team-strip'?strip:null;
 api.begin(1);
 api.applyEvent(spawnEvt('s1','曲江看展'),1);
 api.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
 await flush();
 assert.equal(h.animCalls.length,1);
 assert.match(h.animCalls[0].keyframes[0].transform,/^translate\(522px,322px\)/,'clone face center (500+22,300+22), not ctx.origin');
});

test('reduced-motion and missing WAAPI/origin all land the anchor directly',async()=>{
 const h=setupPreview();h.media.matches=true;const api=h.api;api.begin(1);
 api.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
 await flush();
 assert.equal(h.animCalls.length,0,'RM: no flight, no proxy');
 assert(!flightProxy(h));
 assert.equal(anchorNode(h).children.length,1,'anchor displays in place immediately');
 const h2=setupPreview();const api2=h2.api;
 h2.context.document.createElement=()=>{const el=new Element();(el as any).animate=undefined;return el;};
 api2.begin(1);
 api2.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
 await flush();
 assert.equal(h2.animCalls.length,0,'no WAAPI → direct display');
 assert(!flightProxy(h2));assert.equal(anchorNode(h2).children.length,1);
 const h3=setupPreview();const api3=h3.api;api3.begin(1);
 api3.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,{clones:ctx1.clones});
 await flush();
 assert.equal(h3.animCalls.length,0,'no origin → direct display');
 assert.equal(anchorNode(h3).children.length,1);
});

test('cancel/reset/settle mid-flight leaves no proxy, animation, or stale callback',async()=>{
 for(const end of ['cancel','reset','settle']as const){
  const h=setupPreview(),api=h.api;api.begin(1);
  api.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
  await flush();
  const proxy=flightProxy(h);assert(proxy);
  const call=h.animCalls.at(-1);assert(call);
  if(end==='cancel')api.cancel(1);
  else if(end==='reset')h.context.window.dispatchEvent(new Event('wander:reset'));
  else api.settle({kind:'answer'},1);
  assert.equal(call.cancelled,true,end+': in-flight animation is cancelled');
  assert(!h.body.children.includes(proxy),end+': proxy removed');
  assert.equal(api.snapshot().subs.length,0,end+': subs torn down');
  call.resolve();await flush();                     // a late finish must not revive
  assert.equal(api.snapshot().subs.length,0);assert.equal(h.body.children.length,0);
 }
});

test('losing the anchor mid-flight lands the visual; a later render never replays',async()=>{
 const h=setupPreview(),api=h.api;api.begin(1);
 api.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
 await flush();assert.equal(h.animCalls.length,1);
 // Off-screen/focus → anchored=false: flight cancels and the visual returns.
 h.anchorCb.fn('s1',false);
 assert.equal(api.snapshot().subs[0].flying,false);
 assert(!flightProxy(h),'proxy gone on un-anchor');
 assert.equal(anchorNode(h).children.length,1,'visual back inside its anchor');
 // Back on screen → anchored again: the entrance must not replay.
 h.anchorCb.fn('s1',true);
 api.applyEvent(candEvt('s1',[{event_id:'e2',latitude:34.21,longitude:108.91}]),1);
 await flush();
 assert.equal(h.animCalls.length,1,'no second flight for the same sub');
 // A viewport move during a flight lands it instantly at the true position.
 const h2=setupPreview(),api2=h2.api;api2.begin(1);
 api2.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
 await flush();assert.equal(h2.animCalls.length,1);
 h2.context.window.dispatchEvent(new Event('wander:viewport'));
 assert.equal(api2.snapshot().subs[0].flying,false);
 assert(!flightProxy(h2));
 assert.equal(anchorNode(h2).children.length,1);
});

test('a shifted centroid mid-flight lands the visual inside the moved anchor',async()=>{
 const h=setupPreview(),api=h.api;api.begin(1);
 api.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
 await flush();assert.equal(h.animCalls.length,1);
 const call=h.animCalls[0],proxy=flightProxy(h);
 assert.equal(api.snapshot().subs[0].anchorPos?.[0],108.9,'snapshot exposes the raw centroid for QA');
 api.applyEvent(candEvt('s1',[{event_id:'e2',latitude:34.3,longitude:108.8}]),1);
 await flush();                                    // new point → new centroid → marker moved
 assert.equal(call.cancelled,true,'stale-target flight is cancelled');
 assert(!h.body.children.includes(proxy));
 assert.equal(api.snapshot().subs[0].flying,false);
 assert.equal(anchorNode(h).children.length,1,'visual landed inside the moved anchor');
 call.resolve();await flush();                     // a late finish must not revive
 assert(!flightProxy(h));assert.equal(anchorNode(h).children.length,1);
 // Same-centroid re-render never disturbs a live flight.
 const h2=setupPreview(),api2=h2.api;api2.begin(1);
 api2.applyEvent(candEvt('s1',[{event_id:'e1',latitude:34.2,longitude:108.9}]),1,ctx1);
 await flush();const call2=h2.animCalls[0];
 api2.sync(1);await flush();
 assert.equal(call2.cancelled,false,'identical centroid keeps the flight alive');
 assert.equal(api2.snapshot().subs[0].flying,true);
});

// ---- WanderAMap.candidates narrow renderer on the stub SDK ----
function setupAmap(){
 const calls:number[]=[],scripts:string[]=[],maps:Record<string,unknown>[]=[],markers:any[]=[],instances:any[]=[];
 class Marker {options:Record<string,unknown>;attachedMap:unknown=null;mapCalls:unknown[]=[];listeners=new Map<string,Function>();
  constructor(options:Record<string,unknown>){this.options=options;markers.push(this)}
  on(name:string,callback:Function){this.listeners.set(name,callback)}
  setPosition(position:unknown){this.options.position=position}
  setMap(map:unknown){this.mapCalls.push(map);this.attachedMap=map}}
 class MapMock {shiftX=0;zoom=11;getZoom(){return this.zoom};listeners=new Map<string,Function>();
  constructor(options:Record<string,unknown>){maps.push(options);instances.push(this)}
  addControl(){}add(){}remove(){}on(name:string,callback:Function){this.listeners.set(name,callback)}destroy(){}
  setZoomAndCenter(){}setFitView(){}
  getSize(){return {width:1440,height:900}}
  getContainer(){return {getBoundingClientRect:()=>({left:0,top:0,width:1440,height:900})}}
  lngLatToContainer(p:number[]){return {x:800+(p[0]!-108.95)*20000+this.shiftX,y:400-(p[1]!-34.27)*20000}}}
 const sdk={convertFrom(batch:number[][],_t:string,cb:(s:string,r:object)=>void){calls.push(batch.length);const locations=batch.map(p=>({lng:p[0]!+.006,lat:p[1]!+.004}));locations.forEach((p,i)=>{(batch as unknown[])[i]=p;});cb('complete',{locations})},
  plugin(_p:unknown,done:()=>void){done()},Pixel:class{x:number;y:number;constructor(x:number,y:number){this.x=x;this.y=y}},
  Map:class extends MapMock{constructor(_id:string,o:Record<string,unknown>){super(o)}},ToolBar:class{},Marker,
  Polyline:class extends Marker{},Geocoder:class{},Weather:class{}};
 const document={createElement:()=>new Element(),head:{append(script:Element&{onload:()=>void}){scripts.push(script.src);queueMicrotask(script.onload)}},getElementById:()=>null,querySelector:()=>({getBoundingClientRect:()=>({left:28,right:450,top:28,bottom:872,height:844})})};
 const context=vm.createContext({window:{dispatchEvent(){},AMap:sdk,location:{href:'https://city.example/'}},document,URL,console,Event,innerWidth:1440,setTimeout:()=>0,clearTimeout(){},fetch:async()=>({ok:true,json:async()=>({enabled:true,jsKey:'test-js-key',serviceHost:'/_AMapService',style:'amap://styles/light',backendCoordinateSystem:'WGS84'})}),showMapStatus(){},state:{},queueMicrotask});
 vm.runInContext(routeVisualsSource,context);vm.runInContext(mapLayoutSource,context);vm.runInContext(amapSource,context);
 return {context,calls,scripts,maps,markers,instances,provider:context.window.WanderAMap};
}
const dotSpec=(id:string,lng=108.95,lat=34.27,extra={})=>({id,position:[lng,lat],tone:'sand',title:id,...extra});

test('renderer isolates its marker set and reconciles by id',async()=>{
 const h=setupAmap();await h.provider.init({places:[],onSelect:()=>{}});
 const layer=h.provider.candidates;assert.equal(layer.ready,true);
 const anchors:any[]=[];
 const spec=()=>({dots:[dotSpec('a'),dotSpec('b',108.96)],anchors:[{id:'s1',position:[108.95,34.27],node:new Element(),title:'分身 A'}],onAnchor:(id:string,v:boolean)=>anchors.push([id,v])});
 assert.equal(await layer.render(spec()),true);
 let dotMarks=h.markers.filter(m=>m.options.zIndex===160),anchorMarks=h.markers.filter(m=>m.options.zIndex===180);
 assert.equal(dotMarks.length,2);assert.equal(anchorMarks.length,1);
 assert(dotMarks.every(m=>m.attachedMap),'dots attach to the map');
 assert.deepEqual(anchors,[['s1',true]]);
 // Second render keeps marker identity and only removes what disappeared.
 assert.equal(await layer.render({dots:[dotSpec('b',108.96)],anchors:[],onAnchor:()=>{}}),true);
 dotMarks=h.markers.filter(m=>m.options.zIndex===160);
 assert.equal(dotMarks.length,2,'no remount for retained dots');
 assert.equal(dotMarks.filter(m=>m.attachedMap).length,1,'removed dot detaches');
});

test('renderer epoch guards stale renders and convert stays the single entry',async()=>{
 const h=setupAmap();await h.provider.init({places:[],onSelect:()=>{}});const layer=h.provider.candidates;
 const first=layer.render({dots:[dotSpec('a')]});
 const second=layer.render({dots:[dotSpec('b',108.99)]});
 assert.equal(await first,false,'stale spec must not draw');
 assert.equal(await second,true);
 assert.equal(h.markers.filter(m=>m.options.zIndex===160&&m.attachedMap).length,1);
 assert.equal(h.calls.length,1,'GCJ-02 points pass through convert without SDK calls');
});

test('anchor visibility follows viewport and focus, reporting only real transitions',async()=>{
 const h=setupAmap();await h.provider.init({places:[],onSelect:()=>{}});const layer=h.provider.candidates;
 const seen:any[]=[];
 const spec={dots:[],anchors:[{id:'s1',position:[108.95,34.27],node:new Element(),title:'t'}],onAnchor:(id:string,v:boolean)=>seen.push([id,v])};
 await layer.render(spec);assert.deepEqual(seen,[['s1',true]]);
 h.instances[0].shiftX=-50000;h.instances[0].listeners.get('moveend')();
 assert.deepEqual(seen.at(-1),['s1',false],'off-screen anchor reports false');
 h.instances[0].shiftX=0;h.instances[0].listeners.get('moveend')();
 assert.deepEqual(seen.at(-1),['s1',true],'back on screen reports true');
 h.context.window.WanderItineraryFocus={active:true};
 h.provider.updatePlaces();
 assert.deepEqual(seen.at(-1),['s1',false],'detail focus hides the anchor');
 h.context.window.WanderItineraryFocus={active:false};
 h.provider.updatePlaces();assert.deepEqual(seen.at(-1),['s1',true]);
});

test('clear and dispose release markers and report anchored=false',async()=>{
 const h=setupAmap();await h.provider.init({places:[],onSelect:()=>{}});const layer=h.provider.candidates;
 const seen:any[]=[];
 await layer.render({dots:[dotSpec('a')],anchors:[{id:'s1',position:[108.95,34.27],node:new Element(),title:'t'}],onAnchor:(id:string,v:boolean)=>seen.push([id,v])});
 assert.deepEqual(seen,[['s1',true]]);
 layer.clear();
 assert.deepEqual(seen.at(-1),['s1',false]);
 assert.equal(h.markers.filter(m=>m.options.zIndex>=160&&m.options.zIndex<=180&&m.attachedMap).length,0);
 await layer.render({dots:[dotSpec('a')],anchors:[{id:'s2',position:[108.95,34.27],node:new Element(),title:'t'}],onAnchor:(id:string,v:boolean)=>seen.push([id,v])});
 h.provider.dispose();
 assert.deepEqual(seen.at(-1),['s2',false],'dispose still reports the live anchor retracting');
});

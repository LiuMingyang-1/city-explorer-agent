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
 let timerSeq=0;const timers=new Map<number,{cancelled:boolean}>();
 const win=Object.assign(new EventTarget(),{location:{search:''}});
 const context=vm.createContext({
  window:win,console,URL,
  document:{createElement:()=>new Element(),getElementById:()=>null,querySelector:()=>null},
  Event,Promise,queueMicrotask,
  CustomEvent:class extends Event{detail:any;constructor(t:string,i?:any){super(t);this.detail=i?.detail;}},
  matchMedia:()=>media,
  setTimeout:(cb:()=>void,ms=0)=>{if(ms>500)return 0;const id=++timerSeq,token={cancelled:false};timers.set(id,token);queueMicrotask(()=>{timers.delete(id);if(!token.cancelled)cb();});return id;},
  clearTimeout:(id:number)=>{const t=timers.get(id);if(t)t.cancelled=true;timers.delete(id);},
 });
 const renderer={get ready(){return true},
  render(spec:any){specLog.push(spec);anchorCb.fn=spec.onAnchor;return Promise.resolve(true);},
  clear(){cleared++},refresh(){},point(){return{x:200,y:200}}};
 context.window.WanderAMap={candidates:renderer};
 const anchorEvents:any[]=[];
 win.addEventListener('wander:candidate-anchor',(e:any)=>anchorEvents.push(e.detail));
 vm.runInContext(previewSource,context);
 const api=context.window.WanderCandidates;
 return {context,specLog,anchorCb,anchorEvents,api,renderer,media,get cleared(){return cleared}};
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

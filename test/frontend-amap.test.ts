import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {Element} from './frontend-fixture.ts';
function setup(){
 const calls:number[]=[],scripts:string[]=[],maps:Record<string,unknown>[]=[],lines:Record<string,unknown>[]=[],selections:Record<string,unknown>[]=[],fits:any[][]=[],paddings:any[][]=[],markers:any[]=[],instances:any[]=[];
 class Marker {options:Record<string,unknown>;attachedMap:unknown=null;mapCalls:unknown[]=[];offsetCalls:any[]=[];pathCalls:unknown[]=[];listeners=new Map<string,Function>();setPath(path:unknown){this.options.path=path;this.pathCalls.push(path)}setOptions(options:Record<string,unknown>){Object.assign(this.options,options)}constructor(options:Record<string,unknown>){this.options=options;markers.push(this)}on(name:string,callback:Function){this.listeners.set(name,callback)}setPosition(position:unknown){this.options.position=position}setOffset(offset:any){this.offsetCalls.push(offset);this.options.offset=offset}setMap(map:unknown){this.mapCalls.push(map);this.attachedMap=map}}
 class MapMock {shiftX=0;zoom=11;getZoom(){return this.zoom};listeners=new Map<string,Function>();constructor(options:Record<string,unknown>){maps.push(options);instances.push(this)}addControl(){}add(){}remove(){}on(name:string,callback:Function){this.listeners.set(name,callback)}destroy(){}setZoomAndCenter(){}setFitView(layers:any[],_immediate:boolean,padding:any[]){fits.push(layers);paddings.push(padding)}getSize(){return {width:1440,height:900}}lngLatToContainer(p:number[]){return {x:800+(p[0]!-108.95)*20000+this.shiftX,y:400-(p[1]!-34.27)*20000}}}
 const sdk={convertFrom(batch:number[][],_type:string,callback:(s:string,r:object)=>void){calls.push(batch.length);const locations=batch.map(p=>({lng:p[0]!+.006,lat:p[1]!+.004}));locations.forEach((p,i)=>{(batch as unknown[])[i]=p;});callback('complete',{locations})},plugin(_p:unknown,done:()=>void){done()},Pixel:class{x:number;y:number;constructor(x:number,y:number){this.x=x;this.y=y}},Map:class extends MapMock{constructor(_id:string,options:Record<string,unknown>){super(options)}},ToolBar:class{constructor(o:{position:string;offset:number[]}){maps.push({toolbar:o})}},Marker,Polyline:class extends Marker{constructor(o:Record<string,unknown>){super(o);lines.push(o)}},Geocoder:class{getAddress(_point:unknown,cb:(s:string,r:object)=>void){cb('complete',{regeocode:{addressComponent:{adcode:'610100',district:'雁塔区'}}})}},Weather:class{getLive(_city:string,cb:(s:string|null,r:object)=>void){cb(null,{temperature:'22',weather:'晴'})}}};
 const document={createElement:()=>new Element(),head:{append(script:Element&{onload:()=>void}){scripts.push(script.src);queueMicrotask(script.onload)}},querySelector:()=>({getBoundingClientRect:()=>({left:28,right:450,top:28,bottom:872,height:844})})};
 const context=vm.createContext({window:{dispatchEvent(){},AMap:sdk,location:{href:'https://city.example/'}},document,URL,console,Event,AbortController,innerWidth:1440,setTimeout:()=>0,clearTimeout(){},fetch:async()=>({ok:true,json:async()=>({enabled:true,jsKey:'test-js-key',serviceHost:'/_AMapService',style:'amap://styles/light',backendCoordinateSystem:'WGS84'})}),showMapStatus(){},state:{},});
 vm.runInContext(readFileSync(new URL('../frontend/route-visuals.js',import.meta.url),'utf8'),context);
 vm.runInContext(readFileSync(new URL('../frontend/map-layout.js',import.meta.url),'utf8'),context);
 vm.runInContext(readFileSync(new URL('../frontend/amap.js',import.meta.url),'utf8'),context);
 return {context,calls,scripts,maps,lines,selections,fits,paddings,markers,instances,provider:context.window.WanderAMap};
}

test('native map uses official conversion in batches, caches WGS coordinates and never reconverts GCJ',async()=>{
 const h=setup(),points=Array.from({length:85},(_,i)=>[108.9+i*.0001,34.2]);
 const result=await h.provider.convert(points,'WGS84');assert.deepEqual(h.calls,[40,40,5]);assert(points.every(Array.isArray),'SDK mutation must not reach caller coordinates');assert.equal(result[0][0],points[0]![0]!+.006);
 await h.provider.convert(points,'WGS84');assert.equal(h.calls.length,3);
 const gcj=await h.provider.convert([[109,34]],'GCJ02');assert.deepEqual(Array.from(gcj[0]),[109,34]);assert.equal(h.calls.length,3);
});

test('native initialization keeps the simple theme and exposes no security code to the SDK',async()=>{
 const h=setup();assert.equal(await h.provider.init({places:[{lat:34.25,lng:108.94,name:'西安城墙',rating:5}],onSelect:(location:Record<string,unknown>)=>h.selections.push(location)}),true);
 await h.provider.placesReady;assert.equal((h.maps[1]!.toolbar as {position:string}).position,'RB');
 assert.equal(h.provider.ready,true);assert.equal(h.maps[0]!.mapStyle,'amap://styles/light');assert.equal(h.maps[0]!.showLabel,false);
 assert.deepEqual(JSON.parse(JSON.stringify(h.context.window._AMapSecurityConfig)),{serviceHost:'https://city.example/_AMapService'});
 assert.equal(h.selections[0]!.coordinateSystem,'GCJ02');assert.equal(h.scripts.length,0,'reuse an already loaded SDK');
 await h.provider.select(34.3,109,'搜索结果',14,{system:'GCJ02'});assert.equal(h.calls.length,1);
 assert.equal(h.provider.backendLocation(h.selections.at(-1)),null,'Native GCJ search is not mislabeled as legacy WGS');
 assert.deepEqual(JSON.parse(JSON.stringify(h.provider.backendLocation(h.selections[0]))),{lat:34.27,lng:108.95});
});

test('native route renderer converts WGS geometry once and uses GCJ geometry unchanged',async()=>{
 const h=setup();await h.provider.init({places:[],onSelect:()=>{}});
 h.context.window.WanderPlans={geometry:(leg:{geometry?:{coordinates:number[][]}})=>leg?.geometry?.coordinates.map(p=>[p[1],p[0]])||null};
 const model={coordinate_system:'WGS84',active_plan:'a',events:[{event_id:'one',title:'一站',latitude:34.2,longitude:108.9},{event_id:'two',title:'二站',latitude:34.21,longitude:108.91}],plans:[{plan_id:'a',label:'A',itinerary:{stops:[{event_id:'one'},{event_id:'two'}]},legs:[{from_event_id:'one',to_event_id:'two',geometry:{coordinates:[[108.9,34.2],[108.9,34.21],[108.91,34.21]]}}]}]};
 await h.provider.drawPlans(model);assert.equal((h.lines.at(-1)!.path as unknown[]).length,3);
 assert.deepEqual(Array.from((h.lines.at(-1)!.path as number[][])[0]!),[108.906,34.204]);
 const count=h.calls.length;model.coordinate_system='GCJ02';await h.provider.drawPlans(model);assert.equal(h.calls.length,count);assert.deepEqual(Array.from((h.lines.at(-1)!.path as number[][])[0]!),[108.9,34.2]);
});

test('current backend receives GCJ and fallback WGS locations are omitted',async()=>{
 const h=setup();h.context.fetch=async()=>({ok:true,json:async()=>({enabled:true,jsKey:'test-js-key',serviceHost:'/_AMapService',style:'amap://styles/light',backendCoordinateSystem:'GCJ02'})});
 await h.provider.init({places:[],onSelect:(loc:Record<string,unknown>)=>h.selections.push(loc)});
 assert.deepEqual(JSON.parse(JSON.stringify(h.provider.backendLocation(h.selections[0]))),{lat:34.268431458802404,lng:108.95467940704778});
 await h.provider.select(34.3,109,'高德搜索',14,{system:'GCJ02'});
 assert.deepEqual(JSON.parse(JSON.stringify(h.provider.backendLocation(h.selections.at(-1)))),{lat:34.3,lng:109});
 assert.equal(h.provider.backendLocation({lat:34.27,lng:108.95,name:'WGS fallback'}),null);
});

test('weather uses the documented null-error callback and rejects real errors or missing temperatures',async()=>{
 const h=setup();await h.provider.init({places:[],onSelect:()=>{}});
 const live=await h.provider.weather(34.27,108.95);assert.equal(live.temperature,'22');assert.equal(live.weather,'晴');
 h.context.window.AMap.Weather=class{getLive(_city:string,cb:Function){cb(null,{temperature:0,weather:'阴'})}};
 assert.equal((await h.provider.weather(34.27,108.95)).temperature,0);
 h.context.window.AMap.Weather=class{getLive(_city:string,cb:Function){cb('SERVICE_ERROR',{})}};
 await assert.rejects(h.provider.weather(34.27,108.95),/暂不可用/);
 h.context.window.AMap.Weather=class{getLive(_city:string,cb:Function){cb(null,{temperature:null})}};
 await assert.rejects(h.provider.weather(34.27,108.95),/温度暂不可用/);
});

test('native map fits only the active route while retaining both candidate overlays',async()=>{
 const h=setup();await h.provider.init({places:[],onSelect:()=>{}});h.context.window.WanderPlans={geometry:()=>null};
 const model={coordinate_system:'GCJ-02',active_plan:'A',events:[{event_id:'east',latitude:34.21,longitude:109},{event_id:'west',latitude:34.22,longitude:108.8}],plans:[{plan_id:'A',label:'A',itinerary:{stops:[{event_id:'east'}]}},{plan_id:'B',label:'B',itinerary:{stops:[{event_id:'west'}]}}]};
 await h.provider.drawPlans(model);assert.deepEqual(Array.from(h.paddings[0]!),[60,60,528,48]);assert.equal(h.fits[0]!.length,1);assert.deepEqual(Array.from(h.fits[0]![0].options.position),[109,34.21]);
 model.active_plan='B';await h.provider.drawPlans(model);assert.equal(h.fits[1]!.length,1);assert.deepEqual(Array.from(h.fits[1]![0].options.position),[108.8,34.22]);
});

test('native activity overlays are relaid out when panning, without removing attraction labels',async()=>{
 const h=setup();await h.provider.init({places:[],onSelect:()=>{}});
 h.context.window.WanderActivities={pin:()=>new Element(),layoutBubbles:(items:any[],view:{width:number;height:number})=>new Map(items.filter(i=>i.x>0&&i.x<view.width&&i.y>0&&i.y<view.height).map(i=>[i.id,{dx:-122,dy:-98,tailX:122,tailY:98,below:false}]))};
 await h.provider.setActivities([{id:'near',lat:34.27,lng:108.95,coordinateSystem:'GCJ-02',events:[{title:'附近展览'}]},{id:'east',lat:34.27,lng:111.45,coordinateSystem:'GCJ-02',events:[{title:'东侧展览'}]}],()=>{});
 const near=h.markers.find(m=>m.options.title==='附近展览'),east=h.markers.find(m=>m.options.title==='东侧展览');
 assert(near.attachedMap);assert.equal(east.attachedMap,null);assert.equal(near.options.anchor,'top-left');assert.equal(near.options.offset.x,-122);assert.equal(near.options.offset.y,-98);
 h.instances[0].shiftX=-50000;h.instances[0].listeners.get('moveend')();
 assert.equal(near.attachedMap,null);assert(east.attachedMap);
});

test('visible bubbles survive moveend plus an unchanged viewport response without remount or offset replay',async()=>{
 const h=setup();await h.provider.init({places:[],onSelect:()=>{}});let created=0,dx=-122;
 h.context.window.WanderActivities={pin:()=>{created++;return new Element()},layoutBubbles:(items:any[])=>new Map(items.map(i=>[i.id,{dx,dy:-98,tailX:-dx,tailY:98,below:false}]))};
 const groups=[{id:'unchanged-poi',lat:34.27,lng:108.95,coordinateSystem:'GCJ-02',events:[{event_id:'poi',title:'永兴坊'}]}];
 await h.provider.setActivities(groups,()=>{});const bubble=h.markers.find(m=>m.options.title==='永兴坊');
 h.instances[0].listeners.get('moveend')();
 await h.provider.setActivities(structuredClone(groups),()=>{});
 assert.equal(created,1,'viewport results retain existing bubble DOM');assert.equal(h.markers.filter(m=>m.options.title==='永兴坊').length,1);
 assert.equal(bubble.mapCalls.length,1,'visible marker is not reattached to the same map');assert.equal(bubble.offsetCalls.length,1,'unchanged offset is not reapplied');
 dx=-24;h.provider.updatePlaces();assert.equal(bubble.offsetCalls.length,2,'collision avoidance can still move a retained bubble');assert.equal(bubble.mapCalls.length,1);assert.equal(bubble.options.offset.x,-24);
});

test('retained bubbles show fresh response data and only disappeared points are removed',async()=>{
 const h=setup();await h.provider.init({places:[],onSelect:()=>{}});const updated:any[]=[];const opened:any[]=[];
 h.context.window.WanderActivities={pin:()=>new Element(),updatePin:(_node:unknown,group:any)=>updated.push(group),layoutBubbles:(items:any[])=>new Map(items.map(i=>[i.id,{dx:-122,dy:-98,tailX:122,tailY:98,below:false}]))};
 const make=(id:string,price:number)=>({id,lat:34.27,lng:108.95,coordinateSystem:'GCJ-02',events:[{event_id:id,title:id,budget_min:price}]});
 await h.provider.setActivities([make('kept',100),make('gone',200)],(group:any)=>opened.push(group));
 const kept=h.markers.find(m=>m.options.title==='kept'),gone=h.markers.find(m=>m.options.title==='gone');
 await h.provider.setActivities([make('kept',300)],(group:any)=>opened.push(group));
 assert.equal(h.markers.filter(m=>m.options.title==='kept').length,1);assert.equal(kept.mapCalls.length,1);assert.equal(gone.attachedMap,null);
 kept.options.content.listeners.get('click')();assert.equal(opened[0].events[0].budget_min,300);assert.equal(updated.at(-1).events[0].budget_min,300);
});

test('curated attraction markers also avoid redundant same-map attachment',async()=>{
 const h=setup();await h.provider.init({places:[{lat:34.25,lng:108.94,name:'城墙',rating:5}],onSelect:()=>{}});
 await h.provider.placesReady;const marker=h.markers.find(m=>m.options.title==='城墙');const initial=marker.mapCalls.length;
 h.instances[0].listeners.get('moveend')();h.provider.updatePlaces();assert.equal(marker.mapCalls.length,initial);
});

test('native route fitting reserves open detail panels but ignores hidden panels',async()=>{
 const h=setup();await h.provider.init({places:[],onSelect:()=>{}});h.context.window.WanderPlans={geometry:()=>null};
 const panel={hidden:false,getBoundingClientRect:()=>({left:966,right:1412,top:86,bottom:528})};
 h.context.document.getElementById=(id:string)=>id==='activity-detail'?panel:null;
 const model={coordinate_system:'GCJ-02',active_plan:'A',events:[{event_id:'one',latitude:34.25,longitude:108.96}],plans:[{plan_id:'A',label:'A',itinerary:{stops:[{event_id:'one'}]}}]};
 await h.provider.drawPlans(model);assert.deepEqual(Array.from(h.paddings[0]!),[60,60,528,498]);
 panel.hidden=true;await h.provider.drawPlans(model);assert.deepEqual(Array.from(h.paddings[1]!),[60,60,528,48]);
});

test('native ordered flow keeps a complete fit target, resizes without recoloring, and cancels on switching',async()=>{
 const h=setup();await h.provider.init({places:[],onSelect:()=>{}});const frames=new Map<number,Function>();let frameId=0;
 h.context.requestAnimationFrame=(fn:Function)=>{frames.set(++frameId,fn);return frameId};h.context.cancelAnimationFrame=(id:number)=>frames.delete(id);
 h.context.window.WanderPlans={geometry:(leg:any)=>leg?.geometry?.coordinates.map((p:number[])=>[p[1],p[0]])||null};
 const leg=(from:string,to:string,path:number[][])=>({from_event_id:from,to_event_id:to,status:'ok',geometry:{type:'LineString',coordinates:path}});
 const model={coordinate_system:'GCJ-02',active_plan:'A',events:[{event_id:'one',latitude:34.2,longitude:108.9},{event_id:'two',latitude:34.2,longitude:108.91},{event_id:'three',latitude:34.21,longitude:108.91}],plans:[{plan_id:'A',label:'A',itinerary:{stops:[{event_id:'one'},{event_id:'two'},{event_id:'three'}]},legs:[leg('one','two',[[108.9,34.2],[108.91,34.2]]),leg('two','three',[[108.91,34.2],[108.91,34.21]])]},{plan_id:'B',label:'B',itinerary:{stops:[{event_id:'two'},{event_id:'three'}]},legs:[leg('two','three',[[108.91,34.2],[108.91,34.21]])]}]};
 await h.provider.drawPlans(model);const flows=h.lines.filter(l=>(l.extData as any)?.role==='flow');assert.equal(flows.length,2);
 assert.deepEqual(JSON.parse(JSON.stringify(flows[1]!.path)),[[108.91,34.2],[108.91,34.2]],'later legs wait at their own first station');
 assert.equal(h.fits[0]!.length,5,'full tracks and all stops determine camera fit, not partial flow paths');
 const color=flows[0]!.strokeColor,width=flows[0]!.strokeWeight;
 h.instances[0].zoom=17;h.instances[0].listeners.get('zoomchange')();assert((flows[0]!.strokeWeight as number)>(width as number));assert.equal(flows[0]!.strokeColor,color);
 const oldFlow=h.markers.find(m=>m.options===flows[0]),stale=[...frames.values()][0]!;model.active_plan='B';await h.provider.drawPlans(model);
 const count=oldFlow.pathCalls.length;stale(1500);assert.equal(oldFlow.pathCalls.length,count,'an obsolete animation cannot touch removed route layers');
 h.provider.clearRoutes();assert.equal(frames.size,0);
});

test('attribution follows the original copyright border box and releases observers on disposal',async()=>{
 const h=setup(),canvas=new Element(),writes:string[]=[];let height=18.5,callback:()=>void=()=>{},disconnected=0;
 canvas.style.setProperty=(_name:string,value:string)=>{writes.push(value)};canvas.style.removeProperty=()=>{};
 const shell=new Element(),copy={isConnected:true,getBoundingClientRect:()=>({height})},host={parentElement:shell,closest:(selector:string)=>selector==='.canvas'?canvas:null,querySelector:()=>copy};
 h.context.document.getElementById=(id:string)=>id==='map'?host:null;
 h.context.ResizeObserver=class{constructor(fn:()=>void){callback=fn}observe(node:unknown,options:{box:string}){assert.equal(node,copy);assert.equal(options.box,'border-box')}disconnect(){disconnected++}};
 await h.provider.init({places:[],onSelect:()=>{}});assert(canvas.classList.contains('amap-attribution-layout'));assert(!shell.classList.contains('amap-attribution-layout'),'credit variables must live on the outer canvas even with a map shell');assert.equal(writes.at(-1),'19px');
 height=48.5;callback();assert.equal(writes.at(-1),'49px');
 h.provider.dispose();assert(!canvas.classList.contains('amap-attribution-layout'));assert(disconnected>0);const count=writes.length;callback();assert.equal(writes.length,count,'a late old-map observer cannot change the current layout');
});

const flushStartup=async()=>{for(let i=0;i<18;i++)await Promise.resolve();};
function startupTimers(h:ReturnType<typeof setup>){
 let id=0;const timers=new Map<number,{fn:()=>void;ms:number}>();
 h.context.setTimeout=(fn:()=>void,ms:number)=>{timers.set(++id,{fn,ms});return id};h.context.clearTimeout=(id:number)=>timers.delete(id);
 return {fire(ms:number){for(const [id,timer] of [...timers])if(timer.ms===ms){timers.delete(id);timer.fn();}},timers};
}

test('DOM renderer stays on AMap without forceWebGL or spoofing the screen',async()=>{
 const h=setup();h.context.window.AMap.Map.prototype.baseRender='d';
 assert.equal(await h.provider.init({onSelect:()=>{}}),true);assert.equal(h.provider.ready,true);
 assert.equal(h.provider.diagnostics.renderer,'dom');assert.equal(h.context.window.forceWebGL,undefined);
 assert.equal(h.provider.diagnostics.lastFailure,null);
});

test('nonessential plugin and conversion failures do not select another basemap',async()=>{
 const h=setup(),clock=startupTimers(h);delete h.context.window.AMap.ToolBar;delete h.context.window.AMap.Weather;
 h.context.window.AMap.plugin=()=>{};
 h.context.window.AMap.convertFrom=(_p:unknown,_type:unknown,cb:Function)=>cb('error',{info:'secret-upstream-url?key=do-not-log'});
 assert.equal(await h.provider.init({places:[{lat:34.2,lng:108.9,name:'故障景点'}],onSelect:()=>{}}),true);
 await h.provider.placesReady;clock.fire(15000);await flushStartup();
 assert.equal(h.provider.ready,true);assert.equal(h.instances.length,1);
 const events=h.provider.diagnostics.events;assert(events.some((e:any)=>e.stage==='coordinates'&&e.code==='service-failed'));
 assert(events.some((e:any)=>e.stage==='plugin'&&e.code==='timeout'));
 assert(!JSON.stringify(events).includes('do-not-log'));assert.equal(h.provider.diagnostics.lastFailure,null);
});

test('config transient failure is retried without caching; disabled and HTTP failures have distinct safe diagnostics',async()=>{
 const h=setup();let count=0;const original=h.context.fetch;
 h.context.fetch=async(url:string,options:any)=>{assert.equal(options.cache,'no-store');assert(options.signal);if(++count===1)throw new Error('https://private/?key=do-not-log');return original(url,options)};
 assert.equal(await h.provider.init({onSelect:()=>{}}),true);assert.equal(count,2);
 assert(h.provider.diagnostics.events.some((e:any)=>e.stage==='config'&&e.code==='network'&&e.level==='warning'));
 h.provider.dispose();h.context.fetch=async()=>({ok:true,json:async()=>({enabled:false,reason:'unexpected-secret'})});
 assert.equal(await h.provider.init(),false);assert.equal(h.provider.diagnostics.lastFailure.code,'disabled');
 h.context.fetch=async()=>({ok:false,status:503});assert.equal(await h.provider.init(),false);
 assert.equal(h.provider.diagnostics.lastFailure.code,'http-503');assert(!JSON.stringify(h.provider.diagnostics).includes('do-not-log'));
});

test('configuration timeout aborts both attempts and does not leave startup pending',async()=>{
 const h=setup(),clock=startupTimers(h);let aborted=0;
 h.context.fetch=(_url:string,{signal}:any)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(new Error('aborted'));}));
 const init=h.provider.init();clock.fire(12000);await flushStartup();clock.fire(12000);
 assert.equal(await init,false);assert.equal(aborted,2);assert.equal(h.provider.diagnostics.lastFailure.code,'timeout');
});

test('SDK network retry creates one map; missing API and renderer failure are diagnosed separately',async()=>{
 const h=setup(),sdk=h.context.window.AMap;delete h.context.window.AMap;let scripts=0;
 h.context.document.head.append=(script:any)=>{scripts++;queueMicrotask(()=>{if(scripts===1)script.onerror();else{h.context.window.AMap=sdk;script.onload();}})};
 assert.equal(await h.provider.init({onSelect:()=>{}}),true);assert.equal(scripts,2);assert.equal(h.instances.length,1);
 h.provider.dispose();h.context.window.AMap.Map=class{constructor(){throw new Error('key=do-not-log')}};
 assert.equal(await h.provider.init(),false);assert.equal(h.provider.diagnostics.lastFailure.stage,'renderer');
 assert(!JSON.stringify(h.provider.diagnostics).includes('do-not-log'));
 const missing=setup();delete missing.context.window.AMap;missing.context.document.head.append=(script:any)=>queueMicrotask(()=>script.onload());
 assert.equal(await missing.provider.init(),false);assert.equal(missing.provider.diagnostics.lastFailure.code,'invalid-api');
});

test('late SDK after timeout is reused only by explicit retry and never creates an obsolete map',async()=>{
 const h=setup(),clock=startupTimers(h),sdk=h.context.window.AMap;delete h.context.window.AMap;const scripts:any[]=[];
 h.context.document.head.append=(script:any)=>scripts.push(script);
 const first=h.provider.init({onSelect:()=>{}});await flushStartup();assert.equal(scripts.length,1);clock.fire(20000);
 assert.equal(await first,false);assert.equal(h.provider.diagnostics.lastFailure.code,'timeout');
 h.context.window.AMap=sdk;scripts[0].onload();await flushStartup();assert.equal(h.instances.length,0);
 assert.equal(await h.provider.init({onSelect:()=>{}}),true);assert.equal(scripts.length,1);assert.equal(h.instances.length,1);
});

test('dispose during loading cancels map creation and late attraction callbacks cannot attach to the next map',async()=>{
 const h=setup(),sdk=h.context.window.AMap;delete h.context.window.AMap;let script:any;
 h.context.document.head.append=(node:any)=>{script=node};const old=h.provider.init({onSelect:()=>{}});await flushStartup();h.provider.dispose();
 h.context.window.AMap=sdk;script.onload();assert.equal(await old,false);assert.equal(h.instances.length,0);
 let convert:Function=()=>{};sdk.convertFrom=(_p:unknown,_type:unknown,cb:Function)=>{convert=cb};
 assert.equal(await h.provider.init({places:[{lat:34.2,lng:108.9,name:'过期景点'}],onSelect:()=>{}}),true);
 h.provider.dispose();assert.equal(await h.provider.init({onSelect:()=>{}}),true);
 convert('complete',{locations:[{lat:34.204,lng:108.906}]});await flushStartup();assert.equal(h.markers.length,0,'late old marker batch cannot enter the new map');
});

test('an obsolete config response cannot overwrite the active coordinate system',async()=>{
 const h=setup();let finish:Function=()=>{},count=0;
 h.context.fetch=()=>{if(++count===1)return new Promise(resolve=>{finish=()=>resolve({ok:true,json:async()=>({enabled:false,backendCoordinateSystem:'WGS84'})});});return Promise.resolve({ok:true,json:async()=>({enabled:true,jsKey:'new-key',serviceHost:'/_AMapService',backendCoordinateSystem:'GCJ02'})});};
 const old=h.provider.init();await flushStartup();assert.equal(await h.provider.init({onSelect:()=>{}}),true);finish();assert.equal(await old,false);
 assert.deepEqual(JSON.parse(JSON.stringify(h.provider.backendLocation({lat:34.2,lng:108.9,coordinateSystem:'GCJ02'}))),{lat:34.2,lng:108.9});assert.equal(h.instances.length,1);
});

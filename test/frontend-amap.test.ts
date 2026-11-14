import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {Element} from './frontend-fixture.ts';
function setup(){
 const calls:number[]=[],scripts:string[]=[],maps:Record<string,unknown>[]=[],lines:Record<string,unknown>[]=[],selections:Record<string,unknown>[]=[],fits:any[][]=[],paddings:any[][]=[],markers:any[]=[],instances:any[]=[];
 class Marker {options:Record<string,unknown>;attachedMap:unknown;constructor(options:Record<string,unknown>){this.options=options;markers.push(this)}on(){}setOffset(offset:any){this.options.offset=offset}setMap(map:unknown){this.attachedMap=map}}
 class MapMock {shiftX=0;listeners=new Map<string,Function>();constructor(options:Record<string,unknown>){maps.push(options);instances.push(this)}addControl(){}add(){}remove(){}on(name:string,callback:Function){this.listeners.set(name,callback)}destroy(){}setZoomAndCenter(){}setFitView(layers:any[],_immediate:boolean,padding:any[]){fits.push(layers);paddings.push(padding)}getSize(){return {width:1440,height:900}}lngLatToContainer(p:number[]){return {x:800+(p[0]!-108.95)*20000+this.shiftX,y:400-(p[1]!-34.27)*20000}}}
 const sdk={convertFrom(batch:number[][],_type:string,callback:(s:string,r:object)=>void){calls.push(batch.length);const locations=batch.map(p=>({lng:p[0]!+.006,lat:p[1]!+.004}));locations.forEach((p,i)=>{(batch as unknown[])[i]=p;});callback('complete',{locations})},plugin(_p:unknown,done:()=>void){done()},Pixel:class{x:number;y:number;constructor(x:number,y:number){this.x=x;this.y=y}},Map:class extends MapMock{constructor(_id:string,options:Record<string,unknown>){super(options)}},ToolBar:class{constructor(o:{position:object}){assert.equal(typeof o.position,'object')}},Marker,Polyline:class extends Marker{constructor(o:Record<string,unknown>){super(o);lines.push(o)}},Geocoder:class{getAddress(_point:unknown,cb:(s:string,r:object)=>void){cb('complete',{regeocode:{addressComponent:{adcode:'610100',district:'雁塔区'}}})}},Weather:class{getLive(_city:string,cb:(s:string|null,r:object)=>void){cb(null,{temperature:'22',weather:'晴'})}}};
 const document={createElement:()=>new Element(),head:{append(script:Element&{onload:()=>void}){scripts.push(script.src);queueMicrotask(script.onload)}},querySelector:()=>({getBoundingClientRect:()=>({left:28,right:450,top:28,bottom:872,height:844})})};
 const context=vm.createContext({window:{dispatchEvent(){},AMap:sdk,location:{href:'https://city.example/'}},document,URL,console,Event,innerWidth:1440,setTimeout:()=>0,clearTimeout(){},fetch:async()=>({ok:true,json:async()=>({enabled:true,jsKey:'test-js-key',serviceHost:'/_AMapService',style:'amap://styles/light',backendCoordinateSystem:'WGS84'})}),showMapStatus(){},state:{},});
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
 assert.equal(h.provider.ready,true);assert.equal(h.maps[0]!.mapStyle,'amap://styles/light');assert.equal(h.maps[0]!.showLabel,false);
 assert.deepEqual(JSON.parse(JSON.stringify(h.context.window._AMapSecurityConfig)),{serviceHost:'https://city.example/_AMapService'});
 assert.equal(h.selections[0]!.coordinateSystem,'GCJ02');assert(h.scripts[0]!.startsWith('https://webapi.amap.com/maps?'));
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
 assert.deepEqual(JSON.parse(JSON.stringify(h.provider.backendLocation(h.selections[0]))),{lat:34.274,lng:108.956});
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

test('native route fitting reserves open detail panels but ignores hidden panels',async()=>{
 const h=setup();await h.provider.init({places:[],onSelect:()=>{}});h.context.window.WanderPlans={geometry:()=>null};
 const panel={hidden:false,getBoundingClientRect:()=>({left:966,right:1412,top:86,bottom:528})};
 h.context.document.getElementById=(id:string)=>id==='activity-detail'?panel:null;
 const model={coordinate_system:'GCJ-02',active_plan:'A',events:[{event_id:'one',latitude:34.25,longitude:108.96}],plans:[{plan_id:'A',label:'A',itinerary:{stops:[{event_id:'one'}]}}]};
 await h.provider.drawPlans(model);assert.deepEqual(Array.from(h.paddings[0]!),[60,60,528,498]);
 panel.hidden=true;await h.provider.drawPlans(model);assert.deepEqual(Array.from(h.paddings[1]!),[60,60,528,48]);
});

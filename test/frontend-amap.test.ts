import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {Element} from './frontend-fixture.ts';
function setup(){
 const calls:number[]=[],scripts:string[]=[],maps:Record<string,unknown>[]=[],lines:Record<string,unknown>[]=[],selections:Record<string,unknown>[]=[];
 class Marker {options:Record<string,unknown>;constructor(options:Record<string,unknown>){this.options=options}on(){}setMap(){}}
 class MapMock {constructor(options:Record<string,unknown>){maps.push(options)}addControl(){}add(){}remove(){}on(){}destroy(){}setZoomAndCenter(){}setFitView(){}getSize(){return {width:1440,height:900}}lngLatToContainer(){return {x:800,y:400}}}
 const sdk={convertFrom(batch:number[][],_type:string,callback:(s:string,r:object)=>void){calls.push(batch.length);callback('complete',{locations:batch.map(p=>({lng:p[0]!+.006,lat:p[1]!+.004}))})},plugin(_p:unknown,done:()=>void){done()},Pixel:class{constructor(_x:number,_y:number){}},Map:class extends MapMock{constructor(_id:string,options:Record<string,unknown>){super(options)}},ToolBar:class{},Marker,Polyline:class extends Marker{constructor(o:Record<string,unknown>){super(o);lines.push(o)}},Geocoder:class{getAddress(_point:unknown,cb:(s:string,r:object)=>void){cb('complete',{regeocode:{addressComponent:{adcode:'610100',district:'雁塔区'}}})}},Weather:class{getLive(_city:string,cb:(s:string,r:object)=>void){cb('complete',{temperature:'22',weather:'晴'})}}};
 const document={createElement:()=>new Element(),head:{append(script:Element&{onload:()=>void}){scripts.push(script.src);queueMicrotask(script.onload)}},querySelector:()=>({getBoundingClientRect:()=>({left:28,right:450,top:28,bottom:872,height:844})})};
 const context=vm.createContext({window:{AMap:sdk,location:{href:'https://city.example/'}},document,URL,console,innerWidth:1440,setTimeout:()=>0,clearTimeout(){},fetch:async()=>({ok:true,json:async()=>({enabled:true,jsKey:'test-js-key',serviceHost:'/_AMapService',style:'amap://styles/light',backendCoordinateSystem:'WGS84'})}),showMapStatus(){},state:{},});
 vm.runInContext(readFileSync(new URL('../frontend/amap.js',import.meta.url),'utf8'),context);
 return {context,calls,scripts,maps,lines,selections,provider:context.window.WanderAMap};
}

test('native map uses official conversion in batches, caches WGS coordinates and never reconverts GCJ',async()=>{
 const h=setup(),points=Array.from({length:85},(_,i)=>[108.9+i*.0001,34.2]);
 const result=await h.provider.convert(points,'WGS84');assert.deepEqual(h.calls,[40,40,5]);assert.equal(result[0][0],points[0]![0]!+.006);
 await h.provider.convert(points,'WGS84');assert.equal(h.calls.length,3);
 const gcj=await h.provider.convert([[109,34]],'GCJ02');assert.deepEqual(Array.from(gcj[0]),[109,34]);assert.equal(h.calls.length,3);
});

test('native initialization keeps the simple theme and exposes no security code to the SDK',async()=>{
 const h=setup();assert.equal(await h.provider.init({places:[],onSelect:(location:Record<string,unknown>)=>h.selections.push(location)}),true);
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

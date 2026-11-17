import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {setup,Element} from './frontend-fixture.ts';
const source=(name:string)=>readFileSync(new URL('../frontend/'+name,import.meta.url),'utf8');
const payload=JSON.parse(readFileSync(new URL('../docs/mocks/day0/response-comparison.json',import.meta.url),'utf8'));
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

// SDK mock contract only: these tests cannot prove actual AMap canvas rendering.
async function nativeHarness(){
 const h=setup({api:false}),layers=new Set<any>(),created:any[]=[],fits:any[]=[];
 let maps=0,resizes=0,native:any;
 for(const id of ['activity-detail','preferences-panel','plan-detail'])h.$(id).hidden=true;
 const mapNode=Object.assign(h.$('map'),{clientWidth:1440,clientHeight:900});
 const canvas={clientWidth:1440,clientHeight:900};
 Object.assign(h.$('itinerary-map-frame'),{clientWidth:400,clientHeight:400});
 const card=Object.assign(h.$('card'),{getBoundingClientRect:()=>({left:28,right:488,top:28,bottom:872,height:844})});
 h.context.document.getElementById=h.$;
 h.context.document.querySelector=(selector:string)=>selector==='.canvas'?canvas:card;
 h.context.document.head={append(node:any){queueMicrotask(()=>node.onload?.());}};
 h.context.locationMarker=null;h.context.tiles=null;h.context.requestAnimationFrame=()=>1;
 h.context.CustomEvent=class extends Event{detail:unknown;constructor(type:string,options:{detail:unknown}){super(type);this.detail=options.detail;}};
 h.context.window.location={href:'http://localhost/'};
 h.context.fetch=async()=>({ok:true,json:async()=>({enabled:true,jsKey:'contract-test-key',serviceHost:'/_AMapService',style:'mock'})});
 class Layer{
  options:any;map:any=null;
  constructor(options:any){this.options=options;created.push(this);}
  on(){}setMap(value:any){if(this.map)layers.delete(this);this.map=value;if(value)layers.add(this);}
  setOptions(options:any){Object.assign(this.options,options);}setPath(path:any){this.options.path=path;}
  setOffset(){}setPosition(position:any){this.options.position=position;}
 }
 class NativeMap{
  constructor(){maps++;native=this;}
  on(){}resize(){resizes++;}getZoom(){return 15;}
  getSize(){return {width:mapNode.clientWidth,height:mapNode.clientHeight};}
  lngLatToContainer(){return {x:700,y:400};}
  add(values:any){for(const v of Array.isArray(values)?values:[values])v.setMap(this);}
  remove(values:any){for(const v of Array.isArray(values)?values:[values])v.setMap(null);}
  setFitView(values:any,immediate:boolean,padding:number[],maxZoom:number){fits.push({values:[...values],immediate,padding:[...padding],maxZoom});}
  setFeatures(){}set(){}addControl(){}destroy(){}
 }
 h.context.window.AMap={Map:NativeMap,Marker:Layer,Polyline:Layer,ToolBar:class{},Pixel:class{},
  plugin(_names:unknown,done:()=>void){done();},convertFrom(points:number[][],_system:string,done:(status:string,result:unknown)=>void){done('complete',{locations:points.map(p=>({lng:p[0],lat:p[1]}))});}};
 h.context.window.WanderActivities={pin:()=>new Element(),updatePin(){},layoutBubbles:(items:any[])=>new Map(items.map(item=>[item.id,{dx:0,dy:0,tailX:0,tailY:0,below:false}]))};
 h.run(source('amap.js'));h.run(source('itinerary-map.js'));h.run(source('plans.js'));
 const sdk=h.context.window.WanderAMap;h.context.updatePlaceMarkers=()=>sdk.updatePlaces();
 assert.equal(await sdk.init({places:[{name:'outside scenic',lat:34.3,lng:109,kind:'museum',rating:4}],onSelect(){}}),true);
 const model=h.context.window.WanderPlans.normalize(structuredClone(payload));
 function publish(active:boolean,phase:string,model:any){const value={active,phase,model};h.context.window.WanderItineraryFocus=value;h.context.window.dispatchEvent(new h.context.CustomEvent('wander:itinerary-focus',{detail:value}));}
 const routeLayers=()=>[...layers].filter(l=>l.options.extData||l.options.content?.className==='native-route-dot');
 return {...h,sdk,model,mapNode,native,created,layers,fits,publish,routeLayers,maps:()=>maps,resizes:()=>resizes};
}

test('AMap adapter keeps one native instance, uses immediate resize fits, filters business layers and restores exploration',async()=>{
 const h=await nativeHarness();
 await h.sdk.setActivities([{id:'outside-feed',lat:34.25,lng:109,coordinateSystem:'GCJ-02',name:'outside',events:[{title:'outside activity'}]}],()=>{});
 const business=[...h.layers];assert.equal(business.length,2);
 await h.context.window.WanderPlans.draw(h.model);
 assert.equal(h.routeLayers().filter(l=>l.options.extData?.role==='track').length,2);
 h.publish(true,'entering',h.model);await flush();
 h.mapNode.clientWidth=900;h.mapNode.clientHeight=700;h.context.window.WanderItineraryMap.sync();
 assert(h.resizes()>0);assert.equal(h.fits.at(-1).immediate,true,'per-frame camera fit must not start another native animation');
 h.mapNode.clientWidth=400;h.mapNode.clientHeight=400;h.context.window.WanderItineraryMap.sync();
 assert.deepEqual(h.fits.at(-1).padding,[84,60,100,100],'AMap padding is top,bottom,left,right and reserves the feather and route name bubbles');
 assert.equal(h.fits.at(-1).maxZoom,15);assert.equal(h.fits.at(-1).values.length,3,'fit includes the complete track and both stations');
 assert(business.every(layer=>!h.layers.has(layer)));
 assert.equal(h.routeLayers().filter(l=>l.options.extData?.role==='track').length,1);
 const b={...h.model,active_plan:'plan_mock_b'};h.publish(true,'detail',b);await flush();h.context.window.WanderItineraryMap.sync();
 assert(h.routeLayers().filter(l=>l.options.extData).every(l=>l.options.extData.planId==='plan_mock_b'));
 h.publish(false,'leaving',b);await flush();h.mapNode.clientWidth=1440;h.mapNode.clientHeight=900;h.publish(false,'explore',null);h.context.window.WanderItineraryMap.sync();
 assert.equal(h.routeLayers().filter(l=>l.options.extData?.role==='track').length,2);assert(business.every(layer=>h.layers.has(layer)));
 assert.equal(h.maps(),1,'focus and plan switching must not construct another SDK map');
});

test('AMap epoch cancellation rejects late palette results after routes are cleared',async()=>{
 const h=await nativeHarness();let finish!:(value:any)=>void;
 h.context.window.WanderRouteVisuals.palette=()=>new Promise(resolve=>{finish=resolve;});
 const pending=h.sdk.drawPlans(h.model);h.sdk.clearRoutes();
 finish(new Map(h.model.plans.map((p:any)=>[p.plan_id,{color:'#167744'}])));await pending;
 assert.equal(h.routeLayers().length,0);assert.equal(h.fits.length,0);assert.equal(h.maps(),1);
});


test('focused route name bubbles follow event IDs, clear on switching/reset, and do no per-frame SDK work',async()=>{
 const h=await nativeHarness();
 await h.context.window.WanderPlans.draw(h.model);
 h.mapNode.clientWidth=400;h.mapNode.clientHeight=400;
 h.publish(true,'entering',h.model);await flush();
 h.context.window.WanderItineraryMap.sync();
 const labels=()=>h.routeLayers().filter(l=>l.options.content?.className==='native-route-dot').flatMap(l=>l.options.content.children.map((n:any)=>n.textContent));
 const expected=(model:any)=>model.plans.find((p:any)=>p.plan_id===model.active_plan).itinerary.stops.map((s:any)=>model.events.find((e:any)=>e.event_id===s.event_id).title);
 assert.deepEqual(labels(),expected(h.model));
 const counts=[h.resizes(),h.fits.length,h.created.length];
 for(let frame=0;frame<120;frame++)h.context.window.WanderItineraryMap.sync({throttled:true});
 assert.deepEqual([h.resizes(),h.fits.length,h.created.length],counts,'stable layout during the compositor animation must not resize, refit or rebuild markers');
 const b={...h.model,active_plan:'plan_mock_b'};
 h.publish(true,'detail',b);await flush();h.context.window.WanderItineraryMap.sync();
 assert.deepEqual(labels(),expected(b));
 h.publish(false,'leaving',b);await flush();assert.deepEqual(labels(),[]);
 h.context.window.dispatchEvent(new Event('wander:reset'));await flush();assert.equal(h.routeLayers().length,0);
});

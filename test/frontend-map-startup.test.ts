import assert from 'node:assert/strict';import test from 'node:test';import vm from 'node:vm';import {readFileSync} from 'node:fs';import {Element} from './frontend-fixture.ts';
const flush=async()=>{for(let i=0;i<35;i++)await Promise.resolve();};
function setup({vector=false,brokenVector=false}={}){
 const nodes=new Map<string,any>(),get=(id:string)=>{if(!nodes.has(id))nodes.set(id,Object.assign(new Element(),{dataset:{},getBoundingClientRect:()=>({left:28,right:450,top:28,bottom:872,height:844})}));return nodes.get(id);};
 const maps:any[]=[],providers:any[]=[],draws:any[]=[],converted:any[]=[],callbacks:any[]=[];let nativeReady=false,allowNative=false,styleResolve:Function=()=>{},vectorLayers=0,brokenHandlers=0;
 const win:any=Object.assign(new EventTarget(),{WanderAMap:{get ready(){return nativeReady},diagnostics:{attempt:1,lastFailure:{stage:'config',code:'disabled'},events:[]},
  async init(options:any){providers.push(options);await Promise.resolve();if(!allowNative)return false;options.beforeCreate();nativeReady=true;options.onSelect({lat:34.2684,lng:108.9547,name:'西安市',coordinateSystem:'GCJ02',wgs84:{lat:34.27,lng:108.95}});return true;},loadFallback:async()=>{},weather:async()=>({temperature:10,weather:'阴'}),updatePlaces(){},
  async select(lat:number,lng:number,name:string,zoom:number){converted.push({lat,lng,name,zoom});providers.at(-1).onSelect({lat:lat-.002,lng:lng+.005,name,coordinateSystem:'GCJ02',wgs84:{lat,lng}});},async restoreView(center:any,zoom:number){converted.push({center,zoom});}},WanderPlans:{draw:(model:any)=>draws.push(model),cancelDraw(){}},L:null as any,maplibregl:vector?{setWorkerCount(){}}:null});
 const L={map(){const m={removed:false,layers:[] as any[],center:{lat:34.27,lng:108.95},zoom:11,setView(center:any,zoom:number){this.center=Array.isArray(center)?{lat:center[0],lng:center[1]}:center;this.zoom=zoom;return this;},getCenter(){return this.center},getZoom(){return this.zoom},on(){},stop(){},remove(){this.removed=true;},removeLayer(layer:any){layer.onRemove?.(this);brokenHandlers=0;},getSize(){return {x:1440,y:900}},hasLayer(){return false}};maps.push(m);return m;},control:{zoom(){return {addTo(){}}}},tileLayer(){return {addTo(m:any){m.layers.push(this);return this},on(name:string,callback:Function){callbacks.push({name,callback});return this}}},...(vector?{maplibreGL(){vectorLayers++;return {addTo(){if(brokenVector){brokenHandlers++;throw new Error('WebGL constructor failed');}return this;},onRemove(){if(brokenVector)throw new Error('missing renderer.remove');},getContainer(){return {remove(){}}},getMaplibreMap(){return brokenVector?undefined:{once(){},on(){},loaded(){return false}}}}}}:{})};win.L=L;
 const context=vm.createContext({window:win,document:{getElementById:get,querySelector:()=>get('card'),createElement:()=>new Element()},L,places:[],Date,Event,AbortController,URL,URLSearchParams,console,navigator:{geolocation:null},setTimeout:()=>0,clearTimeout(){},setInterval(){},
 fetch:async(url:string)=>{if(url.includes('quiet-map'))return new Promise(resolve=>{styleResolve=()=>resolve({ok:true,json:async()=>({version:8})});});return {ok:true,json:async()=>({current:{temperature_2m:10,weather_code:0}})};}});
 vm.runInContext(readFileSync(new URL('../frontend/app.js',import.meta.url),'utf8'),context);
 return {context,win,maps,draws,converted,callbacks,get,allow(){allowNative=true;},style(){styleResolve();},get vectorLayers(){return vectorLayers},get brokenHandlers(){return brokenHandlers}};
}

test('fallback status survives tile load, retries are single-flight and preserve WGS location and zoom',async()=>{
 const h=setup();await flush();assert.equal(h.win.WanderMaps.provider,'osm');assert(!h.get('map-retry').hidden);
 h.callbacks.find(c=>c.name==='load').callback();assert.equal(h.win.WanderMaps.provider,'osm');assert(h.get('map-provider-message').textContent.includes('OpenStreetMap'));
 vm.runInContext("state.location={lat:34.2,lng:108.9,name:'原地点'};state.latestPlan={coordinate_system:'GCJ-02'}",h.context);
 h.maps[0].setView([34.23,108.98],13);h.allow();const first=h.win.WanderMaps.retry(),second=h.win.WanderMaps.retry();assert.equal(first,second);
 assert.equal(h.maps[0].removed,false,'keep usable fallback during config/SDK loading');assert.equal(await first,true);
 assert.equal(h.maps.length,1);assert(h.maps[0].removed);assert.equal(h.win.WanderMaps.provider,'amap');assert(h.get('map-retry').hidden);
 assert.deepEqual(h.converted[0],{lat:34.2,lng:108.9,name:'原地点',zoom:13});assert.equal(h.draws.length,1);
 assert.equal(vm.runInContext('state.location.coordinateSystem',h.context),'GCJ02');assert.equal(vm.runInContext('map',h.context),null);
 // An old raster callback cannot overwrite the native state or trigger location.
 h.callbacks.find(c=>c.name==='load').callback();assert.equal(h.win.WanderMaps.provider,'amap');
});

test('late vector style after retry cannot mount on the replacement native map',async()=>{
 const h=setup({vector:true});await flush();assert.equal(h.vectorLayers,0);h.allow();assert.equal(await h.win.WanderMaps.retry(),true);
 h.style();await flush();assert.equal(h.vectorLayers,0);assert.equal(h.win.WanderMaps.provider,'amap');assert.equal(h.maps.length,1);
});

test('failed retry keeps the existing fallback and does not duplicate maps or controls',async()=>{
 const h=setup();await flush();assert.equal(await h.win.WanderMaps.retry(),false);assert.equal(h.maps.length,1);assert(!h.maps[0].removed);assert.equal(h.win.WanderMaps.provider,'osm');assert(!h.get('map-retry').disabled);
});


test('half-mounted vector renderer releases its bridge listeners before OSM is used',async()=>{
 const h=setup({vector:true,brokenVector:true});await flush();h.style();await flush();assert.equal(h.win.WanderMaps.provider,'osm');assert.equal(h.brokenHandlers,0,'a failed renderer must not retain zoom listeners');assert.equal(h.win.WanderMaps.diagnostics.fallback.reason,'initialization-failed');h.allow();assert.equal(await h.win.WanderMaps.retry(),true);assert.equal(h.maps.length,1);
});

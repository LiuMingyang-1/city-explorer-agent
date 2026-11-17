'use strict';
const $ = id => document.getElementById(id);
const DEFAULT = {lat:34.27, lng:108.95, name:'西安市'};
const state = {location:{...DEFAULT}, revision:0, manual:false, weather:null, messages:[], busy:false, planMessageIndex:null};
const icons = {
 sun:'<circle cx="28" cy="28" r="10"/><path d="M28 8v5m0 30v5M8 28h5m30 0h5M14 14l4 4m20 20 4 4m0-28-4 4M18 38l-4 4"/>',
 moon:'<path d="M39 35A18 18 0 0 1 21 11a18 18 0 1 0 18 24Z"/><path d="M40 10v8m-4-4h8"/>',
 cloud:'<path d="M16 39h27a10 10 0 1 0-3-19 14 14 0 0 0-27-1 10 10 0 0 0 3 20Z"/>',
 partly:'<circle cx="21" cy="20" r="9"/><path d="M21 4v4M5 20h4M10 9l3 3m19-3-3 3M19 43h24a10 10 0 0 0 0-20 12 12 0 0 0-22 4 8 8 0 0 0-2 16Z"/>',
 rain:'<path d="M13 32h31a9 9 0 0 0-3-17 13 13 0 0 0-25 0 9 9 0 0 0-3 17ZM17 39l-3 7m15-7-3 7m15-7-3 7"/>',
 snow:'<path d="M13 30h31a9 9 0 0 0-3-17 13 13 0 0 0-25 0 9 9 0 0 0-3 17ZM18 37v10m-4-8 8 6m0-6-8 6m25-8v10m-4-8 8 6m0-6-8 6"/>',
 storm:'<path d="M13 31h31a9 9 0 0 0-3-17 13 13 0 0 0-25 0 9 9 0 0 0-3 17ZM29 30l-7 11h9l-6 10"/>',
 fog:'<path d="M13 29h31a9 9 0 0 0-3-17 13 13 0 0 0-25 0 9 9 0 0 0-3 17ZM8 37h39M13 44h28"/>'
};
function weatherInfo(code,day=1){
 if(code===0) return [day?'晴':'晴朗',''+(day?'sun':'moon')];
 if(code===1||code===2) return ['多云','partly'];
 if(code===3) return ['阴','cloud'];
 if([45,48].includes(code)) return ['雾','fog'];
 if([51,53,55,56,57].includes(code)) return ['小雨','rain'];
 if([61,63,65,66,67,80,81,82].includes(code)) return ['雨','rain'];
 if([71,73,75,77,85,86].includes(code)) return ['雪','snow'];
 if([95,96,99].includes(code)) return ['雷雨','storm'];
 return ['天气未知','cloud'];
}
function renderWeatherIcon(type){$('weather-icon').innerHTML='<svg viewBox="0 0 56 56">'+icons[type]+'</svg>';}
renderWeatherIcon('partly');
function updateClock(){const now=new Date(),h=now.getHours();$('greeting').textContent=h>=5&&h<11?'早上好':h>=11&&h<13?'中午好':h>=13&&h<18?'下午好':'晚上好';}
updateClock();setInterval(updateClock,60000);
let map,tiles,locationMarker,routeLayer;
let highlightedPlaces=[];
const pinDraw={tower:'<path d="M3 11h10M4 11V7h8v4M3 7h10L8 3 3 7ZM8 1v2M5 13h6"/>',wall:'<path d="M2 13V5h3V3h2v2h3V3h2v2h2v8M2 9h12M7 13v-2h2v2"/>',museum:'<path d="m2 5 6-3 6 3H2Zm1 2v5m4-5v5m3-5v5m3-5v5M1 14h14"/>'};
function showMapStatus(text){$('map-status').textContent=text;$('map-status').hidden=!text;}
let mapEpoch=0,initializingMap,stopFallbackBasemap=()=>{},mapProvider='loading',fallbackProvider='fallback',fallbackReason=null;
const mapFailures={config:'配置获取失败',sdk:'组件加载失败',plugin:'附加功能加载失败',coordinates:'坐标服务暂不可用',attractions:'部分景点暂未加载',renderer:'渲染初始化失败',initialization:'初始化失败'};
function providerStatus(provider=mapProvider){
 mapProvider=provider;const box=$('map-provider-status'),text=$('map-provider-message'),retry=$('map-retry');
 const diagnostic=window.WanderAMap?.diagnostics,issue=diagnostic?.lastFailure;
 box.dataset.provider=provider;
 retry.hidden=provider==='amap';retry.disabled=provider==='loading';
 if(provider==='loading'){box.hidden=false;text.textContent='正在加载高德地图…';return;}
 if(provider==='amap'){
  const warning=diagnostic?.events.filter(e=>e.attempt===diagnostic.attempt&&e.level==='warning'&&['plugin','coordinates','attractions'].includes(e.stage)).at(-1);
  const suffix=warning?mapFailures[warning.stage]:diagnostic?.renderer==='dom'?'兼容渲染模式':'';
  box.hidden=!suffix;text.textContent='高德地图'+(suffix?' · '+suffix:'');return;
 }
 box.hidden=false;
 const reason=issue?.code==='disabled'||issue?.code?.startsWith('missing-')?'未配置或未启用':mapFailures[issue?.stage]||'暂不可用';
 text.textContent=(provider==='osm'?'OpenStreetMap':provider==='openfreemap'?'OpenFreeMap':'备用地图')+' · 高德'+reason;
}
function clearFallbackMap(){
 mapEpoch++;stopFallbackBasemap();stopFallbackBasemap=()=>{};
 window.dispatchEvent(new Event('wander:map-changing'));window.WanderPlans?.cancelDraw?.();
 if(map){map.stop?.();map.remove();}map=null;tiles=null;locationMarker=null;routeLayer=null;
 places.forEach(place=>{delete place.marker;delete place.renderKey;});++state.revision;++searchId;
}
function announceMap(){
 window.dispatchEvent(new Event('wander:map-ready'));
 if(state.latestPlan){window.WanderPlans?.draw(state.latestPlan);if(!window.WanderAMap?.ready&&!['WGS84','WGS-84'].includes(String(state.latestPlan.coordinate_system||'WGS84').toUpperCase()))showMapStatus('备用地图暂不显示高德坐标路线，可重试高德后查看');}
}
async function initFallbackMap(){
 const epoch=mapEpoch;
 try{await window.WanderAMap?.loadFallback();}catch{}
 if(epoch!==mapEpoch)return;
 if(window.L){
  map=L.map('map',{zoomControl:false,minZoom:3,maxZoom:19,attributionControl:true}).setView([DEFAULT.lat,DEFAULT.lng],11);
  providerStatus('fallback');initBasemap();
  L.control.zoom({position:'bottomright'}).addTo(map);
  places.forEach(place=>{place.marker=L.marker([place.lat,place.lng],{icon:placeIcon(place),title:(place.officialName||place.name)+(place.rating?' · '+place.rating+'A':''),riseOnHover:true});place.marker.on('click',()=>{state.manual=true;selectLocation(place.lat,place.lng,place.name,14);window.WanderActivities?.openNearby(place);});});
  map.on('moveend zoomend resize',()=>{updatePlaceMarkers();window.dispatchEvent(new Event('wander:viewport'));});
  updatePlaceMarkers();announceMap();
  setTimeout(()=>{if(epoch===mapEpoch)autoLocate();},3000);
 }else{providerStatus('unavailable');showMapStatus('地图组件加载失败，可重试高德');}
}
function initializeMap(){
 if(initializingMap)return initializingMap;
 if(window.WanderAMap?.ready)return Promise.resolve(true);
 // Keep the working fallback while configuration/SDK retry is in flight.
 let saved=null;
 const capture=()=>map?{location:{...state.location},center:map.getCenter(),zoom:map.getZoom(),revision:state.revision}:null;
 providerStatus('loading');
 initializingMap=(async()=>{
  let removed=false;
  const enabled=await window.WanderAMap?.init({places,beforeCreate:()=>{saved=capture();clearFallbackMap();removed=true;},onSelect:location=>{
   const revision=++state.revision;state.location=location;setLocationText(location.name);$('location-status').textContent='';updateWeather(location.lat,location.lng,revision);
  }});
  if(enabled){
   providerStatus('amap');
   if(saved){
    const original=saved.location.coordinateSystem==='GCJ02'?saved.location.wgs84:saved.location;
    if(original){try{await window.WanderAMap.select(original.lat,original.lng,saved.location.name,saved.zoom);}catch{showMapStatus('已恢复高德，原地点暂未定位，可重新搜索');}}
    if(!state.latestPlan&&state.location.name===saved.location.name){try{await window.WanderAMap.restoreView(saved.center,saved.zoom);}catch{}}
   }
   announceMap();const epoch=mapEpoch;setTimeout(()=>{if(epoch===mapEpoch)autoLocate();},0);return true;
  }
  if(!map){
   // beforeCreate already released Leaflet if native construction failed.
   if(!removed)clearFallbackMap();
   const original=saved?.location.coordinateSystem==='GCJ02'?saved.location.wgs84:saved?.location;
   state.location=original?{...original,name:saved.location.name}:{...DEFAULT};
   await initFallbackMap();
   if(saved&&map){if(original)selectLocation(original.lat,original.lng,saved.location.name,saved.zoom);map.setView(saved.center,saved.zoom,{animate:false});}
  }else providerStatus(fallbackProvider);
  return false;
 })().catch(()=>{providerStatus(map?'fallback':'unavailable');showMapStatus('地图初始化未完成，可重试高德');return false;}).finally(()=>{initializingMap=null;const button=$('map-retry');button.disabled=false;});
 return initializingMap;
}
$('map-retry').addEventListener('click',()=>initializeMap());
window.addEventListener('wander:map-diagnostic',event=>{if(event.detail.level==='warning'&&window.WanderAMap?.ready)providerStatus('amap');});
window.WanderMaps={retry:initializeMap,get provider(){return mapProvider;},get diagnostics(){return {...window.WanderAMap?.diagnostics,fallback:{provider:fallbackProvider,reason:fallbackReason}};}};
initializeMap();

function placeIcon(place,direction='right',label=true){
 const rated=place.rating?'<span class="place-rating">'+place.rating+'A</span>':'';
 return L.divIcon({className:'place-icon',html:'<div class="place-wrap direction-'+direction+(label?'':' label-hidden')+'"><span class="place-dot"><svg viewBox="0 0 16 16">'+pinDraw[place.kind]+'</svg></span><span class="place-name">'+place.name+rated+'</span></div>',iconSize:[22,22],iconAnchor:[11,11]});
}
function updatePlaceMarkers(names){
 if(window.WanderAMap?.ready){window.WanderAMap.updatePlaces(names);return;}
 if(!map)return;if(names!==undefined)highlightedPlaces=names;
 const size=map.getSize(),card=document.querySelector('.glass-card').getBoundingClientRect();
 const occupied=window.WanderItineraryFocus?.active?[]:[{left:card.left,top:card.top,right:card.right,bottom:card.bottom}];
 const intersects=(a,b)=>a.left<b.right+6&&a.right>b.left-6&&a.top<b.bottom+6&&a.bottom>b.top-6;
 if(locationMarker){const p=map.latLngToContainerPoint(locationMarker.getLatLng());occupied.push({left:p.x-130,right:p.x+130,top:p.y-65,bottom:p.y+12});}
 const ordered=[...places].sort((a,b)=>Number(highlightedPlaces.includes(b.name))-Number(highlightedPlaces.includes(a.name))||(b.rating||0)-(a.rating||0));
 ordered.forEach(place=>{
  const p=map.latLngToContainerPoint([place.lat,place.lng]);
  const show=!window.WanderItineraryFocus?.active&&(place.rating>=4||highlightedPlaces.includes(place.name))&&!(locationMarker&&place.name===state.location.name)&&p.x>=-30&&p.y>=-30&&p.x<=size.x+30&&p.y<=size.y+30;
  if(!show){if(map.hasLayer(place.marker))map.removeLayer(place.marker);return;}
  const width=Array.from(place.name).reduce((sum,c)=>sum+(/[^\x00-\x7F]/.test(c)?11:6),20)+(place.rating?29:0),height=29;
  const candidates=[['right',{left:p.x+17,right:p.x+17+width,top:p.y-height/2,bottom:p.y+height/2}],['left',{left:p.x-17-width,right:p.x-17,top:p.y-height/2,bottom:p.y+height/2}],['top',{left:p.x-width/2,right:p.x+width/2,top:p.y-18-height,bottom:p.y-18}],['bottom',{left:p.x-width/2,right:p.x+width/2,top:p.y+18,bottom:p.y+18+height}]];
  const fit=candidates.find(([,r])=>r.left>8&&r.right<size.x-8&&r.top>8&&r.bottom<size.y-25&&!occupied.some(other=>intersects(r,other)));
  const direction=fit?.[0]||'right',label=Boolean(fit),key=direction+'-'+label;
  if(fit)occupied.push(fit[1]);
  if(place.renderKey!==key){place.marker.setIcon(placeIcon(place,direction,label));place.renderKey=key;}
  if(!map.hasLayer(place.marker))place.marker.addTo(map);
 });
}
function locationLabel(name){const label=document.createElement('span');label.textContent=name;return label;}
async function initBasemap(){
 const target=map,epoch=mapEpoch;let fallback=false,loadTimer,disposed=false,renderer;
 const current=()=>!disposed&&epoch===mapEpoch&&map===target;
 stopFallbackBasemap=()=>{disposed=true;clearTimeout(loadTimer);};
 function useRaster(reason='vector-unavailable'){
  if(!current()||fallback)return;fallbackReason=reason;fallback=true;clearTimeout(loadTimer);
  if(tiles){try{target.removeLayer(tiles);}catch{}tiles=null;}
  tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
   maxZoom:19,updateWhenIdle:true,updateWhenZooming:false,keepBuffer:1,
   attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
  }).addTo(target);fallbackProvider='osm';providerStatus('osm');
  let failures=0;tiles.on('tileerror',()=>{if(current()&&++failures>=4)showMapStatus('备用地图暂时无法连接，可重试高德');});
  tiles.on('loading',()=>{if(current())failures=0;});
  tiles.on('load',()=>{if(current()){if(failures===0)showMapStatus('');autoLocate();}});
 }
 try{
  if(!window.maplibregl||!L.maplibreGL){useRaster('assets-unavailable');return;}
  if(typeof window.maplibregl.supported==='function'&&!window.maplibregl.supported()){useRaster('webgl-unavailable');return;}
  const style=await fetchJSON('assets/quiet-map.json');if(!current())return;
  window.maplibregl.setWorkerCount(2);
  tiles=L.maplibreGL({style,interactive:false,padding:.05,updateInterval:32,
   pixelRatio:Math.min(window.devicePixelRatio||1,1.5),fadeDuration:0,
   localIdeographFontFamily:'sans-serif',maxTileCacheSize:80,
   attributionControl:{customAttribution:'<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · <a href="https://openmaptiles.org" target="_blank" rel="noopener">OpenMapTiles</a> · &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'}
  });
  // A failed WebGL constructor leaves the bridge half-mounted. Its original
  // onRemove dereferences a missing renderer, preventing Leaflet event cleanup.
  const remove=tiles.onRemove;tiles.onRemove=function(host){if(this.getMaplibreMap())return remove?.call(this,host);this.getContainer?.()?.remove();};
  tiles.addTo(target);renderer=tiles.getMaplibreMap();let failures=0;
  renderer.once('load',()=>{if(!current())return;clearTimeout(loadTimer);if(!fallback){fallbackProvider='openfreemap';providerStatus('openfreemap');showMapStatus('');autoLocate();}});
  renderer.on('error',()=>{if(current()&&++failures>=3)useRaster('tile-errors');});
  loadTimer=setTimeout(()=>{if(current()&&!renderer.loaded())useRaster('load-timeout');},15000);
 }catch{useRaster('initialization-failed');}
}

async function fetchJSON(url){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);try{const response=await fetch(url,{signal:controller.signal,headers:{Accept:'application/json'}});if(!response.ok)throw new Error('HTTP '+response.status);return await response.json();}finally{clearTimeout(timer);}}
let geoQueue=Promise.resolve(),lastGeoTime=0;const geoCache=new Map();
function nominatim(path){if(geoCache.has(path))return Promise.resolve(geoCache.get(path));const request=geoQueue.catch(()=>{}).then(async()=>{const wait=Math.max(0,1100-(Date.now()-lastGeoTime));if(wait)await new Promise(resolve=>setTimeout(resolve,wait));lastGeoTime=Date.now();const data=await fetchJSON('https://nominatim.openstreetmap.org/'+path);geoCache.set(path,data);return data;});geoQueue=request;return request;}
async function updateWeather(lat,lng,revision){if(window.WanderAMap?.ready){
 $('temperature').textContent='—';$('weather-description').textContent='获取天气中';
 try{const live=await window.WanderAMap.weather(lat,lng);if(revision!==state.revision)return;const temperature=Number(live.temperature);if(!Number.isFinite(temperature))throw new Error('No temperature');const description=String(live.weather||'天气');$('temperature').textContent=Math.round(temperature);$('weather-description').textContent=description;renderWeatherIcon(/雪/.test(description)?'snow':/雷/.test(description)?'storm':/雨/.test(description)?'rain':/雾|霾/.test(description)?'fog':/阴/.test(description)?'cloud':/云/.test(description)?'partly':'sun');}
 catch{if(revision===state.revision){$('temperature').textContent='—';$('weather-description').textContent='天气暂不可用';}}return;
 }$('temperature').textContent='—';$('weather-description').textContent='获取天气中';state.weather=null;try{const data=await fetchJSON('https://api.open-meteo.com/v1/forecast?latitude='+lat+'&longitude='+lng+'&current=temperature_2m,weather_code,is_day&timezone=auto');if(revision!==state.revision)return;if(!data.current||!Number.isFinite(data.current.temperature_2m))throw new Error('No temperature');state.weather=data.current;const [description,type]=weatherInfo(data.current.weather_code,data.current.is_day);$('temperature').textContent=Math.round(data.current.temperature_2m);$('weather-description').textContent=description;renderWeatherIcon(type);}catch{if(revision===state.revision){$('temperature').textContent='—';$('weather-description').textContent='天气暂不可用';renderWeatherIcon('cloud');}}}
function setLocationText(name){state.location.name=name;$('location-input').value='';$('location-input').placeholder=name;if(locationMarker)locationMarker.setTooltipContent(locationLabel(name));}
function selectLocation(lat,lng,name,zoom=13,reverse=false,system='WGS84',wgs84=null){if(window.WanderAMap?.ready){return window.WanderAMap.select(lat,lng,name,zoom,{system,reverse,wgs84}).catch(()=>{$('location-status').textContent='地点暂不可用';});}if(['GCJ02','GCJ-02'].includes(system))return;const revision=++state.revision;state.location={lat,lng,name};setLocationText(name);$('location-status').textContent='';if(map){highlightedPlaces=[];if(routeLayer){map.removeLayer(routeLayer);routeLayer=null;}map.flyTo([lat,lng],zoom,{duration:.9});if(locationMarker)map.removeLayer(locationMarker);locationMarker=L.marker([lat,lng],{title:name,zIndexOffset:1000,icon:L.divIcon({html:'<span class="location-dot"></span>',className:'current-location',iconSize:[18,18],iconAnchor:[9,9]})}).bindTooltip(locationLabel(name),{permanent:true,direction:'top',offset:[0,-14],opacity:1,className:'search-place-label'}).addTo(map);updatePlaceMarkers();}updateWeather(lat,lng,revision);if(reverse)nominatim('reverse?format=jsonv2&lat='+lat+'&lon='+lng+'&zoom=14&accept-language=zh-CN').then(data=>{if(revision!==state.revision)return;const a=data.address||{};setLocationText(a.city_district||a.suburb||a.county||a.city||a.town||a.village||name);$('location-status').textContent='';}).catch(()=>{});}
let autoLocateStarted=false;
function autoLocate(){if(autoLocateStarted||state.manual||state.latestPlan||window.WanderItineraryFocus?.active)return;autoLocateStarted=true;locate(false);}
function locate(manual=true){if(manual)state.manual=true;const revision=state.revision;$('locate').classList.add('loading');if(!navigator.geolocation){locationFailed();return;}navigator.geolocation.getCurrentPosition(position=>{if(revision!==state.revision||(!manual&&state.manual)){$('locate').classList.remove('loading');return;}$('locate').classList.remove('loading');selectLocation(position.coords.latitude,position.coords.longitude,'当前位置',13,true);},()=>{if(revision===state.revision&&(manual||!state.manual))locationFailed();else $('locate').classList.remove('loading');},{enableHighAccuracy:false,timeout:8000,maximumAge:300000});}
function locationFailed(){$('locate').classList.remove('loading');if(state.location.name===DEFAULT.name){if(map)map.setView([DEFAULT.lat,DEFAULT.lng],11);setLocationText(DEFAULT.name);$('location-status').textContent='';}}
$('locate').addEventListener('click',()=>locate(true));
let searchId=0;
$('search-form').addEventListener('submit',async event=>{event.preventDefault();const q=$('location-input').value.trim();if(!q)return;state.manual=true;const id=++searchId;++state.revision;$('location-status').textContent='正在寻找「'+q+'」…';if(window.WanderAMap?.ready){try{await window.WanderAMap.search(q);}catch{if(id===searchId)$('location-status').textContent='搜索暂不可用，请稍后再试';}return;}const known=places.find(p=>q===p.name||(q.length>=3&&(q.includes(p.name)||p.name.includes(q))));if(known){selectLocation(known.lat,known.lng,known.name,14);return;}try{const results=await nominatim('search?format=jsonv2&addressdetails=1&limit=5&accept-language=zh-CN&viewbox=108.6,34.6,109.3,33.9&q='+encodeURIComponent(q));if(id!==searchId)return;if(!results.length){$('location-status').textContent='未找到该地点，试试更完整的名称';updateWeather(state.location.lat,state.location.lng,state.revision);return;}const place=results[0],a=place.address||{};const name=place.name||[a.road||a.pedestrian,a.house_number? a.house_number+'号':''].filter(Boolean).join('')||q;selectLocation(Number(place.lat),Number(place.lon),name,14);}catch{if(id===searchId){$('location-status').textContent='搜索暂不可用，请稍后再试';updateWeather(state.location.lat,state.location.lng,state.revision);}}});
updateWeather(DEFAULT.lat,DEFAULT.lng,state.revision);
setInterval(()=>{updateWeather(state.location.lat,state.location.lng,state.revision);},15*60*1000);

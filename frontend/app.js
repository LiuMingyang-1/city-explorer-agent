'use strict';
const $ = id => document.getElementById(id);
const DEFAULT = {lat:34.27, lng:108.95, name:'西安市'};
const state = {location:{...DEFAULT}, revision:0, manual:false, weather:null, messages:[], busy:false};
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
const places=[
 {
  "name": "西安城墙",
  "lat": 34.2518,
  "lng": 108.9422,
  "kind": "wall",
  "rating": 5,
  "officialName": "西安城墙·碑林历史文化景区"
 },
 {
  "name": "钟楼",
  "lat": 34.26,
  "lng": 108.9423,
  "kind": "tower"
 },
 {
  "name": "大雁塔",
  "lat": 34.2186,
  "lng": 108.9599,
  "kind": "tower",
  "rating": 5,
  "officialName": "西安大雁塔·大唐芙蓉园景区"
 },
 {
  "name": "大明宫",
  "lat": 34.2975,
  "lng": 108.958,
  "kind": "wall",
  "rating": 5,
  "officialName": "大明宫国家遗址公园"
 },
 {
  "name": "陕西历史博物馆",
  "lat": 34.2223,
  "lng": 108.9482,
  "kind": "museum",
  "rating": 4
 },
 {
  "name": "大唐不夜城",
  "lat": 34.211,
  "lng": 108.961,
  "kind": "tower"
 },
 {
  "name": "回民街",
  "lat": 34.2653,
  "lng": 108.9398,
  "kind": "museum"
 },
 {
  "name": "大唐芙蓉园",
  "lat": 34.214938,
  "lng": 108.9693398,
  "kind": "tower",
  "rating": 5,
  "officialName": "西安大雁塔·大唐芙蓉园景区"
 },
 {
  "name": "西安碑林博物馆",
  "lat": 34.2550498,
  "lng": 108.9481311,
  "kind": "museum",
  "rating": 5,
  "officialName": "西安城墙·碑林历史文化景区"
 },
 {
  "name": "小雁塔",
  "lat": 34.2408014,
  "lng": 108.9373483,
  "kind": "tower",
  "rating": 4,
  "officialName": "西安博物院（小雁塔）"
 },
 {
  "name": "兵马俑",
  "lat": 34.3873627,
  "lng": 109.277673,
  "kind": "museum",
  "rating": 5,
  "officialName": "秦始皇帝陵博物院"
 },
 {
  "name": "华清宫",
  "lat": 34.3649458,
  "lng": 109.2075385,
  "kind": "wall",
  "rating": 5,
  "officialName": "陕西华清宫文化旅游景区"
 },
 {
  "name": "西安半坡博物馆",
  "lat": 34.2740167,
  "lng": 109.0479754,
  "kind": "museum",
  "rating": 4,
  "officialName": "西安半坡博物馆"
 },
 {
  "name": "汉城湖",
  "lat": 34.3064238,
  "lng": 108.9140225,
  "kind": "wall",
  "rating": 4,
  "officialName": "西安汉城湖景区"
 },
 {
  "name": "广仁寺",
  "lat": 34.2761654,
  "lng": 108.921228,
  "kind": "tower",
  "rating": 4,
  "officialName": "广仁寺文化景区"
 },
 {
  "name": "大唐西市",
  "lat": 34.2491473,
  "lng": 108.9033611,
  "kind": "museum",
  "rating": 4,
  "officialName": "西安大唐西市文化景区"
 },
 {
  "name": "曲江海洋极地公园",
  "lat": 34.2168352,
  "lng": 108.9758293,
  "kind": "museum",
  "rating": 4,
  "officialName": "曲江海洋极地公园"
 },
 {
  "name": "陕西自然博物馆",
  "lat": 34.1962901,
  "lng": 108.9415122,
  "kind": "museum",
  "rating": 4,
  "officialName": "陕西自然博物馆"
 },
 {
  "name": "秦岭野生动物园",
  "lat": 34.0488269,
  "lng": 108.8651073,
  "kind": "museum",
  "rating": 4,
  "officialName": "西安秦岭野生动物园"
 },
 {
  "name": "翠华山",
  "lat": 33.9831889,
  "lng": 109.0026197,
  "kind": "wall",
  "rating": 4,
  "officialName": "陕西翠华山国家地质公园"
 },
 {
  "name": "南五台",
  "lat": 33.9899964,
  "lng": 108.9747012,
  "kind": "tower",
  "rating": 4,
  "officialName": "南五台景区"
 },
 {
  "name": "诗经里",
  "lat": 34.2297617,
  "lng": 108.7334304,
  "kind": "wall",
  "rating": 4,
  "officialName": "诗经里小镇"
 }
];
const pinDraw={tower:'<path d="M3 11h10M4 11V7h8v4M3 7h10L8 3 3 7ZM8 1v2M5 13h6"/>',wall:'<path d="M2 13V5h3V3h2v2h3V3h2v2h2v8M2 9h12M7 13v-2h2v2"/>',museum:'<path d="m2 5 6-3 6 3H2Zm1 2v5m4-5v5m3-5v5m3-5v5M1 14h14"/>'};
function showMapStatus(text){$('map-status').textContent=text;$('map-status').hidden=!text;}
if(window.L){
 map=L.map('map',{zoomControl:false,minZoom:3,maxZoom:19,attributionControl:true}).setView([DEFAULT.lat,DEFAULT.lng],11);
 // OpenFreeMap vector tiles with a small, locally hosted style. Leaflet owns interactions.
 initBasemap();
 L.control.zoom({position:'bottomright'}).addTo(map);
 // Curated 4A/5A attractions remain visible, with labels placed to avoid overlap.
 places.forEach(place=>{place.marker=L.marker([place.lat,place.lng],{icon:placeIcon(place),title:(place.officialName||place.name)+(place.rating?' · '+place.rating+'A':''),riseOnHover:true});place.marker.on('click',()=>{state.manual=true;selectLocation(place.lat,place.lng,place.name,14);});});
 map.on('moveend zoomend resize',()=>updatePlaceMarkers());
 updatePlaceMarkers();
 setTimeout(autoLocate,3000);
}else{showMapStatus('地图组件加载失败，请刷新重试');setTimeout(autoLocate,0);}

function placeIcon(place,direction='right',label=true){
 const rated=place.rating?'<span class="place-rating">'+place.rating+'A</span>':'';
 return L.divIcon({className:'place-icon',html:'<div class="place-wrap direction-'+direction+(label?'':' label-hidden')+'"><span class="place-dot"><svg viewBox="0 0 16 16">'+pinDraw[place.kind]+'</svg></span><span class="place-name">'+place.name+rated+'</span></div>',iconSize:[22,22],iconAnchor:[11,11]});
}
function updatePlaceMarkers(names){
 if(!map)return;if(names!==undefined)highlightedPlaces=names;
 const size=map.getSize(),card=document.querySelector('.glass-card').getBoundingClientRect();
 const occupied=[{left:card.left,top:card.top,right:card.right,bottom:card.bottom}];
 const intersects=(a,b)=>a.left<b.right+6&&a.right>b.left-6&&a.top<b.bottom+6&&a.bottom>b.top-6;
 if(locationMarker){const p=map.latLngToContainerPoint(locationMarker.getLatLng());occupied.push({left:p.x-130,right:p.x+130,top:p.y-65,bottom:p.y+12});}
 const ordered=[...places].sort((a,b)=>Number(highlightedPlaces.includes(b.name))-Number(highlightedPlaces.includes(a.name))||(b.rating||0)-(a.rating||0));
 ordered.forEach(place=>{
  const p=map.latLngToContainerPoint([place.lat,place.lng]);
  const show=(place.rating>=4||highlightedPlaces.includes(place.name))&&!(locationMarker&&place.name===state.location.name)&&p.x>=-30&&p.y>=-30&&p.x<=size.x+30&&p.y<=size.y+30;
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
 let fallback=false,loadTimer;
 function useRaster(){
  if(fallback)return;fallback=true;clearTimeout(loadTimer);
  if(tiles){try{map.removeLayer(tiles);}catch{}tiles=null;}
  tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
   maxZoom:19,updateWhenIdle:true,updateWhenZooming:false,keepBuffer:1,
   attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
  }).addTo(map);
  let failures=0;tiles.on('tileerror',()=>{if(++failures>=4)showMapStatus('地图暂时无法连接，请稍后重试');});
  tiles.on('loading',()=>{failures=0;});
  tiles.on('load',()=>{if(failures===0)showMapStatus('');autoLocate();});
 }
 try{
  if(!window.maplibregl||!L.maplibreGL)throw new Error('Vector renderer unavailable');
  const style=await fetchJSON('assets/quiet-map.json');
  window.maplibregl.setWorkerCount(2);
  tiles=L.maplibreGL({style,interactive:false,padding:.05,updateInterval:32,
   pixelRatio:Math.min(window.devicePixelRatio||1,1.5),fadeDuration:0,
   localIdeographFontFamily:'sans-serif',maxTileCacheSize:80,
   attributionControl:{customAttribution:'<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> · <a href="https://openmaptiles.org" target="_blank" rel="noopener">OpenMapTiles</a> · &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'}
  }).addTo(map);
  const renderer=tiles.getMaplibreMap();let failures=0;
  renderer.once('load',()=>{clearTimeout(loadTimer);if(!fallback){showMapStatus('');autoLocate();}});
  renderer.on('error',()=>{if(++failures>=3)useRaster();});
  loadTimer=setTimeout(()=>{if(!renderer.loaded())useRaster();},15000);
 }catch{useRaster();}
}

async function fetchJSON(url){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);try{const response=await fetch(url,{signal:controller.signal,headers:{Accept:'application/json'}});if(!response.ok)throw new Error('HTTP '+response.status);return await response.json();}finally{clearTimeout(timer);}}
let geoQueue=Promise.resolve(),lastGeoTime=0;const geoCache=new Map();
function nominatim(path){if(geoCache.has(path))return Promise.resolve(geoCache.get(path));const request=geoQueue.catch(()=>{}).then(async()=>{const wait=Math.max(0,1100-(Date.now()-lastGeoTime));if(wait)await new Promise(resolve=>setTimeout(resolve,wait));lastGeoTime=Date.now();const data=await fetchJSON('https://nominatim.openstreetmap.org/'+path);geoCache.set(path,data);return data;});geoQueue=request;return request;}
async function updateWeather(lat,lng,revision){$('temperature').textContent='—';$('weather-description').textContent='获取天气中';state.weather=null;try{const data=await fetchJSON('https://api.open-meteo.com/v1/forecast?latitude='+lat+'&longitude='+lng+'&current=temperature_2m,weather_code,is_day&timezone=auto');if(revision!==state.revision)return;if(!data.current||!Number.isFinite(data.current.temperature_2m))throw new Error('No temperature');state.weather=data.current;const [description,type]=weatherInfo(data.current.weather_code,data.current.is_day);$('temperature').textContent=Math.round(data.current.temperature_2m);$('weather-description').textContent=description;renderWeatherIcon(type);}catch{if(revision===state.revision){$('temperature').textContent='—';$('weather-description').textContent='天气暂不可用';renderWeatherIcon('cloud');}}}
function setLocationText(name){state.location.name=name;$('location-input').value='';$('location-input').placeholder=name;if(locationMarker)locationMarker.setTooltipContent(locationLabel(name));}
function selectLocation(lat,lng,name,zoom=13,reverse=false){const revision=++state.revision;state.location={lat,lng,name};setLocationText(name);$('location-status').textContent='';if(map){highlightedPlaces=[];if(routeLayer){map.removeLayer(routeLayer);routeLayer=null;}map.flyTo([lat,lng],zoom,{duration:.9});if(locationMarker)map.removeLayer(locationMarker);locationMarker=L.marker([lat,lng],{title:name,zIndexOffset:1000,icon:L.divIcon({html:'<span class="location-dot"></span>',className:'current-location',iconSize:[18,18],iconAnchor:[9,9]})}).bindTooltip(locationLabel(name),{permanent:true,direction:'top',offset:[0,-14],opacity:1,className:'search-place-label'}).addTo(map);updatePlaceMarkers();}updateWeather(lat,lng,revision);if(reverse)nominatim('reverse?format=jsonv2&lat='+lat+'&lon='+lng+'&zoom=14&accept-language=zh-CN').then(data=>{if(revision!==state.revision)return;const a=data.address||{};setLocationText(a.city_district||a.suburb||a.county||a.city||a.town||a.village||name);$('location-status').textContent='';}).catch(()=>{});}
let autoLocateStarted=false;
function autoLocate(){if(autoLocateStarted||state.manual)return;autoLocateStarted=true;locate(false);}
function locate(manual=true){if(manual)state.manual=true;const revision=state.revision;$('locate').classList.add('loading');if(!navigator.geolocation){locationFailed();return;}navigator.geolocation.getCurrentPosition(position=>{if(revision!==state.revision){$('locate').classList.remove('loading');return;}$('locate').classList.remove('loading');selectLocation(position.coords.latitude,position.coords.longitude,'当前位置',13,true);},()=>{if(revision===state.revision)locationFailed();else $('locate').classList.remove('loading');},{enableHighAccuracy:false,timeout:8000,maximumAge:300000});}
function locationFailed(){$('locate').classList.remove('loading');if(state.location.name===DEFAULT.name){if(map)map.setView([DEFAULT.lat,DEFAULT.lng],11);setLocationText(DEFAULT.name);$('location-status').textContent='';}}
$('locate').addEventListener('click',()=>locate(true));
let searchId=0;
$('search-form').addEventListener('submit',async event=>{event.preventDefault();const q=$('location-input').value.trim();if(!q)return;state.manual=true;const id=++searchId;++state.revision;$('location-status').textContent='正在寻找「'+q+'」…';const known=places.find(p=>q===p.name||(q.length>=3&&(q.includes(p.name)||p.name.includes(q))));if(known){selectLocation(known.lat,known.lng,known.name,14);return;}try{const results=await nominatim('search?format=jsonv2&addressdetails=1&limit=5&accept-language=zh-CN&viewbox=108.6,34.6,109.3,33.9&q='+encodeURIComponent(q));if(id!==searchId)return;if(!results.length){$('location-status').textContent='未找到该地点，试试更完整的名称';updateWeather(state.location.lat,state.location.lng,state.revision);return;}const place=results[0],a=place.address||{};const name=place.name||[a.road||a.pedestrian,a.house_number? a.house_number+'号':''].filter(Boolean).join('')||q;selectLocation(Number(place.lat),Number(place.lon),name,14);}catch{if(id===searchId){$('location-status').textContent='搜索暂不可用，请稍后再试';updateWeather(state.location.lat,state.location.lng,state.revision);}}});
updateWeather(DEFAULT.lat,DEFAULT.lng,state.revision);
setInterval(()=>{updateWeather(state.location.lat,state.location.lng,state.revision);},15*60*1000);
function scrollMessages(){const list=$('messages');list.scrollTo({top:list.scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}
function appendMessage(role,text){$('empty-state')?.remove();state.messages.push({role,text});const message=document.createElement('div');message.className='message '+role;const label=document.createElement('span');label.className='message-label';label.textContent=role==='user'?'你':'漫游 · 城市向导';const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=text;message.append(label,bubble);$('messages').append(message);scrollMessages();return message;}
function drawRoute(names){if(!map)return;updatePlaceMarkers(names);const points=names.map(name=>places.find(p=>p.name===name)).filter(Boolean);if(routeLayer)map.removeLayer(routeLayer);routeLayer=L.polyline(points.map(p=>[p.lat,p.lng]),{color:'#b87552',weight:3,opacity:.8,dashArray:'5 9'}).addTo(map);routeLayer.bindTooltip('游玩顺序示意 · 非导航路线',{sticky:true});const card=document.querySelector('.glass-card').getBoundingClientRect();map.fitBounds(routeLayer.getBounds(),{paddingTopLeft:innerWidth>700?[card.right+45,110]:[30,100],paddingBottomRight:innerWidth>700?[100,90]:[45,card.height+45],maxZoom:14,animate:true});}
function simulateReply(text){const rainy=state.weather&&[51,53,55,61,63,65,80,81,82,95].includes(state.weather.weather_code);let names,reply;
 if(/雁塔|大唐|下午/.test(text)){names=['陕西历史博物馆','大雁塔','大唐不夜城'];reply='好的，把一个下午留给雁塔吧。\n\n陕西历史博物馆 → 大雁塔 → 大唐不夜城\n\n先看一眼千年长安，再在大雁塔周边慢慢散步。傍晚去大唐不夜城，等灯亮起来。博物馆记得提前查验预约与开放时间。';}
 else if(/吃|美食|小吃|回民/.test(text)){names=['钟楼','回民街','西安城墙'];reply='想感受西安的烟火气，可以这样逛：\n\n钟楼 → 回民街 → 西安城墙\n\n在钟楼附近出发，沿回民街找一碗泡馍、尝尝甑糕，吃饱后到城墙周边散步消食。小份慢尝，给下一口留点位置。';}
 else if(/雨|博物馆|室内/.test(text)){names=['陕西历史博物馆','大雁塔'];reply='安排一段不赶时间的文化之旅吧。\n\n陕西历史博物馆 → 大雁塔\n\n上午把时间交给博物馆，午后找间附近的茶馆歇歇脚，天气合适再去大雁塔走走。博物馆需提前核实预约、开放与入馆要求。';}
 else{names=['钟楼','西安城墙','大雁塔'];reply='好的，我来帮你规划一下西安的游玩路线。\n\n钟楼 → 西安城墙 → 大雁塔\n\n从城市的中心出发，在城墙感受长安的尺度，再到大雁塔附近等一场日落。预留半天到一天，走累了就停下来喝杯茶。\n\n你更想看古迹，还是尝一尝本地美食？';}
 if(rainy)reply+='\n\n当前有降水，带把伞，户外行程可以随天气调整。';return {reply,names};}
/** Backend integration point: replace the simulation inside sendMessage(text)
 * with fetch('/api/chat', {method:'POST',headers:{'Content-Type':'application/json'},
 * body:JSON.stringify({messages:state.messages, location:state.location})}).
 * Render returned content using appendMessage('assistant', response.text).
 */
async function sendMessage(text){text=String(text).trim();if(!text||state.busy)return;state.busy=true;appendMessage('user',text);$('message-input').value='';updateSendButton();const pending=document.createElement('div');pending.className='message assistant';pending.innerHTML='<span class="message-label">漫游正在整理灵感</span><div class="bubble typing" aria-label="正在回复">···</div>';$('messages').append(pending);scrollMessages();try{await new Promise(resolve=>setTimeout(resolve,850));const result=simulateReply(text);pending.remove();appendMessage('assistant',result.reply);drawRoute(result.names);}catch{pending.remove();appendMessage('assistant','刚刚走神了一下，再告诉我一次你的想法吧。');}finally{state.busy=false;updateSendButton();$('message-input').focus({preventScroll:true});}}
window.sendMessage=sendMessage;
function updateSendButton(){$('send-button').disabled=state.busy||!$('message-input').value.trim();}
$('message-input').addEventListener('input',updateSendButton);
$('chat-form').addEventListener('submit',event=>{event.preventDefault();if(!event.isComposing)sendMessage($('message-input').value);});
$('message-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&event.isComposing)event.preventDefault();});

'use strict';
// Native AMap provider. Existing GPS/OSM samples retain their source coordinates.
(() => {
 let native,config,onSelect,selectedMarker,ready=false,selectionEpoch=0,routeEpoch=0,searchEpoch=0;
 let routes=[],scenes=[],currentNames=[],selectedPosition=null,selectedName='';
 const converted=new Map(),addresses=new Map();
 const valid=(lat,lng)=>typeof lat==='number'&&typeof lng==='number'&&Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180;
 const key=p=>p[0].toFixed(7)+','+p[1].toFixed(7);
 const point=p=>[typeof p.getLng==='function'?p.getLng():p.lng,typeof p.getLat==='function'?p.getLat():p.lat];
 function call(invoke){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('高德地图服务超时')),10000);try{invoke((status,result)=>{clearTimeout(timer);if(status==='complete')resolve(result);else reject(new Error('高德地图服务暂不可用'));});}catch{clearTimeout(timer);reject(new Error('高德地图服务暂不可用'));}});}
 function loadSDK(jsKey,serviceHost){return new Promise((resolve,reject)=>{
  window._AMapSecurityConfig={serviceHost:new URL(serviceHost,window.location.href).href};
  const script=document.createElement('script'),timer=setTimeout(()=>reject(new Error('高德组件加载超时')),15000);
  script.src='https://webapi.amap.com/maps?v=2.0&key='+encodeURIComponent(jsKey);script.async=true;
  script.onerror=()=>{clearTimeout(timer);reject(new Error('高德组件加载失败'));};
  script.onload=()=>{window.AMap.plugin(['AMap.PlaceSearch','AMap.Geocoder','AMap.Weather','AMap.ToolBar'],()=>{clearTimeout(timer);resolve();});};
  document.head.append(script);
 });}
 async function convert(points,system='WGS84'){
  if(!points.every(p=>Array.isArray(p)&&valid(p[1],p[0])))throw new Error('坐标无效');
  if(['GCJ02','GCJ-02'].includes(String(system).toUpperCase()))return points;
  if(!['WGS84','WGS-84'].includes(String(system).toUpperCase()))throw new Error('坐标系尚不支持');
  const missing=[...new Map(points.filter(p=>!converted.has(key(p))).map(p=>[key(p),p])).values()];
  for(let at=0;at<missing.length;at+=40){
   const batch=missing.slice(at,at+40),result=await call(callback=>window.AMap.convertFrom(batch,'gps',callback));
   if(!Array.isArray(result.locations)||result.locations.length!==batch.length)throw new Error('坐标转换未完成');
   batch.forEach((p,i)=>converted.set(key(p),point(result.locations[i])));
  }
  return points.map(p=>converted.get(key(p)));
 }
 async function address(lng,lat){
  const cacheKey=key([lng,lat]);if(addresses.has(cacheKey))return addresses.get(cacheKey);
  const result=await call(callback=>new window.AMap.Geocoder({extensions:'base'}).getAddress([lng,lat],callback));
  if(!result.regeocode)throw new Error('地址暂不可用');addresses.set(cacheKey,result.regeocode);return result.regeocode;
 }
 function clearRoutes(){routeEpoch++;if(native&&routes.length)native.remove(routes);routes=[];}
 async function select(lat,lng,name,zoom=13,{system='WGS84',reverse=false,wgs84}={}){
  searchEpoch++;const epoch=++selectionEpoch,[position]=await convert([[lng,lat]],system);if(epoch!==selectionEpoch)return;
  clearRoutes();let displayName=name;
  if(reverse){try{const a=await address(...position);if(epoch!==selectionEpoch)return;displayName=a.addressComponent?.district||a.formattedAddress||name;}catch{}}
  if(selectedMarker)native.remove(selectedMarker);
  const content=document.createElement('div');content.className='native-selection';
  const dot=document.createElement('span');dot.className='location-dot';
  const label=document.createElement('span');label.className='native-selection-name';label.textContent=displayName;content.append(dot,label);
  selectedPosition=position;selectedName=displayName;selectedMarker=new window.AMap.Marker({position,content,anchor:'center',zIndex:500});native.add(selectedMarker);native.setZoomAndCenter(zoom,position);
  const original=['WGS84','WGS-84'].includes(String(system).toUpperCase())?{lat,lng}:wgs84||null;
  onSelect({lat:position[1],lng:position[0],name:displayName,coordinateSystem:'GCJ02',wgs84:original});updatePlaces();
 }
 function updatePlaces(names){
  if(names!==undefined)currentNames=names;if(!native)return;
  const size=native.getSize(),width=size.getWidth?.()??size.width,height=size.getHeight?.()??size.height;
  const card=document.querySelector('.glass-card').getBoundingClientRect(),occupied=[card];
  if(selectedPosition){const p=native.lngLatToContainer(selectedPosition),x=p.getX?.()??p.x,y=p.getY?.()??p.y;occupied.push({left:x-135,right:x+135,top:y-65,bottom:y+12});}
  const overlap=(a,b)=>a.left<b.right+6&&a.right>b.left-6&&a.top<b.bottom+6&&a.bottom>b.top-6;
  [...scenes].sort((a,b)=>Number(currentNames.includes(b.place.name))-Number(currentNames.includes(a.place.name))||(b.place.rating||0)-(a.place.rating||0)).forEach(scene=>{
   const p=native.lngLatToContainer(scene.position),x=p.getX?.()??p.x,y=p.getY?.()??p.y;
   const show=(scene.place.rating>=4||currentNames.includes(scene.place.name))&&scene.place.name!==selectedName&&x>=-25&&x<=width+25&&y>=-25&&y<=height+25;
   scene.marker.setMap(show?native:null);if(!show)return;
   const w=Array.from(scene.place.name).length*11+50,h=29;
   const positions=[['right',{left:x+17,right:x+17+w,top:y-h/2,bottom:y+h/2}],['left',{left:x-17-w,right:x-17,top:y-h/2,bottom:y+h/2}],['top',{left:x-w/2,right:x+w/2,top:y-18-h,bottom:y-18}],['bottom',{left:x-w/2,right:x+w/2,top:y+18,bottom:y+18+h}]];
   const fit=positions.find(([,r])=>r.left>8&&r.right<width-8&&r.top>8&&r.bottom<height-25&&!occupied.some(other=>overlap(r,other)));
   scene.content.className='place-wrap direction-'+(fit?.[0]||'right')+(fit?'':' label-hidden');if(fit)occupied.push(fit[1]);
  });
 }
 async function init({places=[],onSelect:callback}={}){
  try{const response=await fetch('/api/map-config',{credentials:'same-origin'});if(!response.ok)return false;config=await response.json();}catch{return false;}
  if(!config.enabled)return false;onSelect=callback;
  await loadSDK(config.jsKey,config.serviceHost);
  const inputs=[[108.95,34.27],...places.map(p=>[p.lng,p.lat])],positions=await convert(inputs);
  native=new window.AMap.Map('map',{center:positions[0],zoom:11,viewMode:'2D',mapStyle:config.style,features:['bg','road'],showLabel:false,resizeEnable:true});
  native.addControl(new window.AMap.ToolBar({position:'RB',offset:new window.AMap.Pixel(28,65)}));
  places.forEach((place,index)=>{
   const content=document.createElement('div');content.className='place-wrap direction-right';
   const dot=document.createElement('span');dot.className='place-dot';dot.textContent='·';
   const name=document.createElement('span');name.className='place-name';name.textContent=place.name;
   if(place.rating){const rating=document.createElement('span');rating.className='place-rating';rating.textContent=place.rating+'A';name.append(rating);}content.append(dot,name);
   const position=positions[index+1],marker=new window.AMap.Marker({position,content,anchor:'center',title:place.officialName||place.name,zIndex:150});
   marker.on('click',()=>{state.manual=true;select(place.lat,place.lng,place.name,14).catch(()=>showMapStatus('地点暂不可用'));});scenes.push({place,position,marker,content});
  });
  ready=true;native.on('moveend',()=>updatePlaces());native.on('zoomend',()=>updatePlaces());updatePlaces();
  onSelect({lat:positions[0][1],lng:positions[0][0],name:'西安市',coordinateSystem:'GCJ02',wgs84:{lat:34.27,lng:108.95}});
  return true;
 }
 async function search(query){
  const epoch=++searchEpoch;let place;
  try{const result=await call(callback=>new window.AMap.PlaceSearch({city:'西安',citylimit:false,pageSize:1}).search(query,callback));place=result.poiList?.pois?.[0];}catch{}
  if(epoch!==searchEpoch)return;
  if(!place?.location){const result=await call(callback=>new window.AMap.Geocoder({city:'西安'}).getLocation(query,callback));place=result.geocodes?.[0];}
  if(epoch!==searchEpoch)return;if(!place?.location)throw new Error('没有找到这个地点');
  const [lng,lat]=point(place.location);await select(lat,lng,place.name||place.formattedAddress||query,14,{system:'GCJ02'});
 }

 async function weather(lat,lng){
  const a=await address(lng,lat),adcode=a.addressComponent?.adcode;
  if(typeof adcode!=='string'||!adcode)throw new Error('天气地区暂不可用');
  return await call(callback=>new window.AMap.Weather().getLive(adcode,callback));
 }
 async function drawPlans(model,{fit=true,onSelect:choose}={}){
  clearRoutes();const epoch=routeEpoch,byId=new Map(model.events.map(e=>[e.event_id,e]));
  const points=[],items=[];
  model.plans.forEach((plan,index)=>plan.itinerary.stops.forEach((stop,i)=>{
   const event=byId.get(stop.event_id);if(!event||!valid(event.latitude,event.longitude))return;
   const pointIndex=points.push([event.longitude,event.latitude])-1;items.push({type:'dot',pointIndex,plan,index,i,event});
   const next=plan.itinerary.stops[i+1],leg=(plan.legs||[]).find(l=>l.from_event_id===stop.event_id&&l.to_event_id===next?.event_id),path=window.WanderPlans.geometry(leg);
   if(path){const start=points.length;points.push(...path.map(p=>[p[1],p[0]]));items.push({type:'line',start,length:path.length,plan,index});}
  }));
  if(!points.length)return;
  try{
   const translated=await convert(points,model.coordinate_system||'WGS84');if(epoch!==routeEpoch)return;
   items.sort((a,b)=>Number(a.plan.plan_id===model.active_plan)-Number(b.plan.plan_id===model.active_plan));
   routes=items.map(item=>{
    const selected=item.plan.plan_id===model.active_plan,color=(item.plan.label==='B'||item.index===1)?'#64859a':'#b67a55';let layer;
    if(item.type==='line')layer=new window.AMap.Polyline({path:translated.slice(item.start,item.start+item.length),strokeColor:color,strokeWeight:selected?4:3,strokeOpacity:selected ? .9 : .25,zIndex:selected?120:100});
    else{const content=document.createElement('div');content.className='native-route-dot';content.style.background=color;content.style.opacity=selected?'1':'.5';content.title='方案 '+item.plan.label+' · '+(item.i+1)+'. '+item.event.title;content.textContent=String(item.i+1);layer=new window.AMap.Marker({position:translated[item.pointIndex],content,anchor:'center',zIndex:selected?300:200});}
    if(choose)layer.on('click',()=>choose(item.plan.plan_id));return layer;
   });native.add(routes);
   if(fit&&routes.length){const card=document.querySelector('.glass-card').getBoundingClientRect();native.setFitView(routes,false,innerWidth>700?[70,70,60,card.right+45]:[60,25,card.height+35,25],15);}
  }catch{if(epoch===routeEpoch)showMapStatus('路线坐标转换暂不可用');}
 }
 function backendLocation(location){
  if(config?.backendCoordinateSystem==='GCJ02'&&location?.coordinateSystem==='GCJ02')return {lat:location.lat,lng:location.lng};
  if(location?.coordinateSystem==='GCJ02')return location.wgs84||null;
  return location;
 }

 async function loadFallback(){
  for(const href of ['assets/leaflet.css','assets/maplibre-gl.css']){const link=document.createElement('link');link.rel='stylesheet';link.href=href;document.head.append(link);}
  for(const [global,src] of [['L','assets/leaflet.js'],['maplibregl','assets/maplibre-gl.js'],['returnExports','assets/leaflet-maplibre-gl.js']]){
   if(window[global])continue;await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=reject;document.head.append(script);});
  }
 }
 function cancelPending(){selectionEpoch++;searchEpoch++;}
 function dispose(){ready=false;cancelPending();clearRoutes();native?.destroy();native=null;scenes=[];selectedPosition=null;selectedName='';}
 window.WanderAMap={init,dispose,cancelPending,loadFallback,convert,select,search,weather,updatePlaces,drawPlans,clearRoutes,backendLocation,get ready(){return ready;}};
})();

'use strict';
// Native AMap provider. Existing GPS/OSM samples retain their source coordinates.
(() => {
 let native,config,onSelect,selectedMarker,ready=false,selectionEpoch=0,routeEpoch=0,searchEpoch=0,initEpoch=0,configRequest;
 let routes=[],scenes=[],currentNames=[],selectedPosition=null,selectedName='',activityMarkers=[],activitiesEpoch=0;
 const converted=new Map(),addresses=new Map();
 let stopRouteAnimation,routeStrokes=[],fitLayers=[],creditObserver,creditNode,creditCanvas;
 // Isolated candidate layer (issue #41): own marker set + epoch, never touches
 // routes/activities/scenes/selected/fitLayers and never triggers fit/pan.
 let candidateEpoch=0,candidateAnchorListener=null;
 const candidateMarkers=new Map(),candidateAnchors=new Map();
 const CANDIDATE_MARGIN=60;
 function syncAttribution(){
  const host=document.getElementById?.('map'),copy=host?.querySelector?.('.amap-copyright'),canvas=host?.closest?.('.canvas');if(!copy||!canvas)return;
  // The live map is inside #map-shell. Layout variables and panel selectors
  // belong on the outer canvas, not that resizable map-only wrapper.
  creditCanvas=canvas;creditCanvas.classList.add('amap-attribution-layout');
  const measure=()=>{if(creditNode!==copy||!creditCanvas||!copy.isConnected)return;const value=Math.ceil(copy.getBoundingClientRect().height)||16;creditCanvas.style.setProperty('--amap-credit-height',value+'px');};
  if(copy!==creditNode){creditObserver?.disconnect();creditNode=copy;if(typeof ResizeObserver==='function'){creditObserver=new ResizeObserver(measure);creditObserver.observe(copy,{box:'border-box'});}}
  measure();
 }
 function clearAttribution(){creditObserver?.disconnect();creditObserver=null;creditNode=null;creditCanvas?.classList.remove('amap-attribution-layout');creditCanvas?.style.removeProperty('--amap-credit-height');creditCanvas=null;}
 function updateRouteWidths(){
  const zoom=native?.getZoom?.()||11;routeStrokes.forEach(item=>{const style=window.WanderRouteVisuals.stroke(zoom,item.selected);if(style.width===item.width)return;item.width=style.width;item.layers.forEach(layer=>layer.setOptions({strokeWeight:style.width,borderWeight:style.border}));});
 }
 const valid=(lat,lng)=>typeof lat==='number'&&typeof lng==='number'&&Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180;
 const key=p=>p[0].toFixed(7)+','+p[1].toFixed(7);
 const point=p=>[typeof p.getLng==='function'?p.getLng():p.lng,typeof p.getLat==='function'?p.getLat():p.lat];
 function visibility(item,show){if(item.visible!==show){item.marker.setMap(show?native:null);item.visible=show;}}
 function call(invoke,{errorFirst=false}={}){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('高德地图服务超时')),10000);try{invoke((status,result)=>{clearTimeout(timer);if(errorFirst?status==null:status==='complete')resolve(result);else reject(new Error('高德地图服务暂不可用'));});}catch{clearTimeout(timer);reject(new Error('高德地图服务暂不可用'));}});}
 // Diagnostics contain only fixed stage/code values, never upstream text or URLs.
 const diagnostics=[];let attempt=0,lastFailure=null,renderer=null,sdkPromise,placesReady=Promise.resolve();
 function report(stage,code,level='error'){
  const entry={attempt,stage,code,level,at:Date.now()};diagnostics.push(entry);if(diagnostics.length>60)diagnostics.shift();
  if(level==='error')lastFailure=entry;
  if(typeof CustomEvent==='function')window.dispatchEvent(new CustomEvent('wander:map-diagnostic',{detail:entry}));
  return entry;
 }
 function failure(stage,code){const error=new Error(stage+':'+code);error.stage=stage;error.code=code;return error;}
 function timeout(promise,ms,stage,code){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(failure(stage,code)),ms);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});}
 async function readConfig(epoch){
  for(let i=0;i<2;i++){
   configRequest=new AbortController();const controller=configRequest,timer=setTimeout(()=>controller.abort(),12000);
   try{
    const response=await fetch('/api/map-config',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
    if(!response.ok)throw failure('config','http-'+response.status);
    let value;try{value=await response.json();}catch{throw failure('config','invalid-response');}
    if(!value||typeof value.enabled!=='boolean')throw failure('config','invalid-response');
    return value;
   }catch(error){
    if(epoch!==initEpoch)throw failure('lifecycle','cancelled');
    const issue=error.stage?error:failure('config',controller.signal.aborted?'timeout':'network');
    report(issue.stage,issue.code,i===0?'warning':'error');
    if(i===1)throw issue;
   }finally{clearTimeout(timer);if(configRequest===controller)configRequest=null;}
  }
 }
 function loadSDK(jsKey,serviceHost){
  window._AMapSecurityConfig={serviceHost:new URL(serviceHost,window.location.href).href};
  if(window.AMap?.Map)return Promise.resolve();
  // Keep one in-flight script after timeout: a late SDK may be reused on retry,
  // but cannot create a map or commit an obsolete initialization by itself.
  if(!sdkPromise){
   sdkPromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src='https://webapi.amap.com/maps?v=2.0&key='+encodeURIComponent(jsKey);script.async=true;
    script.onerror=()=>{script.onload=script.onerror=null;script.remove();reject(failure('sdk','network'));};
    script.onload=()=>{script.onload=script.onerror=null;if(window.AMap?.Map)resolve();else reject(failure('sdk','invalid-api'));};
    document.head.append(script);
   });
   sdkPromise.catch(()=>{sdkPromise=null;});
  }
  return timeout(sdkPromise,20000,'sdk','timeout');
 }
 const pluginPromises=new Map();
 async function plugin(name){
  const operationAttempt=attempt;
  if(window.AMap?.[name])return;
  if(!pluginPromises.has(name)){
   const pending=timeout(new Promise((resolve,reject)=>{
    try{window.AMap.plugin(['AMap.'+name],()=>window.AMap[name]?resolve():reject(failure('plugin','unavailable')));}catch{reject(failure('plugin','load-failed'));}
   }),15000,'plugin','timeout');
   pluginPromises.set(name,pending);pending.catch(()=>pluginPromises.delete(name));
  }
  try{await pluginPromises.get(name);}catch(error){if(attempt===operationAttempt)report('plugin',error.code||'load-failed','warning');throw error;}
 }
 async function convert(points,system='WGS84'){
  const operationAttempt=attempt;
  if(!points.every(p=>Array.isArray(p)&&valid(p[1],p[0])))throw new Error('坐标无效');
  if(['GCJ02','GCJ-02'].includes(String(system).toUpperCase()))return points;
  if(!['WGS84','WGS-84'].includes(String(system).toUpperCase()))throw new Error('坐标系尚不支持');
  const missing=[...new Map(points.filter(p=>!converted.has(key(p))).map(p=>[key(p),p])).values()];
  for(let at=0;at<missing.length;at+=40){
   // The SDK normalizes its input array in place into LngLat objects.
   // Keep numeric originals intact for cache keys and callers (including route data).
   const batch=missing.slice(at,at+40),sdkInput=batch.map(p=>[p[0],p[1]]);
   let result;try{result=await call(callback=>window.AMap.convertFrom(sdkInput,'gps',callback));}
   catch(error){if(attempt===operationAttempt)report('coordinates',/超时/.test(error.message)?'timeout':'service-failed','warning');throw error;}
   if(!Array.isArray(result.locations)||result.locations.length!==batch.length||result.locations.some(p=>!p||!valid(point(p)[1],point(p)[0]))){if(attempt===operationAttempt)report('coordinates','invalid-response','warning');throw new Error('坐标转换未完成');}
   batch.forEach((p,i)=>converted.set(key(p),point(result.locations[i])));
  }
  return points.map(p=>converted.get(key(p)));
 }
 async function address(lng,lat){
  const cacheKey=key([lng,lat]);if(addresses.has(cacheKey))return addresses.get(cacheKey);
  await plugin('Geocoder');
  const result=await call(callback=>new window.AMap.Geocoder({extensions:'base'}).getAddress([lng,lat],callback));
  if(!result.regeocode)throw new Error('地址暂不可用');addresses.set(cacheKey,result.regeocode);return result.regeocode;
 }
 function clearRoutes(){fitLayers=[];routeEpoch++;stopRouteAnimation?.();stopRouteAnimation=null;routeStrokes=[];if(native&&routes.length)native.remove(routes);routes=[];}
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
  const card=document.querySelector('.glass-card').getBoundingClientRect(),occupied=window.WanderItineraryFocus?.active?[]:[card];
  if(selectedMarker)selectedMarker.setMap(window.WanderItineraryFocus?.active?null:native);
  for(const id of ['activity-detail','preferences-panel']){const detail=document.getElementById?.(id);if(detail&&!detail.hidden)occupied.push(detail.getBoundingClientRect());}
  if(selectedPosition){const p=native.lngLatToContainer(selectedPosition),x=p.getX?.()??p.x,y=p.getY?.()??p.y;occupied.push({left:x-135,right:x+135,top:y-65,bottom:y+12});}
  const overlap=(a,b)=>a.left<b.right+6&&a.right>b.left-6&&a.top<b.bottom+6&&a.bottom>b.top-6;
  [...scenes].sort((a,b)=>Number(currentNames.includes(b.place.name))-Number(currentNames.includes(a.place.name))||(b.place.rating||0)-(a.place.rating||0)).forEach(scene=>{
   const p=native.lngLatToContainer(scene.position),x=p.getX?.()??p.x,y=p.getY?.()??p.y;
   const show=!window.WanderItineraryFocus?.active&&(scene.place.rating>=4||currentNames.includes(scene.place.name))&&scene.place.name!==selectedName&&x>=-25&&x<=width+25&&y>=-25&&y<=height+25;
   visibility(scene,show);if(!show)return;
   const w=Array.from(scene.place.name).length*11+50,h=29;
   const positions=[['right',{left:x+17,right:x+17+w,top:y-h/2,bottom:y+h/2}],['left',{left:x-17-w,right:x-17,top:y-h/2,bottom:y+h/2}],['top',{left:x-w/2,right:x+w/2,top:y-18-h,bottom:y-18}],['bottom',{left:x-w/2,right:x+w/2,top:y+18,bottom:y+18+h}]];
   const fit=positions.find(([,r])=>r.left>8&&r.right<width-8&&r.top>8&&r.bottom<height-25&&!occupied.some(other=>overlap(r,other)));
   const cls='place-wrap direction-'+(fit?.[0]||'right')+(fit?'':' label-hidden');if(scene.content.className!==cls)scene.content.className=cls;if(fit)occupied.push(fit[1]);
  });
  updateActivityBubbles({width,height,occupied});
  updateCandidateLayer();
 }
 // Candidate dots simply hide with the layer; anchors additionally report their
 // real on-screen state so the card can restore a clone face when its map
 // anchor is off-screen, covered by the detail focus, or the SDK is gone.
 function updateCandidateLayer(){
  if(!candidateMarkers.size&&!candidateAnchors.size)return;
  const hidden=window.WanderItineraryFocus?.active===true;
  for(const item of candidateMarkers.values())visibility(item,ready&&!hidden);
  const size=ready?native.getSize():null,w=size?(size.getWidth?.()??size.width):0,h=size?(size.getHeight?.()??size.height):0;
  for(const [id,item] of candidateAnchors){
   let show=ready&&!hidden;
   if(show){const p=native.lngLatToContainer(item.position),x=p.getX?.()??p.x,y=p.getY?.()??p.y;show=x>=-CANDIDATE_MARGIN&&x<=w+CANDIDATE_MARGIN&&y>=-CANDIDATE_MARGIN&&y<=h+CANDIDATE_MARGIN;}
   if(item.visible!==show)visibility(item,show);
   if(item.anchored!==show){item.anchored=show;try{candidateAnchorListener?.(id,show);}catch{}}
  }
 }
 function releaseCandidate(item){try{item.marker.setMap(null);}catch{}try{item.el?.remove?.();}catch{}}
 function clearCandidateMarks(){
  candidateEpoch++;
  for(const item of candidateMarkers.values())releaseCandidate(item);
  candidateMarkers.clear();
  for(const [id,item] of candidateAnchors){releaseCandidate(item);if(item.anchored){item.anchored=false;try{candidateAnchorListener?.(id,false);}catch{}}}
  candidateAnchors.clear();
 }
 // Narrow renderer surface for WanderCandidates. Positions are GCJ-02
 // [lng,lat] pairs and still pass through convert() — the module's single
 // coordinate entry — so a future system change stays in one place.
 async function renderCandidates(spec){
  const epoch=++candidateEpoch;
  if(spec&&typeof spec.onAnchor==='function')candidateAnchorListener=spec.onAnchor;
  if(!ready)return false;
  const dots=Array.isArray(spec?.dots)?spec.dots:[],anchors=Array.isArray(spec?.anchors)?spec.anchors:[];
  const points=[],refs=[];
  const push=(kind,item)=>{const p=item?.position;if(!Array.isArray(p)||!valid(p[1],p[0]))return;refs.push({kind,item,index:points.length});points.push([p[0],p[1]]);};
  dots.forEach(item=>push('dot',item));anchors.forEach(item=>push('anchor',item));
  let translated;
  try{translated=await convert(points,'GCJ-02');}catch{return false;}
  if(epoch!==candidateEpoch||!ready)return false;
  const seenDots=new Set(),seenAnchors=new Set();
  for(const ref of refs){
   const position=translated[ref.index];
   if(ref.kind==='dot'){
    const d=ref.item,id=typeof d.id==='string'&&d.id?d.id:null;if(!id)continue;
    let item=candidateMarkers.get(id);
    if(!item){
     const el=document.createElement('div');el.className='wander-candidate-dot';el.setAttribute('data-palette','neutral');
     item={marker:new window.AMap.Marker({position,content:el,anchor:'center',zIndex:160}),el,position,visible:false,tone:'neutral',dim:false,title:'',anchored:false};
     candidateMarkers.set(id,item);
    }
    if(key(item.position)!==key(position)){item.marker.setPosition(position);item.position=position;}
    const tone=typeof d.tone==='string'&&d.tone?d.tone:'neutral',dim=d.dim===true,title=String(d.title??'');
    if(item.tone!==tone){item.el.setAttribute('data-palette',tone);item.tone=tone;}
    if(item.dim!==dim){item.el.classList.toggle('dim',dim);item.dim=dim;}
    if(d.highlight===true&&!item.el.classList.contains('highlight'))item.el.classList.add('highlight');
    if(d.highlight!==true&&item.el.classList.contains('highlight'))item.el.classList.remove('highlight');
    if(item.title!==title){item.el.title=title;item.marker.setTitle?.(title);item.title=title;}
    seenDots.add(id);
   }else{
    const a=ref.item,id=typeof a.id==='string'&&a.id?a.id:null;if(!id||!a.node)continue;
    let item=candidateAnchors.get(id);
    if(item&&item.el!==a.node){releaseCandidate(item);if(item.anchored){item.anchored=false;try{candidateAnchorListener?.(id,false);}catch{}}candidateAnchors.delete(id);item=null;}
    if(!item){
     item={marker:new window.AMap.Marker({position,content:a.node,anchor:'center',zIndex:180,title:String(a.title??'')}),el:a.node,position,visible:false,anchored:false};
     candidateAnchors.set(id,item);
    }
    if(key(item.position)!==key(position)){item.marker.setPosition(position);item.position=position;}
    const title=String(a.title??'');if(item.title!==title){item.title=title;item.marker.setTitle?.(title);}
    seenAnchors.add(id);
   }
  }
  for(const [id,item] of candidateMarkers)if(!seenDots.has(id)){releaseCandidate(item);candidateMarkers.delete(id);}
  for(const [id,item] of candidateAnchors)if(!seenAnchors.has(id)){releaseCandidate(item);if(item.anchored){item.anchored=false;try{candidateAnchorListener?.(id,false);}catch{}}candidateAnchors.delete(id);}
  updateCandidateLayer();
  return true;
 }
 // Container-independent viewport point for the decorative entrance flight;
 // real anchoring is always the marker's geo position, never this pixel.
 function candidatePoint(position){
  if(!ready||!Array.isArray(position)||!valid(position[1],position[0]))return null;
  const p=native.lngLatToContainer(position);if(!p)return null;
  const rect=native.getContainer?.().getBoundingClientRect?.()||document.getElementById?.('map')?.getBoundingClientRect?.();
  const x=p.getX?.()??p.x,y=p.getY?.()??p.y;
  return rect?{x:rect.left+x,y:rect.top+y}:{x,y};
 }
 // Fixed Xi'an bootstrap center in GCJ-02, derived from the repository's
 // wgs84ToGcj02({lat:34.27,lng:108.95}). Do not interpret WGS coordinates as GCJ.
 const XI_AN_GCJ=[108.95467940704778,34.268431458802404];
 async function init({places=[],onSelect:callback,beforeCreate}={}){
  if(native)dispose();else configRequest?.abort();
  const epoch=++initEpoch;attempt++;lastFailure=null;renderer=null;onSelect=callback;
  try{
   const value=await readConfig(epoch);if(epoch!==initEpoch)return false;config=value;
   if(!config.enabled){report('config',['missing-js-key','missing-security-config'].includes(config.reason)?config.reason:'disabled');return false;}
   if(typeof config.jsKey!=='string'||!config.jsKey||typeof config.serviceHost!=='string'||!config.serviceHost){report('config','invalid-response');return false;}
   // One bounded retry for a transient script network failure. Timeout retains
   // the shared script and offers an explicit retry via the fallback UI.
   try{await loadSDK(config.jsKey,config.serviceHost);}catch(error){if(error.code!=='network')throw error;report('sdk','network','warning');if(epoch!==initEpoch)return false;await loadSDK(config.jsKey,config.serviceHost);}
   if(epoch!==initEpoch)return false;
   beforeCreate?.();
   try{native=new window.AMap.Map('map',{center:[...XI_AN_GCJ],zoom:11,viewMode:'2D',mapStyle:config.style,features:['bg','road'],showLabel:false,showBuildingBlock:false,isHotspot:false,resizeEnable:true});}
   catch{throw failure('renderer','initialization-failed');}
   // DOM is a supported SDK renderer. Its denser raster labels are preferable
   // to discarding an otherwise usable AMap on devices without WebGL.
   renderer=native.isDOMMode?.()||native.baseRender==='d'?'dom':'webgl';report('renderer',renderer,'info');
   const current=native,quiet=()=>{if(epoch!==initEpoch||native!==current)return;try{native.setFeatures?.(['bg','road']);native.set?.('showLabel',false);}catch{}syncAttribution();};quiet();
   native.on('complete',quiet);native.on('styleChanged',quiet);native.on('styleLoaded',quiet);
   ready=true;
   const moved=()=>{if(epoch!==initEpoch||native!==current)return;syncAttribution();updateRouteWidths();updatePlaces();window.dispatchEvent(new Event('wander:viewport'));};
   native.on('moveend',moved);native.on('zoomend',moved);native.on('resize',moved);native.on('zoomchange',updateRouteWidths);
   // Optional plugins and curated markers cannot decide the basemap provider.
   plugin('ToolBar').then(()=>{if(epoch===initEpoch&&ready)native.addControl(new window.AMap.ToolBar({position:'RB',offset:[28,80]}));}).catch(()=>{});
   placesReady=(async()=>{
    try{
     const positions=places.length?await convert(places.map(p=>[p.lng,p.lat])):[];
     if(epoch!==initEpoch||!ready)return;
     places.forEach((place,index)=>{
      const content=document.createElement('div');content.className='place-wrap direction-right';
      const dot=document.createElement('span');dot.className='place-dot';dot.textContent='·';
      const name=document.createElement('span');name.className='place-name';name.textContent=place.name;
      if(place.rating){const rating=document.createElement('span');rating.className='place-rating';rating.textContent=place.rating+'A';name.append(rating);}content.append(dot,name);
      const position=positions[index],marker=new window.AMap.Marker({position,content,anchor:'center',title:place.officialName||place.name,zIndex:150});
      marker.on('click',()=>{state.manual=true;select(place.lat,place.lng,place.name,14).catch(()=>showMapStatus('地点暂不可用'));window.WanderActivities?.openNearby(place);});scenes.push({place,position,marker,content,visible:false});
     });
     updatePlaces();
    }catch{if(epoch===initEpoch&&ready)report('attractions','unavailable','warning');}
   })();
   callback?.({lat:XI_AN_GCJ[1],lng:XI_AN_GCJ[0],name:'西安市',coordinateSystem:'GCJ02',wgs84:{lat:34.27,lng:108.95}});
   report('ready',renderer,'info');return true;
  }catch(error){
   if(epoch!==initEpoch)return false;
   report(error.stage||'initialization',error.code||'failed');dispose();return false;
  }
 }
 async function search(query){
  const epoch=++searchEpoch;let place;
  try{await plugin('PlaceSearch');const result=await call(callback=>new window.AMap.PlaceSearch({city:'西安',citylimit:false,pageSize:1}).search(query,callback));place=result.poiList?.pois?.[0];}catch{}
  if(epoch!==searchEpoch)return;
  if(!place?.location){await plugin('Geocoder');const result=await call(callback=>new window.AMap.Geocoder({city:'西安'}).getLocation(query,callback));place=result.geocodes?.[0];}
  if(epoch!==searchEpoch)return;if(!place?.location)throw new Error('没有找到这个地点');
  const [lng,lat]=point(place.location);await select(lat,lng,place.name||place.formattedAddress||query,14,{system:'GCJ02'});
 }

 async function weather(lat,lng){
  const a=await address(lng,lat),adcode=a.addressComponent?.adcode;
  if(typeof adcode!=='string'||!adcode)throw new Error('天气地区暂不可用');
  await plugin('Weather');const live=await call(callback=>new window.AMap.Weather().getLive(adcode,callback),{errorFirst:true});
  if(live?.temperature==null||String(live.temperature).trim()===''||!Number.isFinite(Number(live.temperature)))throw new Error('天气温度暂不可用');
  return live;
 }
 async function setActivities(groups,open){
  const epoch=++activitiesEpoch,prepared=[];if(!ready)return;
  try{
   for(const system of [...new Set(groups.map(g=>g.coordinateSystem))]){
    const subset=groups.filter(g=>g.coordinateSystem===system),positions=await convert(subset.map(g=>[g.lng,g.lat]),system);
    subset.forEach((group,index)=>prepared.push({group,position:positions[index]}));
   }
   if(epoch!==activitiesEpoch||!ready)return;
   // Viewport responses commonly contain the same points. Retain their DOM and
   // SDK markers so the response does not replay the bubbles' entrance animation.
   const previous=new Map(activityMarkers.map(item=>[item.group.id,item]));
   activityMarkers=prepared.map(({group,position})=>{
    let item=previous.get(group.id);previous.delete(group.id);
    if(item){
     window.WanderActivities.updatePin?.(item.content,group);
     if(key(item.position)!==key(position))item.marker.setPosition(position);
     item.group=group;item.position=position;item.open=open;
    }else{
     const content=window.WanderActivities.pin(group),marker=new window.AMap.Marker({position,content,anchor:'top-left',title:group.events[0]?.title||group.name,zIndex:450});
     item={marker,group,content,position,open,visible:false};content.addEventListener('click',()=>item.open(item.group));
    }
    return item;
   });previous.forEach(item=>visibility(item,false));updatePlaces();
  }catch{ /* A feed failure must not tear down the basemap. */ }
 }
 function updateActivityBubbles({width,height,occupied}){
  if(!window.WanderActivities?.layoutBubbles)return;
  const items=activityMarkers.map(item=>{const p=native.lngLatToContainer(item.position);return {id:item.group.id,x:p.getX?.()??p.x,y:p.getY?.()??p.y};});
  const fits=window.WanderActivities.layoutBubbles(items,{width,height,occupied,zoom:native.getZoom?.()||11});
  activityMarkers.forEach(item=>{
   const fit=fits.get(item.group.id),show=!window.WanderItineraryFocus?.active&&Boolean(fit);
   if(fit){
    const layout=[fit.dx,fit.dy,fit.tailX,fit.tailY,fit.below].join(',');
    if(item.layout!==layout){item.content.style.setProperty('--bubble-tail-x',fit.tailX+'px');item.content.style.setProperty('--bubble-tail-y',fit.tailY+'px');item.content.classList.toggle('bubble-below',fit.below);item.marker.setOffset(new window.AMap.Pixel(fit.dx,fit.dy));item.layout=layout;}
   }
   visibility(item,show);
  });
 }
 function getViewport(){
  if(!ready)return null;const bounds=native.getBounds?.();if(!bounds)return null;
  const sw=point(bounds.getSouthWest()),ne=point(bounds.getNorthEast());
  if(!valid(sw[1],sw[0])||!valid(ne[1],ne[0]))return null;
  return {bbox:[sw[0],sw[1],ne[0],ne[1]],coordinateSystem:'GCJ-02'};
 }
 async function drawPlans(model,{fit=true,onSelect:choose}={}){
  clearRoutes();const epoch=routeEpoch,byId=new Map(model.events.map(e=>[e.event_id,e])),visuals=window.WanderRouteVisuals;
  const points=[],items=[];
  model.plans.forEach((plan,index)=>plan.itinerary.stops.forEach((stop,i)=>{
   const event=byId.get(stop.event_id);if(!event||!valid(event.latitude,event.longitude))return;
   const pointIndex=points.push([event.longitude,event.latitude])-1;items.push({type:'dot',pointIndex,plan,index,i,event});
   const next=plan.itinerary.stops[i+1],nextEvent=byId.get(next?.event_id),leg=(plan.legs||[]).find(l=>l.from_event_id===stop.event_id&&l.to_event_id===next?.event_id),geometry=window.WanderPlans.geometry(leg);
   if(geometry){
    const path=visuals.orient(geometry.map(p=>[p[1],p[0]]),[event.longitude,event.latitude],nextEvent?[nextEvent.longitude,nextEvent.latitude]:null),start=points.length;
    points.push(...path);items.push({type:'line',start,length:path.length,plan,index});
   }
  }));
  if(!points.length)return;
  try{
   const [translated,palette]=await Promise.all([convert(points,model.coordinate_system||'WGS84'),visuals.palette(model)]);if(epoch!==routeEpoch)return;
   items.sort((a,b)=>Number(a.plan.plan_id===model.active_plan)-Number(b.plan.plan_id===model.active_plan));
   const activeLayers=[],segments=[];routes=[];
   items.forEach(item=>{
    const selected=item.plan.plan_id===model.active_plan,color=palette.get(item.plan.plan_id).color;
    if(item.type==='line'){
     const path=translated.slice(item.start,item.start+item.length),style=visuals.stroke(native.getZoom?.()||11,selected);
     const options={path:path.map(p=>[...p]),strokeColor:color,strokeWeight:style.width,strokeOpacity:selected ? .28 : .7,isOutline:true,outlineColor:'#ffffff',borderWeight:style.border,lineJoin:'round',lineCap:'round',zIndex:selected?120:100,extData:{planId:item.plan.plan_id,role:'track'}};
     const track=new window.AMap.Polyline(options),layers=[track];track.on('click',()=>choose?.(item.plan.plan_id));routes.push(track);if(selected)activeLayers.push(track);
     if(selected){const flow=new window.AMap.Polyline({...options,path:path.map(p=>[...p]),strokeOpacity:1,zIndex:125,extData:{planId:item.plan.plan_id,role:'flow'}});flow.on('click',()=>choose?.(item.plan.plan_id));routes.push(flow);layers.push(flow);segments.push({path,show:part=>flow.setPath(part.map(p=>[...p]))});}
     routeStrokes.push({layers,selected,width:style.width});
    }else{
     const content=document.createElement('div');content.className='native-route-dot';content.style.background=color;content.style.opacity=selected?'1':'.72';content.title='方案 '+item.plan.label+' · '+(item.i+1)+'. '+item.event.title;content.textContent=String(item.i+1);
     if(selected&&window.WanderItineraryFocus?.active){const label=document.createElement('span');label.className='route-stop-name';label.textContent=String(item.event.title||item.event.venue_name||item.event.event_id);content.append(label);}
     const marker=new window.AMap.Marker({position:translated[item.pointIndex],content,anchor:'center',zIndex:selected?300:200});
     marker.on('click',()=>{choose?.(item.plan.plan_id);window.WanderActivities?.openEvents([item.event],{placeName:item.event.venue_name,coordinateSystem:model.coordinate_system});});routes.push(marker);if(selected)activeLayers.push(marker);
    }
   });native.add(routes);fitLayers=activeLayers;
   if(fit&&activeLayers.length)fitRoutes();
   window.WanderItineraryMap?.routesReady?.();
   if(!window.WanderItineraryFocus?.active)stopRouteAnimation=visuals.animate(segments);
  }catch{if(epoch===routeEpoch)showMapStatus('路线暂不可用');}
 }
 function resize(){if(!ready)return;native.resize?.();}
 function fitRoutes({immediate=false}={}){
  if(!ready||!fitLayers.length)return;
  const card=document.querySelector('.glass-card').getBoundingClientRect(),size=native.getSize();
  const frame=window.WanderMapLayout.routeFrame({width:size.getWidth?.()??size.width,height:size.getHeight?.()??size.height,card,panels:window.WanderMapLayout.visiblePanels()});
  native.setFitView(fitLayers,immediate,frame.amap,15);
 }
 function backendLocation(location){
  if(config?.backendCoordinateSystem!=='WGS84')return location?.coordinateSystem==='GCJ02'?{lat:location.lat,lng:location.lng}:null;
  if(location?.coordinateSystem==='GCJ02')return location.wgs84||null;
  return location;
 }

 let fallbackAssets,stylesAdded=false;
 function loadFallback(){
  if(fallbackAssets)return fallbackAssets;
  fallbackAssets=(async()=>{
   if(!stylesAdded){stylesAdded=true;for(const href of ['assets/leaflet.css','assets/maplibre-gl.css']){const link=document.createElement('link');link.rel='stylesheet';link.href=href;document.head.append(link);}}
   for(const [loaded,src] of [[()=>window.L,'assets/leaflet.js'],[()=>window.maplibregl,'assets/maplibre-gl.js'],[()=>window.L?.maplibreGL,'assets/leaflet-maplibre-gl.js']]){
    if(loaded())continue;
    try{await timeout(new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=reject;document.head.append(script);}),15000,'fallback','asset-timeout');}
    catch(error){if(!window.L)throw error;break;}
   }
  })();fallbackAssets.catch(()=>{fallbackAssets=null;});return fallbackAssets;
 }
 function cancelPending(){selectionEpoch++;searchEpoch++;}
 function dispose(){initEpoch++;configRequest?.abort();configRequest=null;ready=false;activitiesEpoch++;activityMarkers=[];cancelPending();clearRoutes();clearCandidateMarks();candidateAnchorListener=null;try{native?.destroy();}catch{}native=null;clearAttribution();scenes=[];selectedMarker=null;selectedPosition=null;selectedName='';}
 window.WanderAMap={init,dispose,cancelPending,loadFallback,convert,select,search,weather,updatePlaces,setActivities,getViewport,drawPlans,clearRoutes,resize,fitRoutes,backendLocation,
 // Narrow candidate renderer for WanderCandidates only — not general map access.
 candidates:{render:renderCandidates,clear:clearCandidateMarks,refresh(){updateCandidateLayer();},point:candidatePoint,get ready(){return ready;}},
 async restoreView(center,zoom){const epoch=initEpoch,selection=selectionEpoch,[p]=await convert([[center.lng,center.lat]],'WGS84');if(epoch===initEpoch&&selection===selectionEpoch&&ready)native.setZoomAndCenter(zoom,p);},
 get diagnostics(){return {attempt,renderer,lastFailure:lastFailure?{...lastFailure}:null,events:diagnostics.map(e=>({...e}))};},get placesReady(){return placesReady;},get ready(){return ready;}};
})();

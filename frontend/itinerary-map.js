'use strict';
// Coordinates the one live SDK canvas with the UI's changing map shell.
// The UI owns phase timing; resize and camera updates never create another map.
// Shell motion is composited; the SDK sees stable destination geometry.
(() => {
 let fullModel=null,choose,internalDraw=false,raf=0,lastSize='',lastFit='',revision=0;
 let glAt=0,fitAt=0,markersAt=0,markersFocus=null;
 const GL_MS=112,FIT_MS=96,MARKERS_MS=160;
 let phase=window.WanderItineraryFocus?.phase||'explore',exploreCard=null;
 const focused=()=>Boolean(window.WanderItineraryFocus?.active);
 const dom={};
 function refs(){
  // Shell nodes live for the page's lifetime; caching them keeps per-frame
  // geometry checks free of repeated document queries.
  dom.map??=document.getElementById?.('map');
  dom.canvas??=document.querySelector('.canvas');
  dom.frame??=document.getElementById?.('itinerary-map-frame');
  return dom;
 }
 function geometryPending(){
  const {map:element,canvas,frame}=refs();
  if(!element?.clientWidth||!element.clientHeight||!canvas?.clientWidth||!canvas.clientHeight||!frame?.clientWidth||!frame.clientHeight)return false;
  const target=focused()?frame:canvas;
  return Math.abs(element.clientWidth-target.clientWidth)>1||Math.abs(element.clientHeight-target.clientHeight)>1;
 }
 const transitioning=()=>phase==='entering'||phase==='leaving'||geometryPending();
 const valid=(lat,lng)=>Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180;
 function focusProgress(){
  const {map:element,canvas,frame}=refs();
  if(!element||!canvas||!frame)return focused()?1:0;
  const full=canvas.clientWidth,target=frame.clientWidth;
  return full>target?Math.max(0,Math.min(1,(full-element.clientWidth)/(full-target))):focused()?1:0;
 }
 function prepareDraw(model,{onSelect}={}){
  if(!internalDraw){fullModel=model;choose=onSelect;revision++;lastFit='';}
  if(focused())schedule();
  return focused()?{...model,plans:model.plans.filter(plan=>plan.plan_id===model.active_plan)}:model;
 }
 function allowFit(value){return Boolean(value)&&!transitioning()&&!focused();}
 function leafletBounds(){
  if(!fullModel||!['WGS84','WGS-84'].includes(String(fullModel.coordinate_system||'WGS84').toUpperCase()))return [];
  const plan=fullModel.plans.find(p=>p.plan_id===fullModel.active_plan),events=new Map(fullModel.events.map(e=>[e.event_id,e])),points=[];
  for(const stop of plan?.itinerary.stops||[]){const e=events.get(stop.event_id);if(e&&valid(e.latitude,e.longitude))points.push([e.latitude,e.longitude]);}
  for(const leg of plan?.legs||[])points.push(...(window.WanderPlans?.geometry(leg)||[]));
  return points;
 }
 // A throttled sync serves transition animation frames; every other call is a
 // complete sync with the semantics callers (and the settle frame) rely on.
 function sync({force=false,throttled=false}={}){
  const element=refs().map;if(!element)return;
  const width=element.clientWidth,height=element.clientHeight;if(!width||!height)return;
  const size=width+','+height,changed=size!==lastSize;lastSize=size;
  // A transform animation changes no layout size. Do not re-enter SDK work
  // on its animation frames; complete syncs still handle panels and redraws.
  if(throttled&&!changed&&!force)return;
  const now=Date.now();
  if(window.WanderAMap?.ready){
   if(changed||force)window.WanderAMap.resize();
  }else if(typeof map!=='undefined'&&map){
   if(changed||force)map.stop?.();
   if(changed||force||!throttled){
    map.invalidateSize({animate:false,pan:false,debounceMoveend:true});
    // MapLibre rebuilds its WebGL framebuffer on resize, so while the shell
    // moves the canvas follows on a coarse cadence; the feathered edge hides
    // the briefly stale size and a complete sync restores it exactly.
    if(!throttled||now-glAt>=GL_MS){glAt=now;tiles?.getMaplibreMap?.()?.resize();}
   }
  }else return;
  // Focused markers are all hidden: refresh once per focus flip, while visible
  // explore markers refresh on a coarse cadence through the leaving motion.
  if(typeof updatePlaceMarkers==='function'&&(!throttled||markersFocus!==focused()||(!focused()&&now-markersAt>=MARKERS_MS))){markersAt=now;markersFocus=focused();updatePlaceMarkers();}
  if(!fullModel)return;
  // Each fit re-projects every waypoint, so transition frames attempt it on a
  // coarse cadence only; lastFit still records executed fits so the settle
  // sync always lands any skipped final signature.
  if(throttled&&now-fitAt<FIT_MS)return;
  fitAt=now;
  const card=document.querySelector('.glass-card').getBoundingClientRect();
  const frame=window.WanderMapLayout.routeFrame({width,height,card,panels:window.WanderMapLayout.visiblePanels()});
  const signature=[revision,size,focused(),...frame.amap].join(':');
  if(!force&&signature===lastFit)return;lastFit=signature;
  if(window.WanderAMap?.ready)window.WanderAMap.fitRoutes({immediate:true});
  else{
   const points=leafletBounds();if(!points.length)return;
   // Fractional zoom keeps the focus map's route frame moving continuously.
   // Leaflet's integer snapping would otherwise produce visible size steps.
   map.options.zoomSnap=0;
   map.fitBounds(L.latLngBounds(points),{paddingTopLeft:frame.paddingTopLeft,paddingBottomRight:frame.paddingBottomRight,maxZoom:15,animate:false});
  }
 }
 function schedule(){if(!raf)raf=requestAnimationFrame(tick);}
 function tick(){
  raf=0;
  // Moving frames stay cheap; the first frame that finds settled geometry
  // runs one complete sync so the final canvas and camera are exact.
  if(transitioning()){sync({throttled:true});schedule();}
  else sync();
 }
 function redraw(){
  if(!fullModel||!window.WanderPlans)return;
  internalDraw=true;
  try{
   const pending=window.WanderPlans.draw(fullModel,{fit:false,onSelect:choose});
   Promise.resolve(pending).then(()=>{lastFit='';schedule();}).catch(()=>{});
  }finally{internalDraw=false;}
 }
 function onFocus(event){
  const focus=event.detail;if(!focus)return;
  if(focus.phase==='entering'&&phase==='explore')exploreCard=document.querySelector('.glass-card').getBoundingClientRect();
  phase=focus.phase;
  // A reset listener may run before the UI closes its previous detail. The
  // resulting leaving event must not resurrect the model we just cleared.
  if(focus.model&&(focus.active||fullModel)){if(JSON.stringify(fullModel)!==JSON.stringify(focus.model))revision++;fullModel=focus.model;}
  if(transitioning())window.WanderAMap?.cancelPending?.();
  // Stops async palette results and route reveals before another phase wins.
  if(typeof map!=='undefined'&&map){map.stop?.();if(locationMarker){if(focus.active)map.removeLayer(locationMarker);else if(!map.hasLayer(locationMarker))locationMarker.addTo(map);}}
  if(phase==='entering'||phase==='leaving'||phase==='detail'){
   // The stable detail event follows entering without redrawing the same route.
   const key=[focus.active,fullModel?.active_plan,JSON.stringify(fullModel)].join(':');
   if(key!==onFocus.lastModel){
    window.WanderPlans?.cancelDraw?.();
    if(typeof map!=='undefined'&&map&&routeLayer){map.removeLayer(routeLayer);routeLayer=null;}
    onFocus.lastModel=key;redraw();
   }
  }
  schedule();
 }
 window.addEventListener('wander:itinerary-focus',onFocus);
 window.addEventListener('wander:map-ready',()=>{lastSize='';lastFit='';glAt=0;fitAt=0;markersFocus=null;if(focused()||transitioning())redraw();schedule();});
 window.addEventListener('wander:reset',()=>{window.WanderPlans?.cancelDraw?.();window.WanderAMap?.clearRoutes?.();fullModel=null;choose=null;revision++;lastFit='';onFocus.lastModel=null;});
 window.addEventListener('resize',schedule);
 if(typeof ResizeObserver!=='undefined'){
  const element=refs().map;if(element)new ResizeObserver(schedule).observe(element);
 }
 window.WanderItineraryMap={prepareDraw,allowFit,routesReady(){if(focused()||transitioning()){lastFit='';fitAt=0;schedule();}},get transitioning(){return transitioning();},get focusProgress(){return focusProgress();},get exploreCard(){return exploreCard;},sync};
})();

'use strict';
// Presentational adapter for legacy itineraries and the Day 0 single/comparison samples.
(() => {
 let currentView=null,viewCount=0,detailEpoch=0,detailTimer=null,cancelDetailSettle=null,mapMotion=null;
 let routeRun=0,stopRouteAnimation,stopRouteZoom;
 function stopRouteEffects(){routeRun++;stopRouteAnimation?.();stopRouteAnimation=null;stopRouteZoom?.();stopRouteZoom=null;}
 const text=(tag,className,value)=>{const node=document.createElement(tag);node.className=className;node.textContent=String(value??'');return node;};
 function safeURL(value){try{const u=new URL(String(value));return ['http:','https:'].includes(u.protocol)?u.href:null;}catch{return null;}}
 function money(value){return (value/100).toLocaleString('zh-CN',{maximumFractionDigits:2});}
 function price(event){
  const valid=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  const min=valid(event.budget_min)?event.budget_min:null,max=valid(event.budget_max)?event.budget_max:null;
  const prefix=event.currency&&event.currency!=='CNY'?String(event.currency)+' ':'¥';
  if(min===0&&max===0)return '免费';
  if(min!==null&&max!==null)return min===max?prefix+money(min):prefix+money(min)+'–'+money(max);
  if(min!==null)return prefix+money(min)+' 起';
  if(max!==null)return '最高 '+prefix+money(max);
  return '票价待确认';
 }
 const time=value=>String(value||'').match(/\d{1,2}:\d{2}/)?.[0]||'';
 const range=stop=>[time(stop.arrive_at),time(stop.leave_at)].filter(Boolean).join(' – ');
 function normalize(data){
  if(!data||typeof data!=='object')return null;
  if(Array.isArray(data.plans)){
   const plans=data.plans.filter(p=>p&&typeof p.plan_id==='string'&&p.itinerary&&Array.isArray(p.itinerary.stops)).slice(0,2).map(p=>({...p,itinerary:{...p.itinerary,stops:p.itinerary.stops.filter(s=>s&&typeof s.event_id==='string')}}));
   if(!plans.length)return null;
   return {...data,plans,events:Array.isArray(data.events)?data.events.filter(e=>e&&typeof e==='object'):[],active_plan:plans.some(p=>p.plan_id===data.active_plan)?data.active_plan:plans[0].plan_id};
  }
  if(data.itinerary&&Array.isArray(data.itinerary.stops))return {kind:'itinerary',coordinate_system:'WGS84',events:Array.isArray(data.events)?data.events.filter(e=>e&&typeof e==='object'):[],active_plan:'legacy',plans:[{plan_id:'legacy',label:'A',itinerary:data.itinerary,legs:[]}]};
  return null;
 }
 function active(data){const model=normalize(data);return model?.plans.find(p=>p.plan_id===model.active_plan)||null;}
 function summary(data){
  const model=normalize(data);if(!model)return '';
  const plan=active(model),byId=new Map(model.events.map(e=>[e.event_id,e]));
  return [plan.itinerary.summary||plan.title||'游玩规划',...plan.itinerary.stops.map(s=>[range(s),byId.get(s.event_id)?.title||s.event_id].filter(Boolean).join(' '))].filter(Boolean).join('\n');
 }
 function legFor(plan,from,to){return (Array.isArray(plan.legs)?plan.legs:[]).find(l=>l&&l.from_event_id===from&&l.to_event_id===to);}
 function geometry(leg){
  const points=leg?.geometry?.coordinates;
  if(leg?.status!=='ok'||leg?.geometry?.type!=='LineString'||!Array.isArray(points)||points.length<2)return null;
  if(!points.every(p=>Array.isArray(p)&&p.length>=2&&typeof p[0]==='number'&&typeof p[1]==='number'&&Number.isFinite(p[0])&&Number.isFinite(p[1])&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90))return null;
  return points.map(p=>[p[1],p[0]]);
 }
 function commute(leg){
  if(!leg||leg.status!=='ok')return '通勤待确认 · 暂无道路轨迹';
  const modes={walking:'步行',transit:'公交',driving:'驾车',cycling:'骑行'};
  const parts=[modes[leg.mode]||'通勤'];
  parts.push(typeof leg.duration_seconds==='number'&&Number.isFinite(leg.duration_seconds)&&leg.duration_seconds>=0?Math.max(1,Math.ceil(leg.duration_seconds/60))+' 分钟':'耗时待确认');
  if(typeof leg.distance_meters==='number'&&Number.isFinite(leg.distance_meters)&&leg.distance_meters>=0)parts.push(leg.distance_meters>=1000?(leg.distance_meters/1000).toFixed(1)+' 公里':Math.round(leg.distance_meters)+' 米');
  if(typeof leg.buffer_seconds==='number'&&leg.buffer_seconds>0)parts.push('另预留 '+Math.ceil(leg.buffer_seconds/60)+' 分钟');
  if(!geometry(leg))parts.push('道路轨迹缺失');
  return parts.join(' · ');
 }
 function isExample(model){return model.plans.some(p=>(p.legs||[]).some(l=>l.provider==='mock'))||model.events.some(e=>/^mock_/i.test(String(e.event_id)));}
 function eventCover(event){
  const wrap=document.createElement('div');wrap.className='event-cover';
  const placeholder=text('span','cover-fallback',event.category||'活动');wrap.append(placeholder);
  let images=event.image_urls;if(typeof images==='string'){try{images=JSON.parse(images);}catch{images=[];}}
  const imageURL=value=>typeof value==='string'&&/^(\/(?!\/)|\.\/)/.test(value)?value:safeURL(value);
  const url=[event.thumbnail_url,...(Array.isArray(images)?images:[])].map(imageURL).find(Boolean);
  if(url){const image=document.createElement('img');image.src=url;image.alt=String(event.title||'活动封面');image.loading='lazy';image.decoding='async';image.referrerPolicy='no-referrer';image.addEventListener('error',()=>{image.remove();placeholder.textContent='图片暂缺';},{once:true});wrap.append(image);}
  return wrap;
 }
 function eventCard(stop,event,index){
  const item=document.createElement('li');item.className='event-card';
  const schedule=text('div','event-schedule',String(index+1).padStart(2,'0')+'  '+range(stop));item.append(schedule,eventCover(event));
  const body=document.createElement('div');body.className='event-details';
  body.append(text('h3','event-title',event.title||stop.event_id||'待补充活动'),text('p','event-venue',event.venue_name||'场馆待确认'),text('p','event-price',price(event)));
  const url=safeURL(event.guide_url);
  if(url){const link=text('a','event-source','原站详情 ↗');link.href=url;link.target='_blank';link.rel='noopener noreferrer';body.append(link);}
  else body.append(text('span','event-source unavailable','暂无原站链接'));
  item.append(body);
  if(stop.reason)item.append(text('p','event-reason',stop.reason));
  if(event.budget_note)item.append(text('p','event-budget-note',event.budget_note));
  return item;
 }
 function compatibleCoordinates(model){if(window.WanderAMap?.ready)return ['WGS84','WGS-84','GCJ02','GCJ-02'].includes(String(model.coordinate_system||'WGS84').toUpperCase());return ['WGS84','WGS-84'].includes(String(model.coordinate_system||'WGS84').toUpperCase());}
 function draw(data,{fit=true,onSelect}={}){
  let model=normalize(data);if(!model)return;stopRouteEffects();
  model=window.WanderItineraryMap?.prepareDraw(model,{fit,onSelect})||model;
  fit=window.WanderItineraryMap?.allowFit(fit)??fit;
  if(window.WanderAMap?.ready){return window.WanderAMap.drawPlans(model,{fit,onSelect});}if(!map)return;
  const epoch=routeRun,visuals=window.WanderRouteVisuals;
  function render(palette){
   if(epoch!==routeRun)return;
   if(routeLayer){routeLayer.off?.('remove',stopRouteEffects);map.removeLayer(routeLayer);routeLayer=null;}
   if(!compatibleCoordinates(model))return;
   const byId=new Map(model.events.map(e=>[e.event_id,e])),layers=[],bounds=[],strokes=[],segments=[];
   // Keep complete, faint tracks underneath the ordered reveal, and fit those
   // full tracks rather than the moving animation endpoint.
   [...model.plans].sort((a,b)=>Number(a.plan_id===model.active_plan)-Number(b.plan_id===model.active_plan)).forEach(plan=>{
    const selected=plan.plan_id===model.active_plan,index=model.plans.indexOf(plan),color=palette.get(plan.plan_id).color,stops=plan.itinerary.stops;
    stops.forEach((stop,i)=>{
     const event=byId.get(stop.event_id);if(!event)return;
     const lat=event.latitude,lng=event.longitude;
     if(typeof lat!=='number'||typeof lng!=='number'||!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)return;
     const point=[lat,lng];if(selected)bounds.push(point);
     const number=text('span','route-stop',String(i+1));
     if(selected&&window.WanderItineraryFocus?.active)number.append(text('span','route-stop-name',event.title||event.venue_name||stop.event_id));
     number.title='方案 '+(plan.label||index+1)+' · '+(i+1)+'. '+event.title;
     const dot=L.circleMarker(point,{radius:selected?10:8,color:'#ffffff',weight:2,opacity:1,fillColor:color,fillOpacity:selected?1:.72}).bindTooltip(number,{permanent:true,direction:'center',className:'route-station-number',opacity:1});
     dot.on('click',()=>{onSelect?.(plan.plan_id);window.WanderActivities?.openEvents([event],{placeName:event.venue_name,coordinateSystem:model.coordinate_system});});layers.push(dot);
     if(i===stops.length-1)return;
     const leg=legFor(plan,stop.event_id,stops[i+1].event_id),geometry=window.WanderPlans.geometry(leg),next=byId.get(stops[i+1].event_id);
     if(!geometry)return;
     const path=visuals.orient(geometry.map(p=>[p[1],p[0]]),[lng,lat],next?[next.longitude,next.latitude]:null),points=path.map(p=>[p[1],p[0]]),style=visuals.stroke(map.getZoom?.()||11,selected);
     if(selected)bounds.push(...points);
     const casing=L.polyline(points,{color:'#ffffff',weight:style.width+style.border*2,opacity:.95,interactive:false,className:'route-casing'}),track=L.polyline(points,{color,weight:style.width,opacity:selected ? .28 : .7,className:'route-track'}).bindTooltip(locationLabel((leg.provider==='mock'?'示例轨迹 · ':'')+'方案 '+(plan.label||index+1)+' · '+commute(leg)));
     if(onSelect)track.on('click',()=>onSelect(plan.plan_id));layers.push(casing,track);const colored=[track];
     if(selected){const flow=L.polyline(points,{color,weight:style.width,opacity:1,interactive:false,className:'route-flow'});layers.push(flow);colored.push(flow);segments.push({path,show:part=>flow.setLatLngs(part.map(p=>[p[1],p[0]]))});}
     strokes.push({selected,casing,colored,width:style.width});
    });
   });
   if(!layers.length)return;routeLayer=L.layerGroup(layers).addTo(map);routeLayer.on?.('remove',stopRouteEffects);
   const widths=()=>strokes.forEach(item=>{const style=visuals.stroke(map.getZoom?.()||11,item.selected);if(style.width===item.width)return;item.width=style.width;item.casing.setStyle({weight:style.width+style.border*2});item.colored.forEach(line=>line.setStyle({weight:style.width}));});
   map.on?.('zoom',widths);stopRouteZoom=()=>map.off?.('zoom',widths);
   if(fit&&bounds.length){const card=document.querySelector('.glass-card').getBoundingClientRect(),size=map.getSize();const frame=window.WanderMapLayout.routeFrame({width:size.x,height:size.y,card,panels:window.WanderMapLayout.visiblePanels()});map.fitBounds(L.latLngBounds(bounds),{paddingTopLeft:frame.paddingTopLeft,paddingBottomRight:frame.paddingBottomRight,maxZoom:15,animate:true});}
   if(!window.WanderItineraryFocus?.active)stopRouteAnimation=visuals.animate(segments);
   window.WanderItineraryMap?.routesReady?.();
  }
  const palette=visuals.palette(model);if(palette?.then)return palette.then(render);render(palette);
 }
 const reduceMotion=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
 // One shared state, published before each layout change, lets map adapters fit
 // the same viewport without owning the UI or re-creating the SDK instance.
 let focusState={active:false,phase:'explore',model:null};
 window.WanderItineraryFocus=focusState;
 function publishFocus(active,phase,model){
  focusState={active,phase,model};window.WanderItineraryFocus=focusState;
  if(typeof CustomEvent==='function')window.dispatchEvent(new CustomEvent('wander:itinerary-focus',{detail:focusState}));
 }
 function setCardUnavailable(value){
  const card=document.querySelector('.glass-card');if(!card)return;
  card.inert=value;card.setAttribute('aria-hidden',String(value));
 }
 // FLIP the shell as a compositor layer. Its SDK canvas has its final layout
 // size throughout the motion, so WebGL buffers and the camera update once.
 function moveMap(change,{immediate=false}={}){
  const shell=document.getElementById?.('map-shell'),before=shell?.getBoundingClientRect?.();
  mapMotion?.cancel();mapMotion=null;
  change();
  if(immediate||reduceMotion()||!before||!shell.animate)return;
  const after=shell.getBoundingClientRect();
  if(!after.width||!after.height)return;
  const style=getComputedStyle(shell),duration=parseFloat(style.getPropertyValue('--itinerary-duration'))||820;
  mapMotion=shell.animate([
   {transform:`translate(${before.left-after.left}px,${before.top-after.top}px) scale(${before.width/after.width},${before.height/after.height})`},
   {transform:'none'}
  ],{duration,easing:'cubic-bezier(.22,.75,.22,1)'});
 }
 function settleFocus(epoch,callback,immediate=false){
  cancelDetailSettle?.();clearTimeout(detailTimer);
  if(immediate||reduceMotion()){callback();return;}
  const shell=document.getElementById?.('map-shell');
  let finished=false;
  const cleanup=()=>{clearTimeout(detailTimer);shell?.removeEventListener?.('transitionend',onEnd);if(cancelDetailSettle===cleanup)cancelDetailSettle=null;};
  const atTarget=()=>{
   const target=focusState.active?document.getElementById?.('itinerary-map-frame'):document.querySelector('.canvas');
   if(!shell?.getBoundingClientRect||!target?.getBoundingClientRect)return true;
   const actual=shell.getBoundingClientRect(),expected=target.getBoundingClientRect();
   return ['left','top','width','height'].every(key=>Math.abs(actual[key]-expected[key])<.75);
  };
  const check=()=>{
   if(finished||epoch!==detailEpoch){cleanup();return;}
   // A timer is only a fallback probe, never evidence that the CSS transition
   // finished. Slow rendering, resize and reversed transitions must all converge.
   if(!atTarget()){clearTimeout(detailTimer);detailTimer=setTimeout(check,100);return;}
   finished=true;cleanup();callback();
  };
  const onEnd=event=>{if(event.target===shell&&['width','height','left','top','border-radius'].includes(event.propertyName))check();};
  cancelDetailSettle=cleanup;
  shell?.addEventListener?.('transitionend',onEnd);
  mapMotion?.finished.then(check,()=>{});
  detailTimer=setTimeout(check,1200);
 }
 function openDetail(overlay,preview){
  if(focusState.active&&focusState.phase!=='leaving')return;
  const epoch=++detailEpoch;cancelDetailSettle?.();clearTimeout(detailTimer);
  overlay.hidden=false;overlay.inert=false;overlay.setAttribute('aria-hidden','false');
  preview.setAttribute('aria-expanded','true');
  // Establish the detail's initial style before toggling its target layout.
  // The shell is composited while the SDK renders at its destination size.
  void overlay.offsetHeight;
  document.body?.classList.add('itinerary-transition');
  moveMap(()=>document.body?.classList.add('itinerary-focus'));
  document.querySelector('.glass-card')?.classList.add('viewing-plan');
  publishFocus(true,'entering',currentView?.model||null);
  overlay.querySelector('.plan-back')?.focus({preventScroll:true});
  setCardUnavailable(true);
  settleFocus(epoch,()=>{
   document.body?.classList.remove('itinerary-transition');
   publishFocus(true,'detail',currentView?.model||null);
  });
 }
 function closeDetail(options){
  const overlay=$('plan-detail');if(!overlay)return;
  const wasActive=focusState.active||focusState.phase==='leaving';
  if(!wasActive&&overlay.hidden)return;
  const epoch=++detailEpoch;cancelDetailSettle?.();clearTimeout(detailTimer);
  const preview=currentView?.preview,restoreFocus=options?.focus!==false;
  preview?.setAttribute('aria-expanded','false');setCardUnavailable(false);
  if(restoreFocus&&preview&&!preview.disabled)preview.focus({preventScroll:true});
  overlay.inert=true;overlay.setAttribute('aria-hidden','true');
  document.body?.classList.add('itinerary-transition');
  moveMap(()=>document.body?.classList.remove('itinerary-focus'),{immediate:options?.animate===false});
  document.querySelector('.glass-card')?.classList.remove('viewing-plan');
  publishFocus(false,'leaving',currentView?.model||null);
  settleFocus(epoch,()=>{
   overlay.hidden=true;overlay.inert=false;
   document.body?.classList.remove('itinerary-transition');
   publishFocus(false,'explore',null);
  },options?.animate===false);
 }
 function append(data,{drawMap=true}={}){
  const model=normalize(data);if(!model)throw new Error('方案内容不完整');
  closeDetail({animate:false,focus:false});if(currentView){currentView.preview.disabled=true;currentView.buttons.forEach(b=>{b.disabled=true;});}
  const {message,bubble}=makeMessage('assistant');bubble.classList.add('plan-bubble');
  bubble.append(text('p','plan-reply',model.plans.length>1?'为你整理了两种出发方式，看看哪一种更合心意。':'行程已经整理好了，点开看看这一路的安排。'));
  const preview=text('button','plan-preview','');preview.type='button';preview.setAttribute('aria-expanded','false');preview.setAttribute('aria-controls','plan-detail');
  const icon=document.createElement('span');icon.className='plan-preview-icon';icon.setAttribute('aria-hidden','true');
  icon.innerHTML='<svg viewBox="0 0 24 24"><path d="M6.7 17.8c4.8 0 4.8-11.6 10.6-11.6"/><circle cx="6.4" cy="18" r="2.3"/><circle class="accent" cx="17.6" cy="6" r="2.3"/></svg>';
  const previewMeta=text('span','plan-preview-meta',model.plans.length>1?'两种提案 · A / B':'你的专属规划');
  const previewTitle=text('strong','plan-preview-title',model.plans.length>1?'这一次，想怎样漫游？':active(model).itinerary.summary||'查看游玩规划');
  const previewFooter=text('span','plan-preview-footer','查看完整行程  ↗');
  const previewText=text('span','plan-preview-text','');previewText.append(previewMeta,previewTitle,previewFooter);preview.append(icon,previewText);bubble.append(preview);
  if(isExample(model))bubble.append(text('span','example-badge','示例行程 · 非真实活动'));
  const overlay=$('plan-detail');overlay.replaceChildren();overlay.hidden=true;
  const top=document.createElement('header');top.className='plan-detail-top';
  const back=text('button','plan-back','← 返回探索');back.type='button';back.addEventListener('click',closeDetail);top.append(back,text('span','plan-detail-eyebrow','你的漫游提案'));
  const heading=text('h2','plan-detail-title',model.plans.length>1?'选择你的出发方式':'把今天交给喜欢的事');
  const tabs=document.createElement('div');tabs.className='plan-switch';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','游玩方案');
  if(model.plans.length===1)tabs.classList.add('single');
  const panel=document.createElement('div');panel.className='plan-content';panel.id='plan-content-'+(++viewCount);panel.setAttribute('role','tabpanel');
  const scroll=document.createElement('div');scroll.className='plan-detail-scroll';scroll.append(panel);
  const messageIndex=state.messages.length;state.planMessageIndex=messageIndex;state.messages.push({role:'assistant',text:summary(model)});window.updateChatLayout?.();
  const buttons=model.plans.map((plan,index)=>{
   const button=text('button','plan-tab','方案 '+(plan.label||String.fromCharCode(65+index)));button.type='button';button.setAttribute('role','tab');button.id=panel.id+'-tab-'+index;button.setAttribute('aria-controls',panel.id);
   button.addEventListener('click',()=>choose(plan.plan_id));
   button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const next=(index+(event.key==='ArrowRight'?1:-1)+model.plans.length)%model.plans.length;choose(model.plans[next].plan_id);buttons[next].focus();});
   tabs.append(button);return button;
  });
  overlay.append(top,heading,tabs,scroll);
  function choose(id,{fit=true,capture=true,drawMap=true}={}){
   if(!model.plans.some(p=>p.plan_id===id))return;model.active_plan=id;
   const plan=active(model),byId=new Map(model.events.map(e=>[e.event_id,e]));panel.replaceChildren();
   buttons.forEach((button,i)=>{const selected=model.plans[i].plan_id===id;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;button.classList.toggle('active',selected);});
   panel.setAttribute('aria-labelledby',buttons[model.plans.findIndex(p=>p.plan_id===id)].id);
   tabs.style.setProperty('--selected-index',String(model.plans.findIndex(p=>p.plan_id===id)));
   if(isExample(model))panel.append(text('span','example-badge','示例行程 · 非真实活动'));
   if(plan.itinerary.date)panel.append(text('p','itinerary-date',plan.itinerary.date));
   panel.append(text('p','itinerary-summary',plan.itinerary.summary||plan.title||'游玩规划'));
   const list=document.createElement('ol');list.className='event-list';
   plan.itinerary.stops.forEach((stop,index)=>{list.append(eventCard(stop,byId.get(stop.event_id)||{},index));if(index<plan.itinerary.stops.length-1)list.append(text('li','commute-row',commute(legFor(plan,stop.event_id,plan.itinerary.stops[index+1].event_id))));});panel.append(list);
   const warnings=[...(Array.isArray(model.warnings)?model.warnings:[]),...(Array.isArray(plan.warnings)?plan.warnings:[])];
   if(!compatibleCoordinates(model))warnings.push('坐标系尚未匹配，暂不绘制地图路线。');
   if(!plan.legs?.length&&plan.itinerary.stops.length>1)warnings.push('尚无站间道路轨迹与通勤数据，仅展示活动位置。');
   [...new Set(warnings.filter(w=>typeof w==='string'))].forEach(w=>panel.append(text('p','plan-warning',w)));
   state.latestPlan=model;state.activePlanId=id;state.messages[messageIndex].text=summary(model);
   previewTitle.textContent=plan.title||plan.itinerary.summary||'查看游玩规划';
   previewFooter.textContent='方案 '+(plan.label||'A')+' · '+plan.itinerary.stops.length+' 个停留点  ↗';
   if(focusState.active)publishFocus(true,focusState.phase,model);
   // The focus controller owns redraws while detail is active.
   if(drawMap&&(!focusState.active||!window.WanderItineraryMap))draw(model,{fit,onSelect:next=>choose(next)});
   if(capture)window.WanderHistory?.capture();
  }
  preview.addEventListener('click',()=>{window.WanderItineraryMap?.prepareDraw(model,{onSelect:next=>choose(next)});openDetail(overlay,preview);if(!window.WanderItineraryMap)choose(model.active_plan,{fit:true,capture:false});scroll.scrollTo({top:0});back.focus({preventScroll:true});});
  // History hydration suppresses only this initial draw; explicit clicks must
  // always restore the selected route, even when its selection hasn't changed.
  currentView={buttons,preview,model};choose(model.active_plan,{fit:true,capture:false,drawMap});
  window.WanderActivities?.addPlanEvents(model);
  scrollMessages();return message;
 }
 window.addEventListener('wander:reset',()=>{stopRouteEffects();closeDetail({focus:false,animate:false});currentView=null;state.activePlanId=null;});
 window.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('plan-detail').hidden)closeDetail();});
 window.WanderPlans={normalize,active,summary,price,geometry,commute,safeURL,eventCover,draw,append,closeDetail,cancelDraw:stopRouteEffects};
})();

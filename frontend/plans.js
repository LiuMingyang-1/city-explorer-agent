'use strict';
// Presentational adapter for legacy itineraries and the Day 0 single/comparison samples.
(() => {
 let currentView=null,viewCount=0;
 const colorFor=index=>index===0?'#b67a55':'#64859a';
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
  const url=[event.thumbnail_url,...(Array.isArray(images)?images:[])].map(safeURL).find(Boolean);
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
  const model=normalize(data);if(!model)return;if(window.WanderAMap?.ready){window.WanderAMap.drawPlans(model,{fit,onSelect});return;}if(!map)return;
  if(routeLayer){map.removeLayer(routeLayer);routeLayer=null;}
  if(!compatibleCoordinates(model))return;
  const byId=new Map(model.events.map(e=>[e.event_id,e])),layers=[],bounds=[];
  // Inactive routes are drawn first so the selected route remains on top.
  [...model.plans].sort((a,b)=>Number(a.plan_id===model.active_plan)-Number(b.plan_id===model.active_plan)).forEach(plan=>{
   const selected=plan.plan_id===model.active_plan,index=model.plans.indexOf(plan),color=colorFor(plan.label==='B'?1:index),stops=plan.itinerary.stops;
   stops.forEach((stop,i)=>{
    const event=byId.get(stop.event_id);if(!event)return;
    const lat=event.latitude,lng=event.longitude;
    if(typeof lat!=='number'||typeof lng!=='number'||!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)return;
    const point=[lat,lng];bounds.push(point);
    const dot=L.circleMarker(point,{radius:selected?7:5,color,weight:2,opacity:selected?1:.45,fillColor:selected?color:'#f2f4ef',fillOpacity:selected ? .95 : .5}).bindTooltip(locationLabel('方案 '+(plan.label||index+1)+' · '+(i+1)+'. '+event.title));
    if(onSelect)dot.on('click',()=>onSelect(plan.plan_id));layers.push(dot);
    if(i===stops.length-1)return;
    const leg=legFor(plan,stop.event_id,stops[i+1].event_id),points=geometry(leg);
    if(points){bounds.push(...points);const line=L.polyline(points,{color,weight:selected?4:3,opacity:selected ? .9 : .25}).bindTooltip(locationLabel((leg.provider==='mock'?'示例轨迹 · ':'')+'方案 '+(plan.label||index+1)+' · '+commute(leg)));
     if(onSelect)line.on('click',()=>onSelect(plan.plan_id));layers.push(line);}
   });
  });
  if(!layers.length)return;routeLayer=L.layerGroup(layers).addTo(map);
  if(fit&&bounds.length){const card=document.querySelector('.glass-card').getBoundingClientRect();map.fitBounds(L.latLngBounds(bounds),{paddingTopLeft:innerWidth>700?[card.right+45,90]:[25,60],paddingBottomRight:innerWidth>700?[70,60]:[25,card.height+35],maxZoom:15,animate:true});}
 }
 function append(data,{drawMap=true}={}){
  const model=normalize(data);if(!model)throw new Error('方案内容不完整');
  if(currentView)currentView.buttons.forEach(b=>{b.disabled=true;});
  const {message,bubble}=makeMessage('assistant');bubble.classList.add('plan-bubble');
  const head=document.createElement('div');head.className='plan-header';
  const badges=document.createElement('div');badges.className='plan-badges';
  if(isExample(model))badges.append(text('span','example-badge','示例行程 · 非真实活动'));
  head.append(badges);const tabs=document.createElement('div');tabs.className='plan-switch';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','游玩方案');
  if(model.plans.length===1)tabs.classList.add('single');
  const panel=document.createElement('div');panel.className='plan-content';panel.id='plan-content-'+(++viewCount);panel.setAttribute('role','tabpanel');
  const messageIndex=state.messages.length;state.messages.push({role:'assistant',text:summary(model)});
  const buttons=model.plans.map((plan,index)=>{
   const button=text('button','plan-tab','方案 '+(plan.label||String.fromCharCode(65+index)));button.type='button';button.setAttribute('role','tab');button.id=panel.id+'-tab-'+index;button.setAttribute('aria-controls',panel.id);
   button.addEventListener('click',()=>choose(plan.plan_id));
   button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const next=(index+(event.key==='ArrowRight'?1:-1)+model.plans.length)%model.plans.length;choose(model.plans[next].plan_id);buttons[next].focus();});
   tabs.append(button);return button;
  });
  head.append(tabs);bubble.append(head,panel);
  function choose(id,{fit=false,capture=true}={}){
   if(!model.plans.some(p=>p.plan_id===id))return;model.active_plan=id;
   const plan=active(model),byId=new Map(model.events.map(e=>[e.event_id,e]));panel.replaceChildren();
   buttons.forEach((button,i)=>{const selected=model.plans[i].plan_id===id;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;button.classList.toggle('active',selected);});
   panel.setAttribute('aria-labelledby',buttons[model.plans.findIndex(p=>p.plan_id===id)].id);
   tabs.style.setProperty('--selected-index',String(model.plans.findIndex(p=>p.plan_id===id)));
   if(plan.itinerary.date)panel.append(text('p','itinerary-date',plan.itinerary.date));
   panel.append(text('p','itinerary-summary',plan.itinerary.summary||plan.title||'游玩规划'));
   const list=document.createElement('ol');list.className='event-list';
   plan.itinerary.stops.forEach((stop,index)=>{list.append(eventCard(stop,byId.get(stop.event_id)||{},index));if(index<plan.itinerary.stops.length-1)list.append(text('li','commute-row',commute(legFor(plan,stop.event_id,plan.itinerary.stops[index+1].event_id))));});panel.append(list);
   const warnings=[...(Array.isArray(model.warnings)?model.warnings:[]),...(Array.isArray(plan.warnings)?plan.warnings:[])];
   if(!compatibleCoordinates(model))warnings.push('坐标系尚未匹配，暂不绘制地图路线。');
   if(!plan.legs?.length&&plan.itinerary.stops.length>1)warnings.push('尚无站间道路轨迹与通勤数据，仅展示活动位置。');
   [...new Set(warnings.filter(w=>typeof w==='string'))].forEach(w=>panel.append(text('p','plan-warning',w)));
   state.latestPlan=model;state.activePlanId=id;state.messages[messageIndex].text=summary(model);
   if(drawMap)draw(model,{fit,onSelect:next=>choose(next)});
   if(capture)window.WanderHistory?.capture();
  }
  currentView={buttons};choose(model.active_plan,{fit:true,capture:false});
  $('messages').scrollTo({top:message.offsetTop||0,behavior:'smooth'});
  return message;
 }
 window.addEventListener('wander:reset',()=>{currentView=null;state.activePlanId=null;});
 window.WanderPlans={normalize,active,summary,price,geometry,commute,safeURL,draw,append};
})();

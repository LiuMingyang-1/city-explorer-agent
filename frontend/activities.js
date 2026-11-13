'use strict';
// Read-only event feed. Demo data comes from the repository's seed templates.
(() => {
 let feed=[],planEvents=[],groups=[],leafletLayer,renderEpoch=0,openEpoch=0,returnFocus,feedEpoch=0,feedRequest,viewportTimer,lastViewportKey,feedMissing=false;
 const text=(tag,cls,value)=>{const n=document.createElement(tag);n.className=cls;n.textContent=String(value??'');return n;};
 const valid=e=>e&&typeof e.event_id==='string'&&typeof e.title==='string'&&typeof e.latitude==='number'&&typeof e.longitude==='number'&&Number.isFinite(e.latitude)&&Number.isFinite(e.longitude)&&Math.abs(e.latitude)<=90&&Math.abs(e.longitude)<=180;
 function present(event){
  if(!event.is_demo&&!/^mock_/i.test(event.event_id))return event;
  const kind=/书|讲座/.test(event.category)?'books':/市集/.test(event.category)?'market':/演出|音乐|放映/.test(event.category)?'performance':'exhibition';
  const placeholder=value=>{try{return new URL(value).hostname==='example.com';}catch{return !value;}};
  return {...event,is_demo:true,thumbnail_url:placeholder(event.thumbnail_url)?'/assets/demo/'+kind+'.jpg':event.thumbnail_url,image_note:event.image_note||'示意配图 · 非活动实拍',guide_url:placeholder(event.guide_url)?null:event.guide_url,source_url:event.source_url||(/^mock_/i.test(event.event_id)?'https://github.com/LiuMingyang-1/city-explorer-agent/tree/main/docs/mocks/day0':'https://github.com/LiuMingyang-1/city-explorer-agent/blob/main/src/data/seed-templates.ts')};
 }
 const distance=(a,b)=>{const lat=(a.lat+b.lat)*Math.PI/360;return Math.hypot((a.lng-b.lng)*Math.cos(lat),a.lat-b.lat)*111.2;};
 function groupEvents(events){
  const map=new Map();events.filter(valid).forEach(e=>{
   const system=e.coordinate_system||'GCJ-02',key=system+':'+e.latitude.toFixed(5)+','+e.longitude.toFixed(5)+':'+e.venue_name+':'+e.title;
   if(!map.has(key))map.set(key,{id:key,lat:e.latitude,lng:e.longitude,coordinateSystem:system,name:e.venue_name||e.title,events:[]});
   map.get(key).events.push(e);
  });return [...map.values()];
 }
 function currentEvents(events){
  const byTitle=new Map();const now=new Date(),today=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
  const candidates=events.filter(e=>e.is_demo||!e.end_at||e.end_at.slice(0,10)>=today).sort((a,b)=>String(a.start_at||'').localeCompare(String(b.start_at||'')));
  // Daily repeats share one card; its next available time is shown.
  candidates.forEach(e=>{if(!byTitle.has(e.title))byTitle.set(e.title,e);});return [...byTitle.values()];
 }
 function refresh(){
  const merged=new Map([...feed,...planEvents].map(e=>[e.event_id,e]));groups=groupEvents([...merged.values()]).filter(group=>currentEvents(group.events).length);renderMap();
 }
 function pin(group){
  const event=currentEvents(group.events)[0]||group.events[0],wrap=document.createElement('div');wrap.className='activity-bubble-wrap';
  const button=text('button','activity-bubble','');button.type='button';button.setAttribute('aria-label',event.title+'，查看活动');
  button.append(text('span','activity-bubble-title',event.title),text('span','activity-bubble-meta',(event.category||'活动')+' · '+window.WanderPlans.price(event)));
  wrap.append(button);return wrap;
 }
 function layoutBubbles(items,{width,height,zoom=11,occupied=[]}){
  const boxes=[...occupied],result=new Map(),max=zoom>=15?20:zoom>=13?12:7,w=190,h=49;
  const overlap=(a,b)=>a.left<b.right+9&&a.right>b.left-9&&a.top<b.bottom+9&&a.bottom>b.top-9;
  const ordered=[...items].sort((a,b)=>Math.hypot(a.x-width/2,a.y-height/2)-Math.hypot(b.x-width/2,b.y-height/2)||String(a.id).localeCompare(String(b.id)));
  for(const item of ordered){
   if(result.size>=max)break;
   if(item.x<8||item.x>width-8||item.y<8||item.y>height-25)continue;
   const offsets=[[16,-h/2],[-w-16,-h/2],[-w/2,-h-20],[-w/2,20]];
   for(const [dx,dy] of offsets){
    const box={left:item.x+dx,right:item.x+dx+w,top:item.y+dy,bottom:item.y+dy+h};
    if(box.left<10||box.right>width-10||box.top<10||box.bottom>height-25||boxes.some(other=>overlap(box,other)))continue;
    boxes.push(box);result.set(item.id,{dx,dy,box});break;
   }
  }return result;
 }
 async function renderMap(){
  const epoch=++renderEpoch;
  if(window.WanderAMap?.ready){await window.WanderAMap.setActivities(groups,group=>openEvents(group.events,{placeName:group.name,coordinateSystem:group.coordinateSystem}));return;}
  if(typeof map==='undefined'||!map||!window.L)return;
  if(leafletLayer)map.removeLayer(leafletLayer);
  const layers=groups.filter(g=>['WGS84','WGS-84'].includes(g.coordinateSystem)).map(group=>{
   const node=pin(group);node.addEventListener('click',()=>openEvents(group.events,{placeName:group.name,coordinateSystem:group.coordinateSystem}));
   const marker=L.marker([group.lat,group.lng],{icon:L.divIcon({className:'activity-map-icon',html:node,iconSize:[0,0],iconAnchor:[0,0]}),title:group.events[0].title,zIndexOffset:400});return {marker,group,node};
  });
  const size=map.getSize(),card=document.querySelector('.glass-card').getBoundingClientRect(),occupied=[card];
  const detail=$('activity-detail');if(!detail.hidden)occupied.push(detail.getBoundingClientRect());
  const items=layers.map(item=>{const p=map.latLngToContainerPoint([item.group.lat,item.group.lng]);return {...item,id:item.group.id,x:p.x,y:p.y};});
  const placements=layoutBubbles(items,{width:size.x,height:size.y,zoom:map.getZoom(),occupied});
  const visible=items.filter(item=>{const fit=placements.get(item.id);if(!fit)return false;item.node.style.setProperty('--bubble-x',fit.dx+'px');item.node.style.setProperty('--bubble-y',fit.dy+'px');return true;});
  if(epoch===renderEpoch)leafletLayer=L.layerGroup(visible.map(item=>item.marker)).addTo(map);
 }
 function close(){openEpoch++;const panel=$('activity-detail');panel.hidden=true;window.WanderAMap?.updatePlaces?.();returnFocus?.focus?.({preventScroll:true});}
 function openEvents(events,{placeName='地点活动',coordinateSystem='GCJ-02'}={}){
  const panel=$('activity-detail'),epoch=++openEpoch;returnFocus=document.activeElement;
  const available=currentEvents(events.filter(valid).map(present));panel.replaceChildren();panel.hidden=false;
  const header=document.createElement('header');header.className='activity-detail-header';
  const titles=document.createElement('div');titles.append(text('p','activity-eyebrow','此地，值得停留'),text('h2','activity-place',placeName));
  const dismiss=text('button','activity-close','×');dismiss.type='button';dismiss.setAttribute('aria-label','关闭活动详情');dismiss.addEventListener('click',close);header.append(titles,dismiss);panel.append(header);
  if(!available.length){panel.append(text('p','activity-empty','这里暂未收录活动。可以拖动或放大地图，查看附近的活动气泡。'));return;}
  const choices=document.createElement('div');choices.className='activity-choices';choices.setAttribute('aria-label','此地活动');
  const body=document.createElement('div');body.className='activity-detail-body';
  const buttons=available.map((event,index)=>{
   const button=text('button','activity-choice',(event.category||'活动')+' · '+(index+1));button.type='button';button.title=event.title;button.addEventListener('click',()=>show(index));choices.append(button);return button;
  });if(available.length>1)panel.append(choices);panel.append(body);
  function show(index){
   const e=available[index];body.replaceChildren();buttons.forEach((b,i)=>{b.classList.toggle('active',i===index);b.setAttribute('aria-pressed',String(i===index));});
   const cover=window.WanderPlans.eventCover(e);cover.classList.add('activity-hero');
   if(e.image_note)cover.append(text('span','activity-image-note',e.image_note));body.append(cover);
   const info=document.createElement('div');info.className='activity-info';
   if(e.is_demo)info.append(text('span','activity-demo-note','示例活动 · 场地与排期均为模拟'));
   info.append(text('h3','activity-title',e.title),text('p','activity-description',e.description||''));
   const facts=document.createElement('dl');facts.className='activity-facts';
   const fact=(label,value)=>{if(!value)return;const row=document.createElement('div');row.append(text('dt','',label),text('dd','',value));facts.append(row);};
   fact('时间',[e.start_at?.replace('T',' '),e.end_at?.slice(11)].filter(Boolean).join(' – '));
   fact('地点',e.address||e.venue_name);fact('预算',window.WanderPlans.price(e)+' / 人');fact('提示',e.budget_note);info.append(facts);
   const links=document.createElement('div');links.className='activity-actions';const url=window.WanderPlans.safeURL(e.guide_url)||window.WanderPlans.safeURL(e.source_url);
   if(url){const link=text('a','activity-source',e.guide_url?'活动原站 ↗':'示例数据来源 ↗');link.href=url;link.target='_blank';link.rel='noopener noreferrer';links.append(link);}else links.append(text('span','activity-no-link','原站链接待补充'));
   const ask=text('button','activity-ask','问问这个活动 ↗');ask.type='button';ask.addEventListener('click',()=>{
    if(epoch!==openEpoch)return;window.WanderPlans.closeDetail();window.WanderHistory?.setExpanded(false);
    $('message-input').value=('我想了解「'+e.title+'」（'+e.venue_name+'），适合加进我的行程吗？').slice(0,1000);state.referencedEventId=e.is_demo?null:e.event_id;state.referencedDraft=$('message-input').value;updateSendButton();$('message-input').focus({preventScroll:true});
   });links.append(ask);info.append(links);body.append(info);body.scrollTo({top:0});
  }
  show(0);window.WanderAMap?.updatePlaces?.();
 }
 async function openNearby(place){
  const epoch=++openEpoch;let gcj;
  if(window.WanderAMap?.ready){try{const [p]=await window.WanderAMap.convert([[place.lng,place.lat]],'WGS84');gcj={lat:p[1],lng:p[0]};}catch{}}
  if(epoch!==openEpoch)return;
  const nearby=groups.map(g=>({group:g,distance:distance(['GCJ02','GCJ-02'].includes(g.coordinateSystem)?gcj||{lat:90,lng:180}:place,g)})).filter(g=>g.distance<=2.5).sort((a,b)=>a.distance-b.distance);
  openEvents(nearby.flatMap(g=>g.group.events),{placeName:place.name});
 }
 function addPlanEvents(model){planEvents=(model.events||[]).filter(valid).map(e=>({...e,coordinate_system:model.coordinate_system||'GCJ-02',is_demo:e.is_demo||/^mock_/i.test(e.event_id)}));refresh();}
 async function load({viewport=false}={}){
  const epoch=++feedEpoch;feedRequest?.abort();const request=new AbortController();feedRequest=request;
  try{
   const configured=window.WANDER_CONFIG?.eventsEndpoint;
   let endpoint=configured||'/api/events';
   if(viewport&&(!configured||configured.startsWith('/api/events'))){
    const view=window.WanderAMap?.getViewport?.();
    if(view?.bbox?.length===4){const query=new URLSearchParams({bbox:view.bbox.map(v=>v.toFixed(4)).join(','),limit:'200'});endpoint+=(endpoint.includes('?')?'&':'?')+query;}
   }
   let response=await fetch(endpoint,{credentials:'same-origin',signal:request.signal});
   if(!configured&&response.status===404){feedMissing=true;response=await fetch('/data/demo-events.json',{credentials:'same-origin',signal:request.signal});}
   else feedMissing=false;
   if(!response.ok)throw new Error('Feed unavailable');const data=await response.json();if(epoch!==feedEpoch||!Array.isArray(data.events))return;
   feed=data.events.filter(valid).map(e=>({...e,coordinate_system:data.coordinate_system||'GCJ-02',is_demo:Boolean(data.is_demo||e.is_demo||/模拟数据，非真实活动/.test(e.description||''))}));refresh();
  }catch{ /* Keep the current viewport's usable data when the feed is temporarily unavailable. */ }
 }
 function viewportChanged(){
  if(!window.WanderAMap?.ready)renderMap();
  const configured=window.WANDER_CONFIG?.eventsEndpoint;if(feedMissing||configured&&!configured.startsWith('/api/events'))return;
  const view=window.WanderAMap?.getViewport?.();if(!view?.bbox)return;
  const key=view.bbox.map(v=>v.toFixed(4)).join(',');if(key===lastViewportKey)return;lastViewportKey=key;
  clearTimeout(viewportTimer);viewportTimer=setTimeout(()=>load({viewport:true}),250);
 }
 window.addEventListener('wander:map-ready',()=>{renderMap();viewportChanged();});
 window.addEventListener('wander:viewport',viewportChanged);
 window.addEventListener('wander:reset',()=>{close();planEvents=[];refresh();});
 window.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('activity-detail').hidden)close();});
 window.WanderActivities={openEvents,openNearby,addPlanEvents,groupEvents,currentEvents,pin,layoutBubbles,close,reload:load};load();
})();

'use strict';
// Shared route presentation. Coordinates in this module are always [lng, lat].
(() => {
 const palettes=new Map();
 const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));
 const hash=value=>Array.from(value).reduce((n,c)=>(Math.imul(n,31)+c.charCodeAt(0))>>>0,0);
 const distance=(a,b)=>Math.hypot((b[0]-a[0])*Math.cos((a[1]+b[1])*Math.PI/360),b[1]-a[1])*111200;
 function orient(path,from,to){
  if(path.length<2||!from||!to)return path;
  return distance(path[0],from)+distance(path.at(-1),to)>distance(path.at(-1),from)+distance(path[0],to)?[...path].reverse():path;
 }
 function measure(path){let length=0;const lengths=[0];for(let i=1;i<path.length;i++){length+=distance(path[i-1],path[i]);lengths.push(length);}return {path,length,lengths};}
 function prefix(line,travel){
  if(travel>=line.length)return line.path;
  let lo=1,hi=line.lengths.length-1;
  while(lo<hi){const mid=(lo+hi)>>1;if(line.lengths[mid]<travel)lo=mid+1;else hi=mid;}
  const a=line.path[lo-1],b=line.path[lo],span=line.lengths[lo]-line.lengths[lo-1],t=span?clamp((travel-line.lengths[lo-1])/span,0,1):0;
  return [...line.path.slice(0,lo),[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]];
 }
 function stroke(zoom=11,selected=true){const width=Math.round(clamp(5.5+(zoom-10)*.35,5,8)*10)/10;return {width:selected?width:Math.max(3.5,width-2),border:selected?2:1.5};}
 function rgb(h,s,l){
  const c=(1-Math.abs(2*l-1))*s,x=c*(1-Math.abs((h/60)%2-1)),m=l-c/2;
  const values=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];return values.map(v=>Math.round((v+m)*255));
 }
 function luminance(values){return values.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);}
 function color(hue){
  let light=.39,values=rgb(hue,.72,light);const background=luminance([237,242,232]);
  while((background+.05)/(luminance(values)+.05)<4.5&&light>.2){light-=.01;values=rgb(hue,.72,light);}
  return '#'+values.map(v=>v.toString(16).padStart(2,'0')).join('');
 }
 function extractHue(pixels){
  const bins=Array.from({length:24},()=>({weight:0,x:0,y:0}));
  for(let i=0;i<pixels.length;i+=4){
   const [r,g,b,a]=Array.from(pixels.slice(i,i+4),v=>v/255),max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
   if(a<.5||max<.08||delta/(max||1)<.18)continue;
   const hue=((max===r?(g-b)/delta:max===g?(b-r)/delta+2:(r-g)/delta+4)*60+360)%360,weight=delta*a,bin=bins[Math.floor(hue/15)];
   bin.weight+=weight;bin.x+=Math.cos(hue*Math.PI/180)*weight;bin.y+=Math.sin(hue*Math.PI/180)*weight;
  }
  const best=bins.sort((a,b)=>b.weight-a.weight)[0];return best.weight?((Math.atan2(best.y,best.x)*180/Math.PI)+360)%360:null;
 }
 function sample(url){return new Promise(resolve=>{
  const image=new Image();let settled=false;
  const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);image.onload=image.onerror=null;resolve(value);};
  const timer=setTimeout(()=>finish(null),450);image.crossOrigin='anonymous';image.referrerPolicy='no-referrer';
  image.onload=()=>{try{const canvas=document.createElement('canvas');canvas.width=canvas.height=24;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0,24,24);finish(extractHue(ctx.getImageData(0,0,24,24).data));}catch{finish(null);}};
  image.onerror=()=>finish(null);image.src=url;
 });}
 function imageURLs(plan,byId){
  const urls=[];
  for(const stop of plan.itinerary.stops){
   const event=byId.get(stop.event_id)||{};let images=event.image_urls;if(typeof images==='string'){try{images=JSON.parse(images);}catch{images=[];}}
   for(const value of [event.thumbnail_url,...(Array.isArray(images)?images:[])]){
    if(typeof value!=='string'||!value)continue;
    try{const url=new URL(value,window.location.href);if(['http:','https:'].includes(url.protocol)&&!urls.includes(url.href))urls.push(url.href);}catch{}
   }
  }return urls.slice(0,3);
 }
 function palette(model){
  const byId=new Map(model.events.map(e=>[e.event_id,e])),sources=model.plans.map(p=>imageURLs(p,byId));
  const signature=JSON.stringify(model.plans.map((p,i)=>[p.plan_id,p.itinerary.stops.map(s=>s.event_id),sources[i]]));
  if(palettes.has(signature))return palettes.get(signature);
  function resolve(hues){
   const used=[],result=new Map();model.plans.forEach((plan,i)=>{
    let hue=hues[i]??hash(plan.plan_id+':'+plan.itinerary.stops.map(s=>s.event_id).join(','))%360;
    if(used.some(other=>Math.min(Math.abs(hue-other),360-Math.abs(hue-other))<75))hue=(used[0]+137.5)%360;
    used.push(hue);result.set(plan.plan_id,{color:color(hue),hue,source:hues[i]==null?'fallback':'thumbnail'});
   });return result;
  }
  // Freeze a palette before mounting routes. Late images never recolor an
  // already visible plan; repeated selections/zooming reuse the same snapshot.
  const result=typeof Image==='undefined'||!sources.some(s=>s.length)?resolve([]):Promise.all(sources.map(async urls=>(await Promise.all(urls.map(sample))).find(h=>h!==null)??null)).then(resolve);
  palettes.set(signature,result);if(palettes.size>64)palettes.delete(palettes.keys().next().value);return result;
 }
 function animate(segments){
  const lines=segments.filter(s=>s.path.length>=2).map(s=>({...s,...measure(s.path)})),total=lines.reduce((sum,l)=>sum+l.length,0);
  const media=typeof matchMedia==='function'?matchMedia('(prefers-reduced-motion: reduce)'):null;
  let stopped=false,frame=0,start,finished=0,last=-Infinity;
  const stop=()=>{stopped=true;if(frame&&typeof cancelAnimationFrame==='function')cancelAnimationFrame(frame);media?.removeEventListener?.('change',changed);};
  const complete=()=>{lines.forEach(line=>line.show(line.path));stop();};
  const changed=()=>{if(media.matches)complete();};
  if(!lines.length||!total||media?.matches||typeof requestAnimationFrame!=='function'){complete();return stop;}
  lines.forEach(line=>line.show([line.path[0],line.path[0]]));media?.addEventListener?.('change',changed);
  const duration=clamp(1400+Math.sqrt(total)*20,1800,3600);
  function tick(now){
   if(stopped)return;if(start===undefined)start=now;
   if(now-start>=duration){complete();return;}
   if(now-last>=32){
    let travel=total*(now-start)/duration,index=0;
    while(index<lines.length&&travel>=lines[index].length){travel-=lines[index].length;if(index>=finished)lines[index].show(lines[index].path);index++;}
    finished=index;if(index<lines.length)lines[index].show(prefix(lines[index],travel));last=now;
   }
   frame=requestAnimationFrame(tick);
  }
  frame=requestAnimationFrame(tick);return stop;
 }
 window.WanderRouteVisuals={stroke,palette,orient,animate,extractHue};
})();

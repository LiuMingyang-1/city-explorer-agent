import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {setup,Element} from './frontend-fixture.ts';
const source=readFileSync(new URL('../frontend/activities.js',import.meta.url),'utf8');
const sample=JSON.parse(readFileSync(new URL('../frontend/data/demo-events.json',import.meta.url),'utf8'));
const nodes=(root:Element):Element[]=>[root,...root.children.flatMap(nodes)];
const find=(root:Element,cls:string)=>nodes(root).filter(e=>e.className.split(' ').includes(cls)||e.classes.has(cls));
const content=(root:Element)=>nodes(root).map(e=>e.textContent).join('\n');
async function activitySetup(){
 const h=setup({api:true});let rendered:any[]=[];
 h.context.window.WanderAMap={ready:true,clearRoutes(){},async setActivities(groups:any[]){rendered=groups;}};
 h.context.fetch=async()=>new Response(JSON.stringify(sample));
 vm.runInContext(source,h.context);await h.context.window.WanderActivities.reload();
 return {...h,groups:()=>rendered,activities:h.context.window.WanderActivities};
}

test('seed activity feed groups daily repeats at venues and pins open independently of chat',async()=>{
 const h=await activitySetup();assert.equal(sample.events.length,119);assert.equal(h.groups().length,24);
 const all=h.groups().flatMap(g=>g.events);assert.equal(all.length,119);
 assert(h.groups().every(g=>g.coordinateSystem==='GCJ-02'));
 const group=h.groups()[0];assert(h.activities.currentEvents(group.events).length<group.events.length);
 h.activities.openEvents(group.events,{placeName:group.name});const panel=h.$('activity-detail'),allText=content(panel);
 assert.equal(panel.hidden,false);assert(allText.includes('示例活动'));assert(allText.includes('¥120–150'));assert(allText.includes('学生票半价'));
 assert(allText.includes('10:00'));assert(allText.includes(group.events[0].address));assert.equal(h.state.messages.length,0);
 assert(nodes(panel).some(n=>n.src==='/assets/demo/exhibition.jpg'));
 assert(find(panel,'activity-source')[0]!.href.startsWith('https://github.com/'));
 find(panel,'activity-close')[0]!.click();assert.equal(panel.hidden,true);
});

test('activity details switch free/unknown budgets and only draft a question when asked',async()=>{
 const h=await activitySetup(),first=sample.events[0];
 const events=[{...first,event_id:'free',title:'免费活动',budget_min:0,budget_max:0},{...first,event_id:'unknown',title:'待确认活动',budget_min:null,budget_max:null}];
 h.activities.openEvents(events,{placeName:'测试地点'});const panel=h.$('activity-detail');assert(content(panel).includes('免费 / 人'));
 find(panel,'activity-choice')[1]!.click();assert(content(panel).includes('票价待确认 / 人'));
 h.$('plan-detail').hidden=false;h.$('card').classList.add('viewing-plan');
 find(panel,'activity-ask')[0]!.click();assert.equal(h.$('plan-detail').hidden,true);assert(h.$('message-input').value.includes('待确认活动'));
 assert.equal(h.requests.length,0,'Point selection must not send a chat request without user submission');
});

test('map activity previews reject unsafe links, keep literal titles, and show an empty state for distant places',async()=>{
 const h=await activitySetup(),event={...sample.events[0],is_demo:false,end_at:'2099-12-31T18:00',title:'<img src=x onerror=alert(1)>',guide_url:'javascript:alert(1)',source_url:null};
 h.activities.openEvents([event]);const panel=h.$('activity-detail');assert.equal(find(panel,'activity-source').length,0);
 assert.equal(find(panel,'activity-title')[0]!.textContent,event.title);assert.equal(find(panel,'activity-title')[0]!.innerHTML,'');
 await h.activities.openNearby({name:'远处景点',lat:35,lng:110});assert(content(panel).includes('暂未收录活动'));
 h.$('new-chat').click();assert.equal(panel.hidden,true);
});

test('missing event feed does not block map and plan-derived events still populate pins',async()=>{
 const h=await activitySetup();h.context.fetch=async()=>{throw new Error('offline')};await h.activities.reload();
 h.activities.addPlanEvents({coordinate_system:'GCJ02',events:[{event_id:'new',title:'后端活动',latitude:34.2,longitude:108.9,venue_name:'后端场馆'}]});
 assert(h.groups().some(g=>g.coordinateSystem==='GCJ02'&&g.events[0].event_id==='new'));
});

test('current activities API uses GCJ contract and map selection passes a real event reference',async()=>{
 const h=await activitySetup(),event={...sample.events[0],event_id:'real-event',is_demo:false,end_at:'2099-12-31T18:00',description:'展览介绍',guide_url:'https://city.example/event'};
 const paths:string[]=[];h.context.fetch=async(url:string)=>{paths.push(url);return new Response(JSON.stringify({events:[event]}))};await h.activities.reload();
 assert.deepEqual(paths,['/api/events']);assert.equal(h.groups()[0].coordinateSystem,'GCJ-02');
 h.context.window.WanderAMap.backendLocation=()=>null;
 h.activities.openEvents([event]);find(h.$('activity-detail'),'activity-ask')[0]!.click();
 const draft=h.$('message-input').value;
 // Return to the fixture's deferred chat transport after loading the event API.
 let body:any;h.context.window.WanderTransport.request=async(value:any)=>{body=value;return {kind:'clarification',question:'什么时候去？'}};
 h.context.draft=draft;await h.run('window.sendMessage(draft)');assert.equal(body.referenced_event_id,'real-event');
 h.activities.openEvents([event]);find(h.$('activity-detail'),'activity-ask')[0]!.click();
 h.$('message-input').value='改成去看别的';h.$('message-input').listeners.get('input')!();
 await h.run('window.sendMessage("改成去看别的")');assert.equal(body.referenced_event_id,undefined);
});

test('activity bubbles carry title and price, stay in view, and avoid card/label collisions',async()=>{
 const h=await activitySetup(),bubble=h.activities.pin(h.groups()[0]);assert(content(bubble).includes(sample.events[0].title));assert(content(bubble).includes('¥120–150'));
 const occupied=[{left:0,right:450,top:0,bottom:900},{left:1000,right:1440,top:0,bottom:400}];
 const items=Array.from({length:25},(_,i)=>({id:String(i),x:500+(i%5)*180,y:100+Math.floor(i/5)*160}));items.push({id:'offscreen',x:-100,y:500});
 const near=h.activities.layoutBubbles(items,{width:1440,height:900,zoom:11,occupied}),closer=h.activities.layoutBubbles(items,{width:1440,height:900,zoom:15,occupied});
 assert(near.size<=7);assert(closer.size>near.size);assert(!near.has('offscreen'));
 const seen:any[]=[...occupied];for(const placement of closer.values()){const b=placement.box;assert(b.left>=10&&b.right<=1430&&b.top>=10&&b.bottom<=875);assert(!seen.some(a=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top));seen.push(b);}
});

test('viewport activity requests include GCJ bounds and late responses cannot overwrite a newer view',async()=>{
 const h=await activitySetup();let bbox=[108.9,34.2,109,34.3];h.context.window.WanderAMap.getViewport=()=>({bbox});
 const pending:{url:string;finish:(r:Response)=>void}[]=[];
 h.context.fetch=(url:string)=>new Promise(resolve=>pending.push({url,finish:resolve}));
 const older=h.activities.reload({viewport:true});bbox=[109.1,34.3,109.2,34.4];const newer=h.activities.reload({viewport:true});
 assert(pending[0]!.url.includes('bbox=108.9000%2C34.2000'));assert(pending[1]!.url.includes('bbox=109.1000%2C34.3000'));
 const e=sample.events[0];pending[1]!.finish(new Response(JSON.stringify({is_demo:true,events:[{...e,event_id:'new-view',title:'新视野活动'}]})));await newer;
 pending[0]!.finish(new Response(JSON.stringify({is_demo:true,events:[{...e,event_id:'old-view',title:'旧视野活动'}]})));await older;
 assert.equal(h.groups()[0].events[0].event_id,'new-view');
});

test('a confirmed 404 on the default feed stops viewport probing but keeps demo bubbles',async()=>{
 const h=await activitySetup(),urls:string[]=[];
 h.context.fetch=async(url:string)=>{urls.push(url);return url.startsWith('/api/events')?new Response(null,{status:404}):new Response(JSON.stringify(sample))};
 await h.activities.reload();assert.deepEqual(urls,['/api/events','/data/demo-events.json']);assert.equal(h.groups().length,24);
 let bbox=[108.9,34.2,109,34.3];h.context.window.WanderAMap.getViewport=()=>({bbox});
 h.run("window.dispatchEvent(new Event('wander:viewport'))");await new Promise(resolve=>setImmediate(resolve));
 bbox=[109.1,34.3,109.2,34.4];h.run("window.dispatchEvent(new Event('wander:viewport'))");await new Promise(resolve=>setImmediate(resolve));
 assert.equal(urls.length,2,'a remembered 404 must not re-probe the feed or refetch demo data on viewport changes');
});

test('an explicitly configured /api/events endpoint is not negatively cached after a 404',async()=>{
 const h=setup({api:true});h.context.window.WANDER_CONFIG={mockDelay:0,eventsEndpoint:'/api/events'};
 h.context.window.WanderAMap={ready:true,clearRoutes(){},async setActivities(){},getViewport:()=>({bbox:[108.9,34.2,109,34.3]})};
 const urls:string[]=[];h.context.fetch=async(url:string)=>{urls.push(url);return new Response(null,{status:404})};
 vm.runInContext(source,h.context);await h.context.window.WanderActivities.reload();
 h.run("window.dispatchEvent(new Event('wander:viewport'))");await new Promise(resolve=>setImmediate(resolve));
 assert.equal(urls.length,3);assert(urls[2]!.startsWith('/api/events?bbox='),'configured endpoint keeps viewport probing after a 404');
});

test('a later successful feed response clears the remembered 404 and resumes viewport probing',async()=>{
 const h=await activitySetup(),urls:string[]=[];
 h.context.fetch=async(url:string)=>{urls.push(url);return url.startsWith('/api/events')?new Response(null,{status:404}):new Response(JSON.stringify(sample))};
 await h.activities.reload();assert.equal(urls.length,2);
 h.context.window.WanderAMap.getViewport=()=>({bbox:[108.9,34.2,109,34.3]});
 h.run("window.dispatchEvent(new Event('wander:viewport'))");await new Promise(resolve=>setImmediate(resolve));assert.equal(urls.length,2);
 h.context.fetch=async(url:string)=>{urls.push(url);return new Response(JSON.stringify({events:[sample.events[0]]}))};
 await h.activities.reload();assert.equal(urls.length,3);
 h.run("window.dispatchEvent(new Event('wander:viewport'))");await new Promise(resolve=>setImmediate(resolve));
 assert(urls[3]!.startsWith('/api/events?bbox='),'a successful response resumes viewport probing');
});

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
 const h=await activitySetup();assert.equal(sample.events.length,119);assert.equal(h.groups().length,16);
 const all=h.groups().flatMap(g=>g.events);assert.equal(all.length,119);
 assert(h.groups().every(g=>g.coordinateSystem==='WGS84'));
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
 const h=await activitySetup(),event={...sample.events[0],is_demo:false,title:'<img src=x onerror=alert(1)>',guide_url:'javascript:alert(1)',source_url:null};
 h.activities.openEvents([event]);const panel=h.$('activity-detail');assert.equal(find(panel,'activity-source').length,0);
 assert.equal(find(panel,'activity-title')[0]!.textContent,event.title);assert.equal(find(panel,'activity-title')[0]!.innerHTML,'');
 h.activities.openNearby({name:'远处景点',lat:35,lng:110});assert(content(panel).includes('暂未收录活动'));
 h.$('new-chat').click();assert.equal(panel.hidden,true);
});

test('missing event feed does not block map and plan-derived events still populate pins',async()=>{
 const h=await activitySetup();h.context.fetch=async()=>{throw new Error('offline')};await h.activities.reload();
 h.activities.addPlanEvents({coordinate_system:'GCJ02',events:[{event_id:'new',title:'后端活动',latitude:34.2,longitude:108.9,venue_name:'后端场馆'}]});
 assert(h.groups().some(g=>g.coordinateSystem==='GCJ02'&&g.events[0].event_id==='new'));
});

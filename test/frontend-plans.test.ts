import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {setup,Element} from './frontend-fixture.ts';
const fixture=(name: string)=>JSON.parse(readFileSync(new URL('../docs/mocks/day0/'+name+'.json',import.meta.url),'utf8'));
function nodes(root: Element): Element[]{return [root,...root.children.flatMap(nodes)];}
function find(root: Element,cls: string){return nodes(root).filter(e=>e.className.split(' ').includes(cls));}
function content(root: Element): string{return nodes(root).map(e=>e.textContent).join('\n');}
function leaflet(h:ReturnType<typeof setup>){
 const created: {type:string;points:unknown;options:Record<string,unknown>}[]=[],groups:unknown[]=[],fitTargets:any[]=[];let fits=0;
 const make=(type:string,points:unknown,options:Record<string,unknown>)=>{
  const value={type,points,options,bindTooltip(){return this},on(){return this}};created.push(value);return value;
 };
 h.context.map={removeLayer(){},getSize(){return {x:1440,y:900}},fitBounds(bounds:unknown){fits++;fitTargets.push(bounds)}};
 h.context.locationLabel=(s:string)=>s;h.context.innerWidth=1440;
 const card=Object.assign(h.$('card'),{getBoundingClientRect:()=>({right:450,height:844})});
 h.context.document.querySelector=()=>card;
 h.context.L={circleMarker:(p:unknown,o:Record<string,unknown>)=>make('dot',p,o),polyline:(p:unknown,o:Record<string,unknown>)=>make('line',p,o),latLngBounds:(p:unknown)=>p,layerGroup:(layers:unknown[])=>({addTo(){groups.push(layers);return this}})};
 return {created,groups,fitTargets,fits:()=>fits};
}

test('rich event cards handle price ranges, free/unknown prices, venue, reason, links and image failure',()=>{
 const h=setup({api:true});h.context.payload=fixture('response-comparison');h.run('WanderPlans=window.WanderPlans; WanderPlans.append(payload)');
 assert.equal(find(h.$('messages'),'event-card').length,0);
 assert.equal(h.$('plan-detail').hidden,true);
 find(h.$('messages'),'plan-preview')[0]!.click();
 assert.equal(h.$('plan-detail').hidden,false);
 const root=h.$('plan-detail'),all=content(root);
 assert(all.includes('¥50–80'));assert(all.includes('免费'));assert(all.includes('Mock 曲江展厅'));assert(all.includes('符合下午慢逛需求'));
 assert.equal(find(root,'event-source')[0]!.href,'https://example.com/mock/a1');
 const image=nodes(root).find(n=>n.src.endsWith('a1.jpg'))!;image.listeners.get('error')!();assert(content(root).includes('图片暂缺'));
 const tabs=find(root,'plan-tab');tabs[1]!.click();assert(content(root).includes('票价待确认'));
 assert.equal(h.run('state.activePlanId'),'plan_mock_b');
 assert.equal(h.context.window.WanderPlans.safeURL('javascript:alert(1)'),null);
 assert.equal(h.context.window.WanderPlans.price({budget_min:null,budget_max:null}),'票价待确认');
});

test('A/B switching draws both supplied road geometries and highlights the selected route and fits its own bounds',()=>{
 const h=setup({api:true}),map=leaflet(h);h.context.payload={...fixture('response-comparison'),coordinate_system:'WGS84'};h.run('window.WanderPlans.append(payload)');
 let lines=map.created.filter(l=>l.type==='line');assert.equal(lines.length,2);assert.equal((lines[0]!.points as unknown[]).length,4);
 assert.deepEqual(Array.from((lines[0]!.points as number[][])[0]!),[34.249,108.94]);
 assert.equal(lines[1]!.options.opacity,.9);assert.equal(map.fits(),1);
 find(h.$('plan-detail'),'plan-tab')[1]!.click();
 lines=map.created.filter(l=>l.type==='line');assert.equal(lines.at(-1)!.options.color,'#64859a');assert.equal(lines.at(-1)!.options.opacity,.9);assert.equal(map.fits(),2);
 assert(map.fitTargets[0].every((p:number[])=>p[1]>=108.96),'A focuses the eastern route');assert(map.fitTargets[1].every((p:number[])=>p[1]<108.96),'B focuses the western route');
 assert(content(h.$('plan-detail')).includes('12 分钟'));assert(content(h.$('plan-detail')).includes('另预留 5 分钟'));
});

test('missing and mismatched geometry never invents a straight route or zero-minute commute',()=>{
 const h=setup({api:true}),map=leaflet(h);h.context.payload={...fixture('response-partial'),coordinate_system:'WGS84'};h.run('window.WanderPlans.append(payload)');
 assert.equal(map.created.filter(l=>l.type==='line').length,0);assert(content(h.$('plan-detail')).includes('通勤待确认'));
 const data=fixture('response-comparison');data.coordinate_system='GCJ-02';h.context.payload=data;h.run('window.WanderPlans.append(payload)');
 assert.equal(map.created.filter(l=>l.type==='line').length,0);assert(content(h.$('plan-detail')).includes('坐标系尚未匹配'));
 assert.equal(h.context.window.WanderPlans.geometry({status:'ok',geometry:null}),null);
});

test('legacy requests stay compatible; selecting B enables active_plan only after a plans reply',async()=>{
 const h=setup({api:true});const first=h.run('window.sendMessage("想看展")');
 assert.equal(h.requests[0]!.body.active_plan,undefined);h.requests[0]!.finish(fixture('response-comparison'));await first;
 find(h.$('plan-detail'),'plan-tab')[1]!.click();const second=h.run('window.sendMessage("就选B")');
 assert.equal(h.requests[1]!.body.active_plan,'plan_mock_b');assert.equal(h.requests[1]!.body.base_revision,undefined);assert.equal(h.requests[1]!.body.request_id,undefined);
 h.requests[1]!.finish(fixture('response-single'));await second;
 assert.equal(h.run('state.latestPlan.active_plan'),'plan_mock_b');
});

test('saved comparison plans restore rich cards and the active B selection',async()=>{
 const h=setup({api:true});const pending=h.run('window.sendMessage("西安半日游")');h.requests[0]!.finish(fixture('response-comparison'));await pending;
 find(h.$('plan-detail'),'plan-tab')[1]!.click();h.$('new-chat').click();h.$('history-list').children[0]!.click();
 assert.equal(h.run('state.activePlanId'),'plan_mock_b');assert.equal(find(h.$('plan-detail'),'plan-tab').length,2);assert(content(h.$('plan-detail')).includes('Mock 城南小展'));
});

test('SSE decoding tolerates split UTF-8, comments, multiline JSON and CRLF boundaries',async()=>{
 const h=setup({api:true});const stages:string[]=[];
 const raw=': ping\r\nevent: progress\r\ndata: {"stage":"routing",\r\ndata: "message":"正在获取路线"}\r\n\r\nevent: result\r\ndata: {"kind":"clarification","question":"去哪？"}\r\n\r\n';
 const bytes=new TextEncoder().encode(raw);
 const stream=new ReadableStream<Uint8Array>({start(controller){for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));controller.close()}});
 const result=await h.context.window.WanderTransport.readStream(new Response(stream),{onProgress:(s:{message:string})=>stages.push(s.message)});
 assert.deepEqual(stages,['正在获取路线']);assert.equal(result.question,'去哪？');
});

test('SSE terminal errors and truncated streams fail without committing a result',async()=>{
 const h=setup({api:true});const transport=h.context.window.WanderTransport;
 const response=(raw:string)=>new Response(raw,{headers:{'Content-Type':'text/event-stream'}});
 const raw=readFileSync(new URL('../docs/mocks/day0/stream-error.sse',import.meta.url),'utf8');
 await assert.rejects(transport.readStream(response(raw),{}),/未能生成可用方案/);
 await assert.rejects(transport.readStream(response('event: progress\ndata: {"message":"正在查询"}\n\n'),{}),/尚未收到完整方案/);
 assert.equal(h.state.messages.length,0);
});

test('JSON and real SSE responses share the configured SSE endpoint, and progress reaches the pending message',async()=>{
 const h=setup({api:true});let requested='';
 const sample=readFileSync(new URL('../docs/mocks/day0/stream.sse',import.meta.url),'utf8');
 h.context.fetch=async(url:string)=>{requested=url;return new Response(sample,{headers:{'Content-Type':'text/event-stream'}})};
 await h.run('window.sendMessage("给我两个方案")');assert.equal(requested,'/api/chat/stream');assert.equal(find(h.$('plan-detail'),'plan-tab').length,2);assert.equal(h.run('state.sessionId'),'sess_mock_001');
});

test('explicit demo mode reads canonical fixture files and preserves selected A on continuation',async()=>{
 const h=setup({api:true,mock:'comparison'});const paths:string[]=[];
 h.context.fetch=async(url:string)=>{paths.push(url);return new Response(readFileSync(new URL('../docs/mocks/day0/'+url.split('/').at(-1),import.meta.url),'utf8'))};
 await h.run('window.sendMessage("两个方案")');assert.equal(h.run('state.activePlanId'),'plan_mock_a');
 await h.run('window.sendMessage("保留A")');assert.equal(h.run('state.latestPlan.plans.length'),1);assert.equal(h.run('state.activePlanId'),'plan_mock_a');
 assert(paths.every(p=>p==='/__mocks/day0/stream.sse'));
});

 test('plan message opens the full card and returns to the same conversation and B selection',()=>{
 const h=setup({api:true});h.context.payload=fixture('response-comparison');h.run('window.WanderPlans.append(payload)');
 const before=h.state.messages.length,preview=find(h.$('messages'),'plan-preview')[0]!;
 assert.equal(find(h.$('messages'),'plan-tab').length,0);assert.equal(h.$('plan-detail').hidden,true);
 preview.click();assert.equal(h.$('plan-detail').hidden,false);assert(h.$('card').classes.has('viewing-plan'));
 find(h.$('plan-detail'),'plan-tab')[1]!.click();find(h.$('plan-detail'),'plan-back')[0]!.click();
 assert.equal(h.$('plan-detail').hidden,true);assert(!h.$('card').classes.has('viewing-plan'));assert.equal(h.state.messages.length,before);
 preview.click();assert.equal(h.run('state.activePlanId'),'plan_mock_b');
 h.$('new-chat').click();assert.equal(h.$('plan-detail').hidden,true);assert.equal(h.state.messages.length,0);
 });

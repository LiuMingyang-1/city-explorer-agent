import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {setup,Element} from './frontend-fixture.ts';
const payload=JSON.parse(readFileSync(new URL('../docs/mocks/day0/response-comparison.json',import.meta.url),'utf8'));
function find(root:Element,cls:string):Element|undefined{return [root,...root.children.flatMap(all)].find(n=>n.classes.has(cls));}
function all(root:Element):Element[]{return [root,...root.children.flatMap(all)];}
function harness(){
 const h=setup({api:true});
 h.$('plan-detail').hidden=true; // Match the real initial HTML hidden attribute.
 h.context.CustomEvent=class extends Event {detail:unknown;constructor(type:string,options:{detail:unknown}){super(type);this.detail=options.detail;}};
 const seen:any[]=[];
 h.context.window.addEventListener('wander:itinerary-focus',(event:any)=>{
  const current=h.context.window.WanderItineraryFocus;
  assert.equal(event.detail,current,'listeners must observe the published state synchronously');
  seen.push({active:current.active,phase:current.phase,model:current.model,plan:current.model?.active_plan});
 });
 h.context.payload=structuredClone(payload);h.run('window.WanderPlans.append(payload)');
 return {...h,seen,focus:()=>h.context.window.WanderItineraryFocus};
}

test('generation stays in explore; focus events expose complete normalized models and settle under reduced motion',()=>{
 const h=harness();assert.equal(h.focus().phase,'explore');assert.equal(h.focus().active,false);assert.equal(h.seen.length,0);
 find(h.$('messages'),'plan-preview')!.click();
 assert.equal(h.focus().phase,'detail');assert.equal(h.focus().active,true);
 assert.deepEqual(h.seen.slice(0,2).map(s=>s.phase),['entering','detail']);
 for(const s of h.seen){assert.equal(s.model.plans.length,2);assert.equal(s.model.events.length,payload.events.length);assert.equal(s.model.active_plan,'plan_mock_a');}
 const tabs=all(h.$('plan-detail')).filter(n=>n.classes.has('plan-tab'));tabs[1]!.click();
 assert.equal(h.focus().model.active_plan,'plan_mock_b');assert.equal(h.seen.at(-1).plan,'plan_mock_b');assert.equal(h.focus().model.plans.length,2);
 find(h.$('plan-detail'),'plan-back')!.click();
 assert.deepEqual(h.seen.slice(-2).map(s=>s.phase),['leaving','explore']);
 assert.equal(h.focus().active,false);assert.equal(h.focus().model,null);assert.equal(h.$('plan-detail').hidden,true);
});

test('history hydration does not enter detail and reset cannot leave an obsolete focused model',()=>{
 const h=harness();find(h.$('messages'),'plan-preview')!.click();
 all(h.$('plan-detail')).filter(n=>n.classes.has('plan-tab'))[1]!.click();
 h.context.window.WanderHistory.capture();h.$('new-chat').click();
 assert.equal(h.focus().phase,'explore');assert.equal(h.focus().model,null);
 h.$('history-list').children[0]!.click();
 assert.equal(h.focus().phase,'explore');assert.equal(h.focus().active,false);assert.equal(h.$('plan-detail').hidden,true);
 find(h.$('messages'),'plan-preview')!.click();
 assert.equal(h.focus().phase,'detail');assert.equal(h.focus().model.active_plan,'plan_mock_b');
 h.$('new-chat').click();assert.equal(h.focus().model,null);assert.equal(h.focus().active,false);
});

function manualTimers(h:ReturnType<typeof harness>){
 h.media.matches=false;let id=0;const callbacks=new Map<number,()=>void>(),cancelled=new Set<number>();
 h.context.setTimeout=(fn:()=>void)=>{callbacks.set(++id,fn);return id;};
 h.context.clearTimeout=(key:number)=>cancelled.add(key);
 return {callbacks,cancelled,flush(){const due=[...callbacks.values()];callbacks.clear();due.forEach(fn=>fn());}};
}

test('rapid enter leave enter converges to the last selected plan even if obsolete completion callbacks arrive',()=>{
 const h=harness(),timers=manualTimers(h),preview=find(h.$('messages'),'plan-preview')!;
 preview.click();assert.equal(h.focus().phase,'entering');
 find(h.$('plan-detail'),'plan-back')!.click();assert.equal(h.focus().phase,'leaving');
 preview.click();all(h.$('plan-detail')).filter(n=>n.classes.has('plan-tab'))[1]!.click();
 assert.equal(h.focus().phase,'entering');assert.equal(h.focus().model.active_plan,'plan_mock_b');
 // Invoke cancelled callbacks as well to exercise the stale epoch guard.
 assert(timers.cancelled.size>=2);timers.flush();
 assert.equal(h.focus().phase,'detail');assert.equal(h.focus().model.active_plan,'plan_mock_b');assert.equal(h.$('plan-detail').hidden,false);
 assert.equal(h.seen.filter(s=>s.phase==='explore').length,0,'obsolete leaving completion must not reset the new detail');
});

test('synchronous reset during entry wins over pending transition callbacks',()=>{
 const h=harness(),timers=manualTimers(h);find(h.$('messages'),'plan-preview')!.click();
 assert.equal(h.focus().phase,'entering');h.$('new-chat').click();
 assert.equal(h.focus().phase,'explore');assert.equal(h.focus().model,null);assert.equal(h.$('plan-detail').hidden,true);
 timers.flush();assert.equal(h.focus().phase,'explore');assert.equal(h.focus().active,false);assert.equal(h.focus().model,null);
});

test('elapsed fallback time cannot publish detail before the map shell reaches its target geometry',()=>{
 const h=harness(),timers=manualTimers(h);
 let actual={left:0,top:0,width:1440,height:900};
 const expected={left:763,top:140,width:619,height:619};
 h.context.document.getElementById=h.$;
 Object.assign(h.$('map-shell'),{getBoundingClientRect:()=>actual});
 Object.assign(h.$('itinerary-map-frame'),{getBoundingClientRect:()=>expected});
 find(h.$('messages'),'plan-preview')!.click();
 timers.flush();assert.equal(h.focus().phase,'entering','a timer firing while geometry is in flight must not declare detail');
 actual=expected;timers.flush();assert.equal(h.focus().phase,'detail');
});

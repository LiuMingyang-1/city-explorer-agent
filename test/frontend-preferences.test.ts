import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {setup} from './frontend-fixture.ts';
const source=readFileSync(new URL('../frontend/preferences.js',import.meta.url),'utf8');
function preferences({demo=false,blocked=false}={}){
 const h=setup({api:true}),calls:{url:string;options:RequestInit}[]=[],stored=new Map<string,string>();
 h.context.window.WANDER_CONFIG.mockMemory=demo;
 h.context.window.localStorage={getItem:(key:string)=>{if(blocked)throw new Error('blocked');return stored.get(key)||null},setItem:(key:string,value:string)=>{if(blocked)throw new Error('blocked');stored.set(key,value)},removeItem:(key:string)=>stored.delete(key)};
 let respond=(method:string)=>method==='DELETE'?new Response(null,{status:204}):Response.json({content:'喜欢美术馆，慢慢走',updated_at:'2026-11-13T01:00:00Z'});
 h.context.fetch=async(url:string,options:RequestInit)=>{calls.push({url,options});return respond(options.method||'GET')};
 vm.runInContext(source,h.context);
 return {...h,calls,stored,api:h.context.window.WanderPreferences,respond:(fn:typeof respond)=>{respond=fn}};
}

test('preference drawer loads, edits and saves via the existing cookie-scoped API',async()=>{
 const h=preferences();assert.equal(h.calls.length,0);await h.api.open();
 assert.equal(h.calls[0]!.url,'/api/memory');assert.equal(h.calls[0]!.options.method,'GET');assert.equal(h.calls[0]!.options.credentials,'same-origin');
 assert.equal(h.$('preferences-panel').hidden,false);assert.equal(h.$('preferences-content').value,'喜欢美术馆，慢慢走');
 h.$('preferences-content').value='  喜欢独立书店，下午出发  ';h.$('preferences-content').listeners.get('input')!();assert.equal(h.$('preferences-save').disabled,false);
 h.respond(()=>Response.json({content:'喜欢独立书店，下午出发',updated_at:'2026-11-13T02:00:00Z'}));await h.api.save();
 assert.equal(h.calls[1]!.options.method,'PUT');assert.deepEqual(JSON.parse(String(h.calls[1]!.options.body)),{content:'喜欢独立书店，下午出发'});
 assert.equal(h.$('preferences-content').value,'喜欢独立书店，下午出发');assert.equal(h.$('preferences-save').disabled,true);
 h.api.close();assert.equal(h.$('preferences-panel').hidden,true);
});

test('preference clear requires inline confirmation and handles a 204 with no JSON body',async()=>{
 const h=preferences();await h.api.open();await h.api.clear();assert.equal(h.calls.length,1);assert.equal(h.$('preferences-clear').textContent,'确认清空');
 await h.api.clear();assert.equal(h.calls[1]!.options.method,'DELETE');assert.equal(h.$('preferences-content').value,'');assert.equal(h.$('preferences-clear').disabled,true);
});

test('API failures preserve drafts and never pretend the save or delete succeeded',async()=>{
 const h=preferences();await h.api.open();h.$('preferences-content').value='未保存的草稿';
 h.respond(()=>Response.json({error:'internal detail must stay hidden'},{status:500}));await h.api.save();
 assert.equal(h.$('preferences-content').value,'未保存的草稿');assert(h.$('preferences-status').textContent.includes('暂不可用'));
 assert(!h.$('preferences-status').textContent.includes('internal detail'));
 h.api.close();const before=h.calls.length;await h.api.open();assert.equal(h.calls.length,before);assert.equal(h.$('preferences-content').value,'未保存的草稿');
 await h.api.clear();await h.api.clear();assert.equal(h.$('preferences-content').value,'未保存的草稿');
});

test('missing API is visible, read-only until retry succeeds, and blank edits do not send PUT',async()=>{
 const h=preferences();h.respond(()=>new Response(null,{status:404}));await h.api.open();
 assert.equal(h.$('preferences-content').disabled,true);assert.equal(h.$('preferences-retry').hidden,false);assert(h.$('preferences-status').textContent.includes('尚未连接'));
 h.respond(()=>Response.json({content:'',updated_at:null}));await h.api.load();assert.equal(h.$('preferences-content').disabled,false);
 h.$('preferences-content').value='   ';const before=h.calls.length;await h.api.save();assert.equal(h.calls.length,before);
});

test('explicit demo preferences use isolated browser storage and blocked storage is not reported as saved',async()=>{
 const h=preferences({demo:true});await h.api.open();assert.equal(h.calls.length,0);h.$('preferences-content').value='演示偏好';await h.api.save();
 assert.equal(JSON.parse(h.stored.get('wander.demo-preferences.v1')!).content,'演示偏好');assert(h.$('preferences-mode').textContent.includes('演示模式'));
 await h.api.clear();await h.api.clear();assert.equal(h.stored.size,0);
 const blocked=preferences({demo:true,blocked:true});await blocked.api.open();assert.equal(blocked.$('preferences-content').disabled,true);assert.equal(blocked.calls.length,0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {setup,Element} from './frontend-fixture.ts';
const all=(root:Element):Element[]=>[root,...root.children.flatMap(all)];
const find=(root:Element,cls:string)=>all(root).find(n=>n.className.split(' ').includes(cls));
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const answer={kind:'answer',text:'已收到',session_id:'chip-session'};
function fixture(){
 const h=setup({api:true}),requests:{body:any;finish:(r:Response)=>void}[]=[];
 h.context.fetch=(_url:string,options:{body:string})=>new Promise(resolve=>requests.push({body:JSON.parse(options.body),finish:resolve}));
 return {...h,requests};
}

test('accepted send immediately consumes the add chip and the next plain message carries no reference',async()=>{
 const h=fixture();h.run("attachEventChip({eventId:'submitted',title:'西安城墙',kind:'add'})");
 const job=h.run('window.sendMessage("")');
 assert.equal(h.$('composer-chips').hidden,true,'do not wait for a server response to clear the chip');
 assert.equal(h.run('state.eventChip'),null);assert(h.state.busy);
 assert.equal(h.requests[0]!.body.referenced_event_id,'submitted');assert(h.requests[0]!.body.message.includes('西安城墙'));assert(h.requests[0]!.body.message.includes('加入我的行程'));
 h.requests[0]!.finish(Response.json(answer));await job;
 const next=h.run('window.sendMessage("下午出发")');assert.equal(h.requests[1]!.body.referenced_event_id,undefined);
 h.requests[1]!.finish(Response.json(answer));await next;
});

test('supplemental text consumes an ask chip immediately and completion preserves a newly attached draft',async()=>{
 const h=fixture();h.run("attachEventChip({eventId:'ask-event',title:'钟楼',kind:'ask'})");
 const job=h.run('window.sendMessage("需要预约吗")');assert(h.$('composer-chips').hidden);
 assert.equal(h.requests[0]!.body.message,'需要预约吗');assert.equal(h.requests[0]!.body.referenced_event_id,'ask-event');
 h.run("attachEventChip({eventId:'new-draft',title:'大雁塔',kind:'add'})");h.$('message-input').value='明天再去';
 h.requests[0]!.finish(Response.json(answer));await job;
 assert.equal(h.run('state.eventChip.eventId'),'new-draft');assert(!h.$('composer-chips').hidden);assert.equal(h.$('message-input').value,'明天再去');
});

for(const stream of [false,true])test(`${stream?'SSE':'JSON'} failure retries the submitted snapshot without consuming a newer draft`,async()=>{
 const h=fixture();h.run("attachEventChip({eventId:'original-add',title:'城墙',kind:'add'});const originalChip=state.eventChip;");
 const job=h.run('window.sendMessage("")');assert(h.$('composer-chips').hidden);
 // A retry must own an immutable request snapshot, not the discarded UI object.
 h.run("originalChip.eventId='mutated';originalChip.kind='ask';attachEventChip({eventId:'draft-add',title:'大雁塔',kind:'add'})");
 h.$('message-input').value='保留草稿文字';
 const failure={error:{message:'验证用暂时失败',retryable:true,code:'temporary_error'}};
 h.requests[0]!.finish(stream?new Response('event: error\ndata: '+JSON.stringify(failure)+'\n\n',{headers:{'Content-Type':'text/event-stream'}}):Response.json(failure,{status:503}));await job;
 assert.equal(h.run('state.eventChip.eventId'),'draft-add');assert(!h.$('composer-chips').hidden);
 const retry=find(h.$('messages'),'retry-button');assert(retry);retry.click();
 assert.equal(h.requests.length,2);assert.equal(h.requests[1]!.body.referenced_event_id,'original-add');assert.equal(h.requests[1]!.body.message,h.requests[0]!.body.message);assert(h.requests[1]!.body.message.includes('加入我的行程'));
 assert.equal(h.run('state.eventChip.eventId'),'draft-add');assert(!h.$('composer-chips').hidden);
 h.requests[1]!.finish(Response.json(answer));await flush();
 assert(!h.state.busy);assert.equal(h.run('state.eventChip.eventId'),'draft-add');assert.equal(h.$('message-input').value,'保留草稿文字');
 const next=h.run('window.sendMessage("明天去")');assert.equal(h.requests[2]!.body.referenced_event_id,'draft-add');assert(h.$('composer-chips').hidden);h.requests[2]!.finish(Response.json(answer));await next;
});

test('busy submissions keep an unsent draft and an old completion cannot clear a new conversation chip',async()=>{
 const h=fixture();h.run("attachEventChip({eventId:'old-event',title:'城墙',kind:'add'})");const job=h.run('window.sendMessage("安排下午")');
 h.run("attachEventChip({eventId:'busy-draft',title:'钟楼',kind:'ask'})");await h.run('window.sendMessage("")');assert.equal(h.requests.length,1);assert.equal(h.run('state.eventChip.eventId'),'busy-draft');
 h.$('new-chat').click();h.run("attachEventChip({eventId:'new-conversation',title:'大雁塔',kind:'add'})");
 h.requests[0]!.finish(Response.json(answer));await job;assert.equal(h.run('state.eventChip.eventId'),'new-conversation');assert(!h.$('composer-chips').hidden);assert.equal(h.state.messages.length,0);
});

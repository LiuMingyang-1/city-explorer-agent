import {test} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createSearchService} from "../src/search/service.ts";
import {createSearchRepository} from "../src/search/sqlite.ts";
import {canonicalUrl} from "../src/search/normalize.ts";
import {FakeClock,adapter,context,hit,flush,ChannelError} from "./search-fixture.ts";
import type {SearchAdapter,SearchRequest} from "../src/search/types.ts";
import type {SearchRepository} from "../src/search/repository.ts";
const req={mode:"external",keyword:"展览"} as const;
function setup(adapters:SearchAdapter[],extra:Record<string,unknown>={}){
 const clock=new FakeClock(),repo=createSearchRepository(":memory:",{now:clock.now}),service=createSearchService({repository:repo,adapters,clock,...extra});
 return {clock,repo,service};
}
test("empty success, unverified documents and mode limitations",async()=>{
 const {clock,repo,service}=setup([adapter("fake")]);
 const r=await service.search(req,context(clock));assert.equal(r.status,"success");assert.equal(r.results.length,1);assert.equal(r.results[0].plannable,false);assert.equal(r.results[0].event,null);
 const hybrid=await service.search({},context(clock));assert.equal(hybrid.status,"partial");assert(hybrid.errors.some(e=>e.code==="LOCAL_NOT_IMPLEMENTED"));
 const local=await service.search({mode:"local"},context(clock));assert.equal(local.status,"failed");
 const unsupported=await service.search({...req,platforms:["xiaohongshu"]},context(clock));assert.equal(unsupported.status,"failed");assert.equal(unsupported.coverage[0].status,"unsupported");
 await service.close();repo.close();
 const empty=setup([adapter("empty",async()=>({hits:[],nextProviderCursor:null,appliedFilters:[],limitations:[]}))]);
 assert.equal((await empty.service.search(req,context(empty.clock))).status,"success");await empty.service.close();empty.repo.close();
});
test("partial/all failure and invalid pages are distinct from empty results",async()=>{
 const fail=adapter("bad",async()=>{throw "private credential must not leak";});
 const x=setup([adapter("ok"),fail]);const r=await x.service.search(req,context(x.clock));assert.equal(r.status,"partial");assert.equal(r.results.length,1);assert(!JSON.stringify(r).includes("credential"));await x.service.close();x.repo.close();
 const y=setup([fail]);assert.equal((await y.service.search(req,context(y.clock))).status,"failed");await y.service.close();y.repo.close();
 const z=setup([adapter("bad",async()=>({bad:true}) as any)]);const bad=await z.service.search(req,context(z.clock));assert.equal(bad.status,"failed");assert.equal(bad.errors[0].code,"INVALID_RESPONSE");await z.service.close();z.repo.close();
});
test("invalid hits are skipped, URL tracking removed and identity parameters preserved",async()=>{
 const x=setup([adapter("a",async()=>({hits:[{...hit(),url:"javascript:alert(1)"},{...hit(2),url:"https://example.com/path?id=2&utm_source=x#hash"}],nextProviderCursor:null,appliedFilters:[],limitations:[]}))]);
 const r=await x.service.search(req,context(x.clock));assert.equal(r.status,"partial");assert.equal(r.results.length,1);assert.equal(r.results[0].url,"https://example.com/path?id=2");assert(r.errors.some(e=>e.code==="INVALID_HIT"));await x.service.close();x.repo.close();
 assert.throws(()=>canonicalUrl("https://user:secret@example.com"));assert.notEqual(canonicalUrl("https://example.com/?id=1"),canonicalUrl("https://example.com/?id=2"));
});
test("cross-channel dedup and ranking do not depend on completion order",async()=>{
 async function run(reverse:boolean){
  const clock=new FakeClock(),repo=createSearchRepository(":memory:",{now:clock.now});let resolve!:()=>void;
  const wait=new Promise<void>(r=>resolve=r);
  const make=(name:string,slow:boolean)=>adapter(name,async()=>{if(slow)await wait;return {hits:[hit(1),hit(2)],nextProviderCursor:null,appliedFilters:[],limitations:[]};});
  const service=createSearchService({repository:repo,clock,adapters:[make("a",reverse),make("b",!reverse)]});const p=service.search(req,context(clock));await flush();resolve();const r=await p;await service.close();repo.close();return r;
 }
 const a=await run(false),b=await run(true);assert.equal(a.results.length,2);assert.deepEqual(a.results.map(r=>[r.url,r.channels]),b.results.map(r=>[r.url,r.channels]));assert.deepEqual(a.results[0].channels,["a","b"]);
});
test("snapshot pages are disjoint, scope-bound, stable after reopen and do not query providers",async t=>{
 const dir=mkdtempSync(join(tmpdir(),"search-service-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,"db.sqlite");const clock=new FakeClock();let calls=0;
 const a=adapter("a",async()=>{calls++;return {hits:[hit(1),hit(2),hit(3)],nextProviderCursor:null,appliedFilters:[],limitations:[]};});
 let repo=createSearchRepository(path,{now:clock.now}),service=createSearchService({repository:repo,clock,adapters:[a]});
 const request={...req,limit:1};const first=await service.search(request,context(clock));assert(first.next_cursor);assert.equal(first.results.length,1);await service.close();repo.close();
 repo=createSearchRepository(path,{now:clock.now});service=createSearchService({repository:repo,clock,adapters:[a]});
 await assert.rejects(service.search({...request,cursor:first.next_cursor},context(clock,"other")),/INVALID_CURSOR/);
 await assert.rejects(service.search({...request,keyword:"changed",cursor:first.next_cursor},context(clock)),/INVALID_CURSOR/);
 const second=await service.search({...request,cursor:first.next_cursor},context(clock));const repeat=await service.search({...request,cursor:first.next_cursor},context(clock));assert.deepEqual(second.results,repeat.results);
 const third=await service.search({...request,cursor:second.next_cursor!},context(clock));assert.equal(third.next_cursor,null);assert.equal(third.truncated,false);assert.equal(new Set([...first.results,...second.results,...third.results].map(r=>r.result_id)).size,3);assert.equal(calls,1);
 await clock.tick(1800001);await assert.rejects(service.search({...request,cursor:first.next_cursor},context(clock)),/INVALID_CURSOR/);await service.close();repo.close();
});
test("UTF-8 byte budget creates pages instead of dropping retrieved hits",async()=>{
 const a=adapter("a",async()=>({hits:Array.from({length:8},(_,i)=>({...hit(i+1),snippet:"中".repeat(1200)})),nextProviderCursor:null,appliedFilters:[],limitations:[]}));
 const x=setup([a],{maxBytes:7000});let response=await x.service.search(req,context(x.clock)),count=0;
 do {assert(Buffer.byteLength(JSON.stringify(response))<=7000);count+=response.results.length;if(!response.next_cursor)break;response=await x.service.search({...req,cursor:response.next_cursor},context(x.clock));}while(true);
 assert.equal(count,8);await x.service.close();x.repo.close();
});
test("provider pagination is bounded and repeated cursor reported",async()=>{
 let calls=0;const x=setup([adapter("a",async()=>{calls++;return {hits:[hit(calls)],nextProviderCursor:"same",appliedFilters:[],limitations:[]};})]);const r=await x.service.search(req,context(x.clock));assert.equal(calls,2);assert.equal(r.results.length,2);assert(r.errors.some(e=>e.code==="REPEATED_PROVIDER_CURSOR"));assert.equal(r.truncated,true);assert.equal(r.next_cursor,null);await x.service.close();x.repo.close();
});
test("pre-cancel does not call providers; mid-cancel records cancelled and closes idempotently",async()=>{
 const clock=new FakeClock();let count=0;const repo=createSearchRepository(":memory:",{now:clock.now});
 const service=createSearchService({repository:repo,clock,adapters:[adapter("a",async(_q,c)=>{count++;await clock.sleep(10000,c.signal);return {hits:[],nextProviderCursor:null,appliedFilters:[],limitations:[]};})]});
 const c=new AbortController();c.abort(new DOMException("cancel","AbortError"));await assert.rejects(service.search(req,{...context(clock),signal:c.signal}),{name:"AbortError"});assert.equal(count,0);
 const running=assert.rejects(service.search(req,context(clock)),{name:"AbortError"});await flush();const close=service.close();assert.equal(close,service.close());await running;await close;assert.equal(count,1);assert.equal(clock.sleepers.size,0);await assert.rejects(service.search(req,context(clock)),/CLOSED/);repo.close();
});
test("overall deadline returns a timeout failure with room to persist",async()=>{
 const x=setup([adapter("a",async(_q,c)=>{await x.clock.sleep(10000,c.signal);return {hits:[],nextProviderCursor:null,appliedFilters:[],limitations:[]};})],{totalTimeoutMs:1000});
 const p=x.service.search(req,context(x.clock));await flush();await x.clock.tick(900);const r=await p;assert.equal(r.status,"failed");assert.equal(r.errors[0].code,"TIMEOUT");await x.service.close();x.repo.close();
});
test("storage failure is explicit, begin failure prevents provider work, completion rollback is signalled",async()=>{
 for(const method of ["beginRun","completeRun"] as const){
  const x=setup([]);await x.service.close();let calls=0;
  const broken=new Proxy(x.repo,{get(target,key){if(key===method)return ()=>{throw new Error("injected");};return Reflect.get(target,key);}}) as SearchRepository;
  const service=createSearchService({repository:broken,clock:x.clock,adapters:[adapter("a",async()=>{calls++;return {hits:[],nextProviderCursor:null,appliedFilters:[],limitations:[]};})]});
  await assert.rejects(service.search(req,context(x.clock)),/SEARCH_STORAGE_ERROR/);assert.equal(calls,method==="beginRun"?0:1);
  await service.close();x.repo.close();
 }
});

test("cursor request object property order is irrelevant",async()=>{
 const x=setup([adapter("a",async()=>({hits:[hit(1),hit(2)],nextProviderCursor:null,appliedFilters:[],limitations:[]}))]);
 const first=await x.service.search({keyword:"展览",limit:1,mode:"external"},context(x.clock));
 const second=await x.service.search({mode:"external",limit:1,keyword:"展览",cursor:first.next_cursor!},context(x.clock));
 assert.equal(second.results.length,1);await x.service.close();x.repo.close();
});
test("corrupt saved snapshot is surfaced as storage failure",async()=>{
 const clock=new FakeClock(),repo=createSearchRepository(":memory:",{now:clock.now});
 const broken=new Proxy(repo,{get(target,key){if(key==="resolveCursor")return ()=>{throw new SyntaxError("corrupt JSON");};return Reflect.get(target,key);}}) as SearchRepository;
 const service=createSearchService({repository:broken,clock,adapters:[]});
 await assert.rejects(service.search({...req,cursor:"r.fake"},context(clock)),/SEARCH_STORAGE_ERROR/);await service.close();repo.close();
});
test("identity conflicts preserve good hits and do not publish an event",async()=>{
 const clock=new FakeClock(),repo=createSearchRepository(":memory:",{now:clock.now});let pass=0;
 const a=adapter("a",async()=>({hits:pass++===0?[hit(1),{...hit(2),platformContentId:"b"}]:[{...hit(1),platformContentId:"b"},hit(3)],nextProviderCursor:null,appliedFilters:[],limitations:[]}));
 const service=createSearchService({repository:repo,clock,adapters:[a]});await service.search(req,context(clock));
 const r=await service.search(req,context(clock));assert.equal(r.status,"partial");assert(r.errors.some(e=>e.code==="IDENTITY_CONFLICT"));assert.equal(r.results.length,1);assert.equal(r.results[0].url,"https://example.com/3");await service.close();repo.close();
});
test("response budget failure leaves no partial document transaction",async()=>{
 const x=setup([adapter("a")],{maxBytes:20});await assert.rejects(x.service.search(req,context(x.clock)),/RESPONSE_TOO_LARGE/);await x.service.close();x.repo.close();
});
test("bounded provider pages disclose omitted upstream results",async()=>{
 let calls=0;const x=setup([adapter("a",async()=>({hits:[hit(++calls)],nextProviderCursor:`page-${calls}`,appliedFilters:[],limitations:[]}))]);
 const r=await x.service.search(req,context(x.clock));assert.equal(calls,2);assert.equal(r.truncated,true);assert.equal(r.next_cursor,null);assert(r.coverage[0].limitations.includes("upstream_truncated"));await x.service.close();x.repo.close();
});

test("failure to record audit terminal state does not hide original storage error",async()=>{
 const x=setup([]);await x.service.close();
 const repo=new Proxy(x.repo,{get(target,key){if(key==="completeRun"||key==="failRun")return ()=>{throw new Error("injected audit failure");};return Reflect.get(target,key);}}) as SearchRepository;
 const service=createSearchService({repository:repo,clock:x.clock,adapters:[adapter("a")]});await assert.rejects(service.search(req,context(x.clock)),/SEARCH_STORAGE_ERROR/);await service.close();x.repo.close();
});

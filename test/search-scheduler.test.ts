import {test} from "node:test";
import assert from "node:assert/strict";
import {Scheduler,deadline} from "../src/search/scheduler.ts";
import {FakeClock,flush,adapter,context,query,ChannelError} from "./search-fixture.ts";
test("global and per-channel caps apply across simultaneous searches",async()=>{
 const clock=new FakeClock(),s=new Scheduler(clock,2),releases:(()=>void)[]=[];
 let active=0,peak=0,aActive=0,aPeak=0;
 const fn=(isA:boolean)=>async()=>{active++;peak=Math.max(peak,active);if(isA){aActive++;aPeak=Math.max(aPeak,aActive);}await new Promise<void>(r=>releases.push(r));active--;if(isA)aActive--;return {hits:[],nextProviderCursor:null,appliedFilters:[],limitations:[]};};
 const a=adapter("a",fn(true)),b=adapter("b",fn(false));
 const work=[s.page(a,query(),context(clock)),s.page(a,query(),context(clock)),s.page(b,query(),context(clock))];
 await flush();assert.equal(releases.length,2);assert.equal(peak,2);assert.equal(aPeak,1);
 releases.shift()!();await flush();assert.equal(releases.length,2);for(const release of releases)release();await Promise.all(work);await s.drain();
});
test("retry once after backoff, respect Retry-After and never retry auth",async()=>{
 const clock=new FakeClock(),s=new Scheduler(clock);let calls=0;
 const a=adapter("a",async()=>{calls++;if(calls===1)throw new ChannelError("RATE_LIMITED",500);return {hits:[],nextProviderCursor:null,appliedFilters:[],limitations:[]};});
 const p=s.page(a,query(),context(clock));await flush();await clock.tick(499);assert.equal(calls,1);await clock.tick(1);await p;assert.equal(calls,2);
 const auth=adapter("auth",async()=>{throw new ChannelError("AUTH_FAILED");});await assert.rejects(s.page(auth,query(),context(clock)),/AUTH_FAILED/);
});
test("timeouts retain slot for non-cooperative adapters and discard late results",async()=>{
 const clock=new FakeClock(),s=new Scheduler(clock,1,100);let finish!:()=>void,calls=0;
 const a=adapter("a",async()=>{calls++;await new Promise<void>(r=>finish=r);return {hits:[],nextProviderCursor:null,appliedFilters:[],limitations:[]};});
 const c=context(clock);c.deadlineAt=clock.now()+150;
 const first=assert.rejects(s.page(a,query(),c),/TIMEOUT/);await flush();await clock.tick(100);await first;
 const parent=new AbortController();const bound=deadline(clock,clock.now()+20,parent.signal);
 const second=assert.rejects(s.page(a,query(),{...context(clock),signal:bound.signal}),/TIMEOUT/);await flush();await clock.tick(20);await second;assert.equal(calls,1);
 finish();await s.drain();bound.dispose();assert.equal(clock.sleepers.size,0);
});
test("parent cancellation removes queued work and active request propagates signal",async()=>{
 const clock=new FakeClock(),s=new Scheduler(clock,1);let calls=0;
 const a=adapter("a",async(_q,c)=>{calls++;await clock.sleep(1000,c.signal);return {hits:[],nextProviderCursor:null,appliedFilters:[],limitations:[]};});
 const c=new AbortController(),ctx={...context(clock),signal:c.signal};
 const p=assert.rejects(s.page(a,query(),ctx));const q=assert.rejects(s.page(a,query(),ctx));await flush();c.abort(new DOMException("cancel","AbortError"));await Promise.all([p,q]);await s.drain();assert.equal(calls,1);assert.equal(clock.sleepers.size,0);
});

test("transient failure is retried at most once",async()=>{
 const clock=new FakeClock(),s=new Scheduler(clock);let count=0;
 const a=adapter("a",async()=>{count++;throw new ChannelError("NETWORK_ERROR");});
 const p=assert.rejects(s.page(a,query(),context(clock)),/NETWORK_ERROR/);await flush();await clock.tick(200);await p;assert.equal(count,2);await s.drain();assert.equal(clock.sleepers.size,0);
});

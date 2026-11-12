import { ChannelError } from "../src/search/types.ts";
import type { Clock, SearchAdapter, SearchHit, Context, AdapterQuery } from "../src/search/types.ts";
export class FakeClock implements Clock {
 time=Date.parse("2026-11-12T00:00:00Z");
 sleepers=new Set<{at:number;resolve:()=>void;reject:(e:unknown)=>void;signal:AbortSignal;stop:()=>void}>();
 now=()=>this.time;
 sleep=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{
   signal.throwIfAborted();
   const entry={at:this.time+ms,resolve:()=>{signal.removeEventListener("abort",entry.stop);resolve();},reject,signal,stop:()=>{this.sleepers.delete(entry);reject(signal.reason);}};
   signal.addEventListener("abort",entry.stop,{once:true});this.sleepers.add(entry);
 });
 async tick(ms:number){this.time+=ms;for(const x of [...this.sleepers])if(x.at<=this.time){this.sleepers.delete(x);x.resolve();}await flush();}
}
export async function flush(){for(let n=0;n<40;n++)await Promise.resolve();}
export function hit(n=1):SearchHit{return {platform:"web",platformContentId:null,url:`https://example.com/${n}`,title:`测试 ${n}`,snippet:"离线假渠道",author:null,publishedAt:null,retrievedAt:"2026-11-12T00:00:00Z",rank:n};}
export function adapter(channel:string,fn?:SearchAdapter["search"]):SearchAdapter{return {capabilities:{channel,platforms:["web"],filters:["keyword"],pagination:true,maxPageSize:20,maxConcurrency:1,state:"enabled"},search:fn??(async()=>({hits:[hit()],nextProviderCursor:null,appliedFilters:["keyword"],limitations:[]}))};}
export function context(clock:Clock,scopeKey="s"):Context{return {scopeKey,signal:new AbortController().signal,deadlineAt:clock.now()+12000};}
export function query():AdapterQuery{return {city:"西安市",platforms:["web"],limit:20};}
export { ChannelError };

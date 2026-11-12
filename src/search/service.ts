import { createHash, randomUUID } from "node:crypto";
import { normalizeRequest, assertResponse } from "./contract.ts";
import { Scheduler, deadline, realClock, abortError } from "./scheduler.ts";
import { canonicalUrl, validHit, clip } from "./normalize.ts";
import { makeSnapshot, snapshotPage } from "./snapshot.ts";
import { ChannelError, SearchRequestError, SearchStorageError } from "./types.ts";
import type { Context, Clock, SearchAdapter, NormalRequest, SearchResponse, Coverage, CollectedHit, SearchErrorView, DocumentResult, AdapterPage } from "./types.ts";
import type { SearchRepository, StoredHit, Snapshot } from "./repository.ts";
export interface SearchOptions { repository: SearchRepository; adapters: SearchAdapter[]; clock?: Clock; concurrency?: number; channelTimeoutMs?: number; totalTimeoutMs?: number; maxBytes?: number; id?: () => string; ownsRepository?: boolean; }
const retryable = (code: string) => ["TIMEOUT","RATE_LIMITED","NETWORK_ERROR"].includes(code);
function errorCode(e: unknown): string { return e instanceof ChannelError && ["TIMEOUT","RATE_LIMITED","NETWORK_ERROR","AUTH_FAILED","UPSTREAM_ERROR","UNSUPPORTED_FILTER","INVALID_RESPONSE"].includes(e.code) ? e.code : "UPSTREAM_ERROR"; }
function validPage(p: AdapterPage, limit: number): boolean {
 return !!p && Array.isArray(p.hits) && p.hits.length<=limit && (p.nextProviderCursor===null || typeof p.nextProviderCursor==="string" && p.nextProviderCursor.length>0 && p.nextProviderCursor.length<=8192) && [p.appliedFilters,p.limitations].every(a=>Array.isArray(a) && a.length<=20 && a.every(s=>typeof s==="string" && s.length<=200));
}
export function createSearchService(options: SearchOptions) {
 const {repository:repo}=options, clock=options.clock??realClock, adapters=options.adapters;
 if(adapters.length>32 || new Set(adapters.map(a=>a.capabilities.channel)).size!==adapters.length || adapters.some(a=>!a.capabilities.channel || a.capabilities.channel.length>80 || !Number.isInteger(a.capabilities.maxConcurrency) || a.capabilities.maxConcurrency<1 || !Number.isInteger(a.capabilities.maxPageSize) || a.capabilities.maxPageSize<1)) throw new Error("INVALID_CHANNEL_REGISTRY");
 const scheduler=new Scheduler(clock,options.concurrency??4,options.channelTimeoutMs??5000);
 const total=options.totalTimeoutMs??12000; if(total<=0 || !Number.isFinite(total)) throw new Error("INVALID_TIMEOUT");
 let closed=false, closing:Promise<void>|undefined;
 const calls=new Map<AbortController,Promise<unknown>>();
 const storage=<T>(fn:()=>T):T=>{try{return fn();}catch(e){if(e instanceof SearchRequestError)throw e;throw new SearchStorageError({cause:e});}};
 const keyOf=(request:NormalRequest)=>createHash("sha256").update(JSON.stringify({...request,cursor:undefined})).digest("hex");
 async function run(value:unknown, context:Context):Promise<SearchResponse> {
   const request=normalizeRequest(value), key=keyOf(request);
   if(!context.scopeKey || !Number.isFinite(context.deadlineAt)) throw new SearchRequestError();
   context.signal.throwIfAborted(); if(context.deadlineAt<=clock.now()) throw new ChannelError("TIMEOUT");
   const finalDeadline=Math.min(context.deadlineAt,clock.now()+total);
   const page=(snapshot:Snapshot,offset:number):SearchResponse=>{
     const prior=snapshot.pageEnds.indexOf(offset);
     const index=offset===0?0:prior<0?-1:prior+1;
     if(index<0 || index>=snapshot.pageEnds.length) throw new SearchRequestError("INVALID_CURSOR");
     const end=snapshot.pageEnds[index];
     const cursor=end<snapshot.response.results.length ? storage(()=>repo.issueCursor(snapshot.response.search_id,context.scopeKey,end,clock.now(),finalDeadline)):null;
     const response=snapshotPage(snapshot,offset,cursor); response.effective_request=request; assertResponse(response); return response;
   };
   if(request.cursor) { const found=storage(()=>repo.resolveCursor(request.cursor!,context.scopeKey,key,clock.now(),finalDeadline)); return page(found.snapshot,found.offset); }
   const id=(options.id??randomUUID)();
   if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw new Error("INVALID_SEARCH_ID");
   storage(()=>repo.beginRun(id,context.scopeKey,request,key,clock.now(),finalDeadline));
   const work=deadline(clock,finalDeadline-Math.min(100,total/10),context.signal);
   const errors:SearchErrorView[]=[], coverage:Coverage[]=[], hits:CollectedHit[]=[];
   let upstreamTruncated=false;
   const error=(channel:string|null,code:string)=>{ if(!errors.some(e=>e.channel===channel&&e.code===code)) errors.push({channel,code,retryable:retryable(code)}); };
   const unsupported=(platform:string,code:string)=>{coverage.push({platform,channel:platform==="local"?"local":"unavailable",mode:platform==="local"?"local":"platform_search",status:"unsupported",count:0,cache_age_seconds:null,applied_filters:[],limitations:[code]});error(platform==="local"?"local":null,code);};
   try {
     if(request.mode!=="external") unsupported("local","LOCAL_NOT_IMPLEMENTED");
     const enabled=request.mode==="local"?[]:adapters.filter(a=>a.capabilities.state==="enabled" && (!request.platforms || request.platforms.some(p=>a.capabilities.platforms.includes(p))));
     if(request.mode!=="local") for(const platform of request.platforms??[]) if(!enabled.some(a=>a.capabilities.platforms.includes(platform))) unsupported(platform,"PLATFORM_UNSUPPORTED");
     if(!enabled.length) error(null,"NO_CHANNEL_AVAILABLE");
     const quota=Math.floor(200/Math.max(1,enabled.length));
     await Promise.all(enabled.map(async (adapter,priority)=>{
       const c=adapter.capabilities, platforms=request.platforms?c.platforms.filter(p=>request.platforms!.includes(p)):c.platforms;
       const rows=platforms.map(platform=>({platform,channel:c.channel,mode:platform==="web"?"web_search":"platform_search",status:"success",count:0,cache_age_seconds:null,applied_filters:[],limitations:[]} as Coverage));
       coverage.push(...rows);
       let cursor:string|undefined, used=0; const seen=new Set<string>();
       try {
         for(let n=0;n<2;n++) {
           const limit=Math.min(20,c.maxPageSize,quota-used);
           if(limit<=0) {upstreamTruncated=true;for(const row of rows)row.limitations.push("upstream_truncated");break;}
           const query={date:request.date,category:request.category,keyword:request.keyword,city:"西安市" as const,platforms,limit,providerCursor:cursor};
           const result=await scheduler.page(adapter,query,{...context,signal:work.signal,deadlineAt:finalDeadline-Math.min(100,total/10)});
           work.signal.throwIfAborted();
           if(!validPage(result,limit)) throw new ChannelError("INVALID_RESPONSE");
           used+=result.hits.length;
           for(const row of rows) { row.applied_filters=[...new Set([...row.applied_filters,...result.appliedFilters])]; row.limitations=[...new Set([...row.limitations,...result.limitations,...["date","category","keyword"].filter(k=>request[k as keyof NormalRequest]!==undefined&&!result.appliedFilters.includes(k)).map(k=>`${k}_not_supported`)])]; }
           for(const hit of result.hits) {
             try {
               if(!validHit(hit,platforms)) throw new Error();
               const normalized={...hit,url:canonicalUrl(hit.url),title:clip(hit.title,300),snippet:clip(hit.snippet,1000),author:hit.author===null?null:clip(hit.author,200)};
               if(hit.snippet!==normalized.snippet) for(const row of rows) if(row.platform===hit.platform)row.limitations.push("content_truncated");
               hits.push({hit:normalized,channel:c.channel,priority,query:JSON.stringify({date:request.date,category:request.category,keyword:request.keyword,city:"西安市"})});
               rows.find(row=>row.platform===hit.platform)!.count++;
             }catch {error(c.channel,"INVALID_HIT");}
           }
           if(!result.nextProviderCursor) break;
           if(seen.has(result.nextProviderCursor)) {error(c.channel,"REPEATED_PROVIDER_CURSOR"); upstreamTruncated=true;break;}
           seen.add(result.nextProviderCursor); cursor=result.nextProviderCursor;
           if(!c.pagination || n===1 || used>=quota) {upstreamTruncated=true;for(const row of rows)row.limitations.push("upstream_truncated");break;}
         }
       } catch(e) {
         if(context.signal.aborted) return;
         const code=errorCode(e); error(c.channel,code);
         for(const row of rows) row.status=code==="TIMEOUT"?"timeout":"error";
       }
     }));
     context.signal.throwIfAborted();
     if(upstreamTruncated) for(const row of coverage) if(row.status==="success")row.limitations=[...new Set([...row.limitations,"upstream_truncated"])];
     const build=(stored:StoredHit[],conflicts:number):Snapshot=>{
       if(conflicts)error(null,"IDENTITY_CONFLICT");
       const groups=new Map<string,StoredHit[]>();
       for(const item of stored){const group=groups.get(item.documentId)??[];group.push(item);groups.set(item.documentId,group);}
       const scored=[...groups.values()].map(group=>{
         group.sort((a,b)=>a.priority-b.priority||a.hit.rank-b.hit.rank||a.hit.url.localeCompare(b.hit.url));
         const channels=[...new Set(group.map(h=>h.channel))];
         const score=channels.reduce((v,c)=>v+1/(60+Math.min(...group.filter(h=>h.channel===c).map(h=>h.hit.rank))),0);
         return {group,channels,score};
       }).sort((a,b)=>b.score-a.score||a.group[0].priority-b.group[0].priority||a.group[0].hit.url.localeCompare(b.group[0].hit.url));
       const results:DocumentResult[]=scored.map(({group,channels})=>{const {hit:h,documentId}=group[0];return {kind:"document",result_id:documentId,document_id:documentId,platform:h.platform,title:h.title,url:h.url,snippet:h.snippet,author:h.author,published_at:h.publishedAt,retrieved_at:h.retrievedAt,channels,city_status:"unknown",date_status:"unknown",plannable:false,limitations:["facts_not_verified"],event:null};});
       const success=coverage.some(c=>c.status==="success")||results.length>0;
       const status=success?(errors.length?"partial":"success"):"failed";
       const response:SearchResponse={schema_version:"1.0",search_id:id,status,city:"西安市",timezone:"Asia/Shanghai",effective_request:request,results,coverage,partial:status==="partial",errors,truncated:upstreamTruncated,next_cursor:null};
       const snapshot=makeSnapshot(response,options.maxBytes);
       // Validate every public page before committing, including metadata-only responses.
       let offset=0;for(const end of snapshot.pageEnds){assertResponse(snapshotPage(snapshot,offset,end<results.length?"reserved":null));offset=end;}
       return snapshot;
     };
     const snapshot=storage(()=>repo.completeRun(id,hits,clock.now(),finalDeadline,build));
     return page(snapshot,0);
   } catch(e) {
     try { repo.failRun(id,context.signal.aborted?"cancelled":"failed",clock.now()); }catch{/* Original failure remains visible; failed audit cannot be guaranteed. */}
     if(context.signal.aborted)throw context.signal.reason??abortError();
     throw e;
   } finally {work.dispose();}
 }
 return {
   search(value:unknown,context:Context):Promise<SearchResponse> {
     if(closed)return Promise.reject(new Error("SEARCH_SERVICE_CLOSED"));
     const controller=new AbortController(); const stop=()=>controller.abort(context.signal.reason??abortError());
     if(context.signal.aborted)stop();else context.signal.addEventListener("abort",stop,{once:true});
     const promise=run(value,{...context,signal:controller.signal}).finally(()=>{context.signal.removeEventListener("abort",stop);calls.delete(controller);});
     calls.set(controller,promise);return promise;
   },
   close():Promise<void> {
     if(closing)return closing;closed=true;
     for(const c of calls.keys())c.abort(abortError());
     closing=(async()=>{await Promise.allSettled([...calls.values()]);await scheduler.drain();if(options.ownsRepository)repo.close();})();return closing;
   }
 };
}

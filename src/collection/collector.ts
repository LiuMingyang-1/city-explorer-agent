import type {CollectionRunConfig} from "./run-config.ts";
import type {ExtractionDocument} from "./extraction.ts";

export interface CollectedSource {engine:string;keyword:string;title:string;document:ExtractionDocument;}
export interface EngineContext {directory:string;now:()=>string;deadline?:number;}
export interface CollectionEngineAdapter {
  /** Total documents supported per run, not a claim of guaranteed results. */
  maxLimit:number;
  maxQueryLimit?:number;
  search(request:{keyword:string;limit:number},context:EngineContext):Promise<{sources:CollectedSource[];warnings:string[]}>;
}
export type CollectionEngineRegistry=ReadonlyMap<string,CollectionEngineAdapter>;
export interface CollectionJob {engine:string;keyword:string;limit:number;}
export function buildCollectionPlan(config:CollectionRunConfig,registry:CollectionEngineRegistry){
  const jobs:CollectionJob[]=[];
  for(const engine of config.engines.filter(e=>e.enabled)){
    const adapter=registry.get(engine.name);
    if(!adapter)throw new Error("UNREGISTERED_COLLECTION_ENGINE");
    if(engine.limit>adapter.maxLimit)throw new Error("COLLECTION_ENGINE_LIMIT_EXCEEDED");
    const words=engine.keywords??config.keywords;
    if(engine.limit<words.length)throw new Error("COLLECTION_LIMIT_BELOW_KEYWORD_COUNT");
    let remaining=engine.limit;
    for(let i=0;i<words.length&&remaining;i++){
      const limit=Math.ceil(remaining/(words.length-i));
      if(adapter.maxQueryLimit!==undefined&&limit>adapter.maxQueryLimit)throw new Error("COLLECTION_QUERY_LIMIT_EXCEEDED");
      jobs.push({engine:engine.name,keyword:words[i],limit});remaining-=limit;
    }
  }
  return {city:config.city,jobs,requested_documents:jobs.reduce((n,j)=>n+j.limit,0),processing:config.processing};
}
export const collectionError=(error:unknown)=>error instanceof Error&&/^[A-Z_]+(?::[A-Z_]+)?$/.test(error.message)?error.message:"COLLECTION_ENGINE_FAILED";

/** Serial bounded dispatch. A failed engine cannot erase another engine's results.
 * New engines only need a registered adapter; no engine-name switch lives here. */
export async function collectSources(config:CollectionRunConfig,registry:CollectionEngineRegistry,context:EngineContext){
  const plan=buildCollectionPlan(config,registry);
  const sources:CollectedSource[]=[],seen=new Set<string>(),duplicates:{engine:string;url:string}[]=[];
  const coverage:{engine:string;keyword:string;requested:number;retained:number;status:"success"|"partial"|"failed";warnings:string[];elapsed_ms:number}[]=[];
  for(const [index,job]of plan.jobs.entries()){
    if(context.deadline!==undefined&&Date.now()>=context.deadline){coverage.push({engine:job.engine,keyword:job.keyword,requested:job.limit,retained:0,status:"failed",warnings:["RUN_DEADLINE_REACHED"],elapsed_ms:0});continue;}
    const start=Date.now();
    try{
      const result=await registry.get(job.engine)!.search(job,{...context,directory:`${context.directory}/${job.engine}-${index+1}`});
      let retained=0;
      for(const source of result.sources.slice(0,job.limit)){
        // One official directory may describe multiple seed targets. Deduplicate
        // documents per target, not globally, when the task supplies target context.
        const seed=config.targets?.[job.keyword]?.seed_id;
        const key=seed?JSON.stringify([seed,source.document.url]):source.document.url;
        if(seen.has(key)){duplicates.push({engine:job.engine,url:source.document.url});continue;}
        seen.add(key);sources.push({...source,engine:job.engine,keyword:job.keyword});retained++;
      }
      const warnings=[...result.warnings];if(retained<job.limit)warnings.push("INSUFFICIENT_UNIQUE_RESULTS");
      coverage.push({engine:job.engine,keyword:job.keyword,requested:job.limit,retained,status:warnings.length?"partial":"success",warnings,elapsed_ms:Date.now()-start});
    }catch(error){coverage.push({engine:job.engine,keyword:job.keyword,requested:job.limit,retained:0,status:"failed",warnings:[collectionError(error)],elapsed_ms:Date.now()-start});}
  }
  const status=!sources.length?"failed":coverage.some(c=>c.status!=="success")?"partial":"success";
  return {status,sources,coverage,duplicates,plan};
}

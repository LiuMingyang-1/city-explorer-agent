import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdir,readFile,readdir} from "node:fs/promises";
import {join,resolve,dirname} from "node:path";
import {createPilotApi} from "./pilot-api.ts";
import type {ApiOptions} from "./pilot-api.ts";
import {documentsFrom} from "./pilot-extract.ts";
import {importMediaCrawlerJsonl} from "./mediacrawler.ts";
import type {CollectionEngineAdapter,CollectedSource} from "./collector.ts";
import type {CollectionEngineRegistry} from "./collector.ts";

/** The only built-in engine registration point. Disabled/unregistered engines
 * do not run. Adding an adapter does not change the dispatch loop. */
export function createDefaultCollectionEngines(options:{workspace:string;python:string;deepseekKey:string;record:ApiOptions["record"]}):CollectionEngineRegistry {
  return new Map([
    ["xiaohongshu",createXhsSourceAdapter(options)],
    ["deepseek",createDeepSeekSourceAdapter({deepseekKey:options.deepseekKey,record:options.record,searchLimit:10})],
  ]);
}

export function createDeepSeekSourceAdapter(options:ApiOptions):CollectionEngineAdapter {
  return {maxLimit:20,async search(request,context){
    const api=createPilotApi({...options,searchResultCount:request.limit});
    const result=await api.search("deepseek",request.keyword,"","");
    const docs=documentsFrom("deepseek",result,request.keyword).slice(0,request.limit);
    return {warnings:[],sources:docs.map(d=>({engine:"deepseek",keyword:request.keyword,title:d.title,document:{url:d.url,text:d.text.slice(0,30000),published_at:d.published_at&&Number.isFinite(Date.parse(d.published_at))?new Date(d.published_at).toISOString():null,fetched_at:context.now(),authority:"unverified" as const,content_scope:d.text.length>30000?"possibly_truncated" as const:d.content_kind==="content"?"exported_text" as const:"excerpt" as const,image_urls:[]}}))};
  }};
}
async function exportsIn(directory:string):Promise<string[]>{
  const results:string[]=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if(entry.isSymbolicLink())continue;
    const path=join(directory,entry.name);
    if(entry.isDirectory())results.push(...await exportsIn(path));
    else if(/^search_contents_.*\.jsonl$/.test(entry.name))results.push(path);
  }
  return results.sort();
}
export function createXhsSourceAdapter(options:{python:string;workspace:string;launch?:(executable:string,args:string[])=>Promise<unknown>}):CollectionEngineAdapter {
  const run=promisify(execFile);
  return {maxLimit:20,maxQueryLimit:5,async search(request,context){
    if(!Number.isInteger(request.limit)||request.limit<1||request.limit>5)throw new Error("COLLECTION_QUERY_LIMIT_EXCEEDED");
    // MediaCrawler creates the destination with exist_ok=False. Only create its
    // parent here; an existing destination must never be silently reused.
    await mkdir(dirname(context.directory),{recursive:true});
    try{
      const timeout=120;
      const args=[resolve(options.workspace,"scripts/mediacrawler-local.py"),"--platform","xhs","--keyword",request.keyword,"--limit",String(request.limit),"--timeout",String(timeout),"--output",resolve(context.directory)];
      if(options.launch)await options.launch(options.python,args);
      else await run(options.python,args,{cwd:options.workspace,windowsHide:true,timeout:(timeout+30)*1000,maxBuffer:2*1024*1024});
    }catch(error){const code=(error as any)?.code;throw new Error(code===3?"XHS_LOGIN_REQUIRED":code===4?"XHS_TIMEOUT":"XHS_SEARCH_FAILED");}
    const files=await exportsIn(context.directory);if(!files.length)throw new Error("XHS_EXPORT_MISSING");
    const sources:CollectedSource[]=[],warnings:string[]=[];
    for(const file of files){
      const imported=importMediaCrawlerJsonl("xhs",await readFile(file,"utf8"),context.now());
      if(imported.rejected.length)warnings.push("XHS_IMPORT_REJECTED_ROWS");
      for(const d of imported.documents)sources.push({engine:"xiaohongshu",keyword:request.keyword,title:d.title,document:{url:d.url,text:d.text.slice(0,30000),published_at:d.published_at,updated_at:d.updated_at,fetched_at:d.fetched_at,authority:"unverified",content_scope:d.text.length>30000?"possibly_truncated":d.content_scope,image_urls:d.image_urls}});
    }
    return {sources:sources.slice(0,request.limit),warnings};
  }};
}

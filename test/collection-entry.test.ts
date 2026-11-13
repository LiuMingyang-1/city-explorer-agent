import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,existsSync,rmSync,mkdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {parseCollectionRunConfig} from "../src/collection/run-config.ts";
import {buildCollectionPlan,collectSources} from "../src/collection/collector.ts";
import type {CollectionEngineAdapter,CollectedSource} from "../src/collection/collector.ts";
import {createDeepSeekSourceAdapter,createXhsSourceAdapter} from "../src/collection/source-adapters.ts";

const base=()=>({keywords:["西交创新港"],engines:[{name:"xiaohongshu",limit:5},{name:"deepseek",limit:5}],output_dir:".local-data/unit-output"});
const now=()=>"2026-11-13T01:00:00Z";
const source=(id:string):CollectedSource=>({engine:"fake",keyword:"fake",title:id,document:{url:`https://www.sxhm.com/${id}`,text:`${id}正文`,published_at:null,fetched_at:now(),authority:"unverified",content_scope:"exported_text",image_urls:[]}});
const adapter=(prefix:string,maxLimit=20):CollectionEngineAdapter=>({maxLimit,search:async r=>({sources:Array.from({length:r.limit},(_,i)=>source(`${prefix}-${r.keyword}-${i}`)),warnings:[]})});

test("list-based config applies defaults without mutating input and gives five results per engine",()=>{
  const original=base(),copy=structuredClone(original),config=parseCollectionRunConfig(original);
  const plan=buildCollectionPlan(config,new Map([["xiaohongshu",adapter("x",5)],["deepseek",adapter("d")]]));
  assert.deepEqual(original,copy);assert.equal(plan.requested_documents,10);assert.deepEqual(plan.jobs.map(j=>j.limit),[5,5]);
  assert.equal(config.processing.attraction_duplicate_meters,10);assert.equal(config.processing.enabled,true);
});
test("XHS supports twenty per run as four five-document queries, never one twenty-document query",()=>{
  const engine=createXhsSourceAdapter({workspace:process.cwd(),python:"unused"});
  const config=parseCollectionRunConfig({...base(),engines:[{name:"xiaohongshu",limit:20,keywords:["西安展览","西安市集","西安亲子","西安新公园"]}]});
  assert.deepEqual(buildCollectionPlan(config,new Map([["xiaohongshu",engine]])).jobs.map(j=>j.limit),[5,5,5,5]);
  const wrong=parseCollectionRunConfig({...base(),engines:[{name:"xiaohongshu",limit:20}]});
  assert.throws(()=>buildCollectionPlan(wrong,new Map([["xiaohongshu",engine]])),/COLLECTION_QUERY_LIMIT_EXCEEDED/);
});

test("per-engine keywords override common keywords and limits apply across all queries",()=>{
  const config=parseCollectionRunConfig({...base(),engines:[{name:"deepseek",limit:5,keywords:["西安公园","西安展览"]}]});
  const plan=buildCollectionPlan(config,new Map([["deepseek",adapter("d")]]));
  assert.deepEqual(plan.jobs,[{engine:"deepseek",keyword:"西安公园",limit:3},{engine:"deepseek",keyword:"西安展览",limit:2}]);
});

test("disabled future engines do not need adapters; new registered engines need no dispatcher changes",async()=>{
  const config=parseCollectionRunConfig({engines:[{name:"new-engine",keywords:["西安"],limit:2},{name:"future",enabled:false}],output_dir:".local-data/out"});
  const result=await collectSources(config,new Map([["new-engine",adapter("new")]]),{directory:".local-data/out",now});
  assert.equal(result.status,"success");assert.equal(result.sources.length,2);assert(result.sources.every(s=>s.engine==="new-engine"));
});

test("invalid configuration, unknown engines and unsupported XHS limits fail before searching",()=>{
  for(const value of [
    {...base(),api_key:"must-not-be-a-config-field"},
    {...base(),engines:[{name:"deepseek"},{name:"deepseek"}]},
    {...base(),engines:[{name:"deepseek",enabled:false}]},
    {...base(),keywords:[" "]},
    {...base(),keywords:undefined},
    {...base(),base_date:"2026-02-30"},
    {...base(),publish_root:".local-data/pub",processing:{enabled:false}},
  ])assert.throws(()=>parseCollectionRunConfig(value));
  assert.throws(()=>buildCollectionPlan(parseCollectionRunConfig(base()),new Map()),/UNREGISTERED_COLLECTION_ENGINE/);
  const large=parseCollectionRunConfig({...base(),engines:[{name:"xiaohongshu",limit:6}]});
  assert.throws(()=>buildCollectionPlan(large,new Map([["xiaohongshu",adapter("x",5)]])),/LIMIT_EXCEEDED/);
  const tooManyWords=parseCollectionRunConfig({...base(),engines:[{name:"deepseek",limit:1,keywords:["西安公园","西安展览"]}]});
  assert.throws(()=>buildCollectionPlan(tooManyWords,new Map([["deepseek",adapter("d")]])),/BELOW_KEYWORD_COUNT/);
});

test("one engine failure preserves another engine's results and redacts raw exceptions",async()=>{
  const config=parseCollectionRunConfig(base());
  const result=await collectSources(config,new Map([["xiaohongshu",{maxLimit:5,search:async()=>{throw new Error("credentials should never be printed");}}],["deepseek",adapter("web")]]),{directory:".local-data/out",now});
  assert.equal(result.status,"partial");assert.equal(result.sources.length,5);assert.equal(result.coverage[0].warnings[0],"COLLECTION_ENGINE_FAILED");assert(!JSON.stringify(result).includes("credentials"));
});

test("duplicate URLs across engines are processed once and insufficient coverage is explicit",async()=>{
  const config=parseCollectionRunConfig({...base(),engines:[{name:"a",limit:1},{name:"b",limit:1}]});
  const same:CollectionEngineAdapter={maxLimit:5,search:async()=>({sources:[source("same")],warnings:[]})};
  const result=await collectSources(config,new Map([["a",same],["b",same]]),{directory:".local-data/out",now});
  assert.equal(result.sources.length,1);assert.equal(result.duplicates.length,1);assert.equal(result.status,"partial");assert(result.coverage[1].warnings.includes("INSUFFICIENT_UNIQUE_RESULTS"));
});

test("empty engines report failure rather than claiming successful coverage",async()=>{
  const config=parseCollectionRunConfig({...base(),engines:[{name:"deepseek",limit:5}]});
  const result=await collectSources(config,new Map([["deepseek",{maxLimit:20,search:async()=>({sources:[],warnings:[]})}]]),{directory:".local-data/out",now});assert.equal(result.status,"failed");
});

test("DeepSeek adapter receives requested count and returns normalized source documents",async()=>{
  const engine=createDeepSeekSourceAdapter({deepseekKey:"test",record:()=>{},fetch:async(_url,init)=>{
    assert.deepEqual(JSON.parse(String(init?.body)),{query:"西交创新港",count:5,need_content:true});
    return Response.json({results:[{url:"https://www.xjtu.edu.cn/a",title:"创新港",content:"校园介绍",published_at:"2026-11-12"}]});
  }});
  const result=await engine.search({keyword:"西交创新港",limit:5},{directory:".local-data/out",now});
  assert.equal(result.sources.length,1);assert.equal(result.sources[0].document.authority,"unverified");assert.equal(result.sources[0].document.fetched_at,now());
});

test("CLI dry-run validates a full plan without credentials, output directories or network calls",()=>{
  const folder=mkdtempSync(join(tmpdir(),"collect-entry-"));const output=`.local-data/dry-run-${randomUUID()}`;
  try{
    const file=join(folder,"config.json");writeFileSync(file,JSON.stringify({...base(),output_dir:output}));
    const raw=execFileSync(process.execPath,["scripts/collect.ts","--config",file],{cwd:process.cwd(),encoding:"utf8",windowsHide:true});
    const result=JSON.parse(raw);assert.equal(result.mode,"dry-run");assert.equal(result.api_calls,0);assert.equal(result.plan.requested_documents,10);assert.equal(existsSync(output),false);
  }finally{rmSync(folder,{recursive:true,force:true});}
});

test("XHS adapter leaves destination creation to the crawler and imports its real export format",async()=>{
  const folder=mkdtempSync(join(tmpdir(),"xhs-adapter-")),destination=join(folder,"sources","job");
  try{
    const engine=createXhsSourceAdapter({python:"local-python",workspace:process.cwd(),launch:async(executable,args)=>{
      assert.equal(executable,"local-python");assert.equal(existsSync(destination),false);
      assert.equal(args[args.indexOf("--keyword")+1],"西交创新港");assert.equal(args[args.indexOf("--limit")+1],"1");
      mkdirSync(join(destination,"xhs","jsonl"),{recursive:true});
      writeFileSync(join(destination,"xhs","jsonl","search_contents_2026-11-13.jsonl"),JSON.stringify({note_id:"test123",title:"校园秋景",desc:"创新港秋景介绍",time:Date.parse(now())})+"\n");
    }});
    const result=await engine.search({keyword:"西交创新港",limit:1},{directory:destination,now});
    assert.equal(result.sources.length,1);assert.equal(result.sources[0].document.url,"https://www.xiaohongshu.com/explore/test123");assert.deepEqual(result.warnings,[]);
  }finally{rmSync(folder,{recursive:true,force:true});}
});

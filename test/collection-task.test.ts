import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync,mkdirSync,writeFileSync,existsSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {execFileSync,spawnSync} from "node:child_process";
import {parseTaskConfig,compileTask,initialRotation,dueDate} from "../src/collection/task-plan.ts";
import type {KeywordLibrary,SeedList,TaskConfig} from "../src/collection/task-plan.ts";
import {runTask} from "../src/collection/task-runner.ts";
import {extractActivities} from "../src/collection/extraction.ts";
import type {Extractor} from "../src/collection/extraction.ts";
import {processCollection} from "../src/collection/pipeline.ts";
import {prepareCollection} from "../src/collection/preparation.ts";
import {publishRelease,inspectRelease} from "../src/collection/releases.ts";
import {DatabaseSync} from "node:sqlite";
import {collectSources} from "../src/collection/collector.ts";
import {buildCollectionPlan} from "../src/collection/collector.ts";
import {createDefaultCollectionEngines} from "../src/collection/source-adapters.ts";
import {locatedFixture} from "./collection-downstream-fixture.ts";
const read=(path:string)=>JSON.parse(readFileSync(path,"utf8"));
const cfg=()=>parseTaskConfig(read("configs/collection.scheduled.json"));
const boot=()=>parseTaskConfig(read("configs/collection.bootstrap.json"));
const lib=()=>read("configs/collection.keyword-library.json") as KeywordLibrary;
const seeds=()=>read("configs/xian-attraction-seeds.json") as SeedList;
const friday="2026-11-13";
function fixture(c=cfg()){
  const root=`.local-data/task-test-${randomUUID()}`;mkdirSync(root,{recursive:true});c.state_file=`${root}/state.json`;c.collection_defaults.output_dir=`${root}/runs`;c.collection_defaults.publish_root=`${root}/release`;c.collection_defaults.database_path=`${root}/events.db`;
  const file=`${root}/config.json`;writeFileSync(file,JSON.stringify(c));
  return {root,file,c,clean:()=>rmSync(root,{recursive:true,force:true})};
}
test("runtime task configurations and 247 targets are valid, including innovation harbor",()=>{
  assert.equal(cfg().schedule.enabled,false);const s=seeds();assert.equal(s.targets.length,247);assert(s.targets.some(t=>/创新港/.test(t.name)));
  const plan=compileTask(boot(),friday,initialRotation(),undefined,s);assert.equal(plan.seed_ids.length,5);assert.equal(Object.keys(plan.config.targets!).length,5);assert.equal(plan.config.engines[0].limit,10);
});
test("all configuration fields, modes, nested budgets and source lists are validated",()=>{
  for(const mutate of [
    (c:any)=>c.api_key="no",(c:any)=>c.timezone="UTC",(c:any)=>c.schedule.at="24:00",(c:any)=>c.schedule.weekdays=[0],
    (c:any)=>c.engines.push(c.engines[0]),(c:any)=>c.engines.forEach((e:any)=>e.enabled=false),
    (c:any)=>c.collection_defaults.budgets.model_requests=0,(c:any)=>c.collection_defaults.processing.unknown=true,
    (c:any)=>c.engines[0].search_method="seed_list",(c:any)=>c.engines[0].keyword_rules=undefined,
  ]){const c=cfg();mutate(c);assert.throws(()=>parseTaskConfig(c));}
  const b=boot();b.engines[0].name="xiaohongshu";assert.throws(()=>parseTaskConfig(b));
});
test("Friday plan is deterministic, immutable and obeys four queries of five results per engine",()=>{
  const rotation=initialRotation(),copy=structuredClone(rotation);const p=compileTask(cfg(),friday,rotation,lib());assert.deepEqual(rotation,copy);
  assert.equal(p.anchor_date,"2026-11-14");assert.deepEqual(p.config.engines.map(e=>e.limit),[20,20]);assert.equal(p.config.engines[0].keywords![0],"西安 本周末去哪");
  assert(p.config.engines[1].keywords!.includes("西安 11月14日—11月15日 市集"));assert.equal(p.config.engines[1].keywords!.length,4);
  assert(p.config.engines.every(e=>e.keywords!.length===4));
  const plan=buildCollectionPlan(p.config,createDefaultCollectionEngines({workspace:process.cwd(),python:"unused",deepseekKey:"",record:()=>{}}));
  assert.equal(plan.jobs.length,8);assert(plan.jobs.every(j=>j.limit===5));assert.equal(plan.requested_documents,40);
});
test("Sunday anchor emits one date; Sunday night rolls to next weekend; year boundary follows anchor",()=>{
  const c=cfg();let p=compileTask(c,"2026-11-14",initialRotation(),lib());assert(p.config.engines[1].keywords!.some(w=>w.includes("11月15日 市集")));
  p=compileTask(c,"2026-11-15",initialRotation(),lib());assert(p.config.engines[1].keywords!.some(w=>w.includes("11月21日—11月22日")));
  p=compileTask(c,"2026-12-31",initialRotation(),lib());assert.equal(p.anchor_date,"2027-01-01");assert(p.config.engines[1].keywords!.some(w=>w.includes("2027年1月")));
});
test("template groups, templates and all regional groups rotate instead of repeating one place",()=>{
  let state=initialRotation();const words=new Set<string>(),areas=new Set<string>();for(let n=0;n<30;n++){
    const p=compileTask(cfg(),friday,state,lib());state=p.next;for(const w of p.config.engines[1].keywords!)words.add(w);
    for(const a of lib().area_groups.flatMap(g=>g.areas))if(p.config.engines[1].keywords!.some(w=>w.includes(a)))areas.add(a);
  }assert(words.size>30);assert.equal(areas.size,14);
});
test("seasonal replacement respects quotas and cross-year winter season",()=>{
  const state=initialRotation();state.runs=3;
  for(const date of ["2026-11-13","2026-12-31","2027-01-13"]){const p=compileTask(cfg(),date,state,lib());assert.equal(p.config.engines[0].keywords!.length,4);assert.equal(p.config.engines[1].keywords!.length,4);assert.equal(p.config.engines[1].limit,20);assert(p.config.engines.some(e=>e.keywords!.some(w=>/红叶|银杏|室内展馆/.test(w))));}
});
test("holiday dates must be explicit and replacement only happens in configured windows",()=>{
  const l=lib();l.holiday_calendar.enabled=true;l.holiday_calendar.windows=[{name:"测试节日",from:"2026-11-14",to:"2026-11-15"}];const s=initialRotation();s.runs=3;
  const p=compileTask(cfg(),friday,s,l);assert(p.config.engines[0].keywords![0].includes("测试节日"));assert.equal(p.config.engines[1].keywords!.filter(w=>w.includes("测试节日")).length,1);
  assert(!compileTask(cfg(),"2026-11-16",s,l).config.engines.some(e=>e.keywords!.some(w=>w.includes("测试节日"))));
});
test("wrong engine references, unknown variables, invalid seasons and quotas fail before IO",()=>{
  for(const change of [(l:KeywordLibrary)=>l.groups.xhs_weekend.engine="deepseek",(l:KeywordLibrary)=>l.groups.xhs_weekend.templates=["{secret}"],(l:KeywordLibrary)=>l.season_topics[0].start_mmdd="02-30"]){const l=lib();change(l);assert.throws(()=>compileTask(cfg(),friday,initialRotation(),l));}
  const c=cfg();c.engines[1].limit=9;assert.throws(()=>compileTask(c,friday,initialRotation(),lib()),/LIMIT/);
});
test("fixed keywords and disabling one engine are supported",()=>{
  const c=cfg();c.engines=[{name:"deepseek",enabled:true,search_method:"fixed_keywords",limit:2,keywords:["西交创新港"]}];delete c.keyword_library;
  const p=compileTask(parseTaskConfig(c),friday,initialRotation());assert.deepEqual(p.config.engines[0].keywords,["西交创新港"]);
  const other=cfg();other.engines[0].enabled=false;assert.equal(compileTask(other,friday,initialRotation(),lib()).config.engines.length,1);
});
test("due window honors Shanghai time, weekdays and previous scheduled day after midnight",()=>{
  const c=cfg();assert.equal(dueDate(c,"2026-11-13T15:29:00Z"),null);assert.equal(dueDate(c,"2026-11-13T15:30:00Z"),friday);assert.equal(dueDate(c,"2026-11-13T17:00:00Z"),friday);assert.equal(dueDate(c,"2026-11-13T17:31:00Z"),null);
  c.schedule.weekdays=[1];assert.equal(dueDate(c,"2026-11-13T15:30:00Z"),null);
});
test("preview makes no directories, state writes, execution or credential reads",async()=>{
  const f=fixture();try{let calls=0;const p=await runTask(f.file,{date:friday,execute:async()=>{calls++;throw new Error();}});assert.equal(p.status,"preview");assert.equal(calls,0);assert(!existsSync(f.c.state_file));assert(!existsSync(f.c.collection_defaults.publish_root!));}finally{f.clean();}
});
test("disabled schedule skips live work but manual explicitly allows one batch",async()=>{
  const f=fixture();try{let calls=0;const execute=async()=>{calls++;return {status:"success",task_completed:true};};assert.equal((await runTask(f.file,{live:true,execute})).status,"skipped");assert.equal(calls,0);assert.equal((await runTask(f.file,{live:true,manual:true,execute})).status,"complete");assert.equal(calls,1);}finally{f.clean();}
});
test("same scheduled day never executes twice, even after configuration changes",async()=>{
  const f=fixture();try{const now=()=>"2026-11-13T15:30:00Z";let calls=0;const execute=async()=>{calls++;return {status:"success",task_completed:true};};await runTask(f.file,{live:true,manual:true,now,execute});f.c.keyword_city="西安市";writeFileSync(f.file,JSON.stringify(f.c));const r=await runTask(f.file,{live:true,manual:true,now,execute});assert.equal(r.status,"skipped");assert.equal(calls,1);assert.equal(read(f.c.state_file).rotation.runs,1);}finally{f.clean();}
});
test("explicit manual force runs a second same-day round against the identical database",async()=>{
  const f=fixture();try{
    const paths:string[]=[];const execute=async(c:any)=>{paths.push(c.database_path);return {status:"success",task_completed:true};};
    await runTask(f.file,{live:true,manual:true,execute});
    await assert.rejects(runTask(f.file,{live:true,force:true,execute}),/FORCE_REQUIRES_MANUAL/);
    assert.equal((await runTask(f.file,{live:true,manual:true,force:true,execute})).status,"complete");
    assert.equal(paths.length,2);assert.equal(paths[0],paths[1]);assert.equal(read(f.c.state_file).rotation.runs,2);
  }finally{f.clean();}
});
test("shared publication lock prevents concurrent source/browser execution",async()=>{
  const f=fixture();try{let finish!:(v:{status:string;task_completed:boolean})=>void;let entered!:()=>void;const enteredPromise=new Promise<void>(r=>entered=r);
    const first=runTask(f.file,{live:true,manual:true,execute:async()=>{entered();return new Promise(r=>finish=r);}});await enteredPromise;
    const other=await runTask(f.file,{live:true,manual:true,execute:async()=>{throw new Error("must not run");}});assert.equal((other as any).reason,"TASK_LOCKED");finish({status:"success",task_completed:true});await first;assert(existsSync(f.c.collection_defaults.database_path!+".task.lock"));
  }finally{f.clean();}
});
test("stale task locks are reclaimed while a live legacy holder is still respected",async()=>{
  const f=fixture();try{
    const lock=resolve(f.c.collection_defaults.database_path!+".task.lock"),execute=async()=>({status:"success",task_completed:true});
    // A legacy JSON marker whose recorded pid is still alive is a real lock, not a stale one.
    writeFileSync(lock,JSON.stringify({pid:process.pid,started_at:"2026-11-13T00:00:00Z"}));
    assert.equal((await runTask(f.file,{live:true,manual:true,execute:async()=>{throw new Error("must not run");}}) as any).reason,"TASK_LOCKED");
    const dead=spawnSync(process.execPath,["-e",""]).pid;
    writeFileSync(lock,JSON.stringify({pid:dead,started_at:"2026-11-13T00:00:00Z"}));
    assert.equal((await runTask(f.file,{live:true,manual:true,execute})).status,"complete");assert(existsSync(lock));
    // A holder killed with SIGKILL leaves the lock file behind, but the OS released the lock.
    spawnSync(process.execPath,["--input-type=module","-e",`import{DatabaseSync}from"node:sqlite";const d=new DatabaseSync(${JSON.stringify(lock)});d.exec("BEGIN IMMEDIATE");setInterval(()=>{},1e9)`],{killSignal:"SIGKILL",timeout:3000});
    assert(existsSync(lock));
    assert.equal((await runTask(f.file,{live:true,manual:true,force:true,execute})).status,"complete");assert(existsSync(lock));
  }finally{f.clean();}
});
test("partial and crashed supplement attempts do not advance cursors; next day is allowed",async()=>{
  const f=fixture();try{
    await runTask(f.file,{live:true,manual:true,now:()=>"2026-11-13T15:30:00Z",execute:async()=>({status:"partial",task_completed:false})});assert.equal(read(f.c.state_file).rotation.runs,0);
    await assert.rejects(runTask(f.file,{live:true,manual:true,now:()=>"2026-11-14T15:30:00Z",execute:async()=>{throw new Error("must not expose secret");}}));assert.equal(read(f.c.state_file).records[1].status,"failed");assert(!JSON.stringify(read(f.c.state_file)).includes("must not expose"));
    assert(existsSync(f.c.collection_defaults.database_path!+".task.lock"));
  }finally{f.clean();}
});
test("bootstrap advances only completed batches and requires explicit retry after failure",async()=>{
  const f=fixture(boot());try{let calls=0;const execute=async()=>{calls++;return {status:"success",task_completed:true};};
    await runTask(f.file,{live:true,manual:true,execute});assert.equal(read(f.c.state_file).rotation.completed_seeds.length,5);
    await runTask(f.file,{live:true,manual:true,execute:async()=>({status:"partial",task_completed:false})});assert.equal(read(f.c.state_file).rotation.completed_seeds.length,5);
    assert.equal((await runTask(f.file,{live:true,manual:true,execute}) as any).reason,"USE_RETRY_FAILED_FOR_BOOTSTRAP");
    await runTask(f.file,{live:true,manual:true,retryFailed:true,execute});assert.equal(read(f.c.state_file).rotation.completed_seeds.length,10);assert.equal(calls,2);
  }finally{f.clean();}
});
test("completed bootstrap exits successfully with no further IO",async()=>{
  const f=fixture(boot());try{
    writeFileSync(f.c.state_file,JSON.stringify({schema_version:"xian-task-state/1",profile_id:f.c.profile_id,rotation:{...initialRotation(),completed_seeds:seeds().targets.map(t=>t.seed_id)},records:[]}));
    const result=await runTask(f.file,{live:true,manual:true,execute:async()=>{throw new Error("must not run");}});assert.equal(result.status,"complete");assert.equal((result as any).processed_targets,247);
  }finally{f.clean();}
});
test("full seed list splits into finite batches, no target omitted or duplicated",()=>{
  let state=initialRotation();const ids:string[]=[];for(let i=0;i<50;i++){const p=compileTask(boot(),friday,state,undefined,seeds());ids.push(...p.seed_ids);state=p.next;state.completed_seeds.push(...p.seed_ids);}
  assert.equal(ids.length,247);assert.equal(new Set(ids).size,247);assert.throws(()=>compileTask(boot(),friday,state,undefined,seeds()),/BOOTSTRAP_COMPLETE/);
});
test("a shared official directory is processed separately for each seed target",async()=>{
  const p=compileTask(boot(),friday,initialRotation(),undefined,seeds());
  const result=await collectSources(p.config,new Map([["deepseek",{maxLimit:20,search:async()=>({warnings:[],sources:[{engine:"deepseek",keyword:"",title:"名录",document:{url:"https://www.xa.gov.cn/shared-directory",text:"景点名录",published_at:null,fetched_at:"2026-11-13T00:00:00Z",authority:"unverified" as const,content_scope:"exported_text" as const,image_urls:[]}}]})}]]),{directory:".local-data/unused",now:()=>"2026-11-13T00:00:00Z"});
  assert.equal(result.sources.length,5);assert.equal(result.duplicates.length,0);assert.equal(new Set(result.sources.map(s=>s.keyword)).size,5);
});
test("live date override is rejected so historical fixtures cannot run accidentally",async()=>{
  const f=fixture();try{await assert.rejects(runTask(f.file,{live:true,manual:true,date:friday}),/DATE_OVERRIDE_PREVIEW_ONLY/);}finally{f.clean();}
});
test("target is a task input; model must explicitly confirm attraction identity and visitability",async()=>{
  const {item,asOf}=await locatedFixture(),target={seed_id:"test",name:item.facts.venue_name,aliases:[],area_hint:"雁塔区"};
  const facts={...item.facts,record_type:"attraction" as const,category:"暂无评级" as const};let received=false;
  const invoke:Extractor=async(system,input)=>{assert.deepEqual(input.target,target);assert(system.includes("target_match"));received=true;return JSON.stringify({activities:[{...facts,target_match:true,visitable:true}]});};
  const extracted=await extractActivities(item.document,{asOf,invoke,target});assert(received);assert.equal(extracted.activities[0].facts.target_match,true);
  for(const flags of [{},{target_match:false,visitable:true},{target_match:true,visitable:false}]){
    const p=await processCollection([{document:item.document,structured:{activities:[{...facts,...flags}]}}],{asOf,baseDate:friday,target,geocoder:{resolve:async()=>{throw new Error("must reject before mapping");}}});assert.equal(p.prepared.dataset.events.length,0);assert(p.rejected[0].reasons.some(s=>s.startsWith("TARGET_")));
  }
});
test("target-approved offline candidate reaches actual SQLite without adding task fields to events",async()=>{
  const {item,asOf}=await locatedFixture(),root=`.local-data/task-db-${randomUUID()}`;
  try{item.facts={...item.facts,record_type:"attraction",category:"暂无评级",target_match:true,visitable:true};
    const p=await processCollection([{document:item.document,structured:{activities:[item.facts]}}],{asOf,baseDate:friday,target:{seed_id:"test",name:item.facts.venue_name,aliases:[],area_hint:"雁塔区"},geocoder:{resolve:async()=>({ok:true,location:item.location,cached:false})}});
    assert.equal(p.prepared.dataset.events.length,1,JSON.stringify(p.rejected));await publishRelease(root,p.prepared,{batchId:"offline",asOf});
    const db=new DatabaseSync(inspectRelease(root).database,{readOnly:true});try{assert.equal(db.prepare("SELECT count(*) n FROM events").get()!.n,1);assert.equal(db.prepare("PRAGMA table_info(events)").all().length,31);assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check,"ok");}finally{db.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("CLI and Windows installer preview never create a task or call external sources",()=>{
  for(const config of ["configs/collection.scheduled.json","configs/collection.bootstrap.json"]){const output=execFileSync(process.execPath,["scripts/collect-task.ts","--config",config,"--date",friday],{encoding:"utf8",windowsHide:true});assert.equal(JSON.parse(output).api_calls,0);}
  const script=readFileSync("scripts/collection-scheduled-task.ps1","utf8");assert(script.includes("if (-not $Install)"));assert(script.includes("-WindowStyle Hidden"));assert(script.includes("SCHEDULE_DISABLED_ENABLE_CONFIG_FIRST"));
});

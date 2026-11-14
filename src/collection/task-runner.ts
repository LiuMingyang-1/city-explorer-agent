import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync} from "node:fs";
import {resolve,relative,isAbsolute,dirname,join} from "node:path";
import {randomUUID} from "node:crypto";
import {parseTaskConfig,compileTask,dueDate,shanghaiDate,initialRotation,planFingerprint} from "./task-plan.ts";
import type {TaskConfig,RotationState,CompiledTask,KeywordLibrary,SeedList} from "./task-plan.ts";
import {buildCollectionPlan} from "./collector.ts";
import {createDefaultCollectionEngines} from "./source-adapters.ts";
import {runCollection} from "./run.ts";
import {collectionDatabasePath,acquireExclusiveLock} from "./database.ts";

interface TaskRecord {id:string;date:string;fingerprint:string;status:"running"|"complete"|"partial"|"failed";started_at:string;finished_at?:string;plan:CompiledTask;result?:unknown;}
interface State {schema_version:"xian-task-state/1";profile_id:string;rotation:RotationState;records:TaskRecord[];}
function privateFile(value:string){const path=resolve(value),child=relative(resolve(".local-data"),path);if(!child||child.startsWith("..")||isAbsolute(child))throw new Error("PATH_MUST_BE_PRIVATE");return path;}
function readJson(path:string){return JSON.parse(readFileSync(path,"utf8"));}
function atomicJson(path:string,value:unknown){mkdirSync(dirname(path),{recursive:true});const temp=`${path}.${randomUUID()}.tmp`;writeFileSync(temp,JSON.stringify(value,null,2)+"\n",{flag:"wx"});renameSync(temp,path);}
function stateFor(config:TaskConfig):State {
  const path=privateFile(config.state_file);if(!existsSync(path))return {schema_version:"xian-task-state/1",profile_id:config.profile_id,rotation:initialRotation(),records:[]};
  const state=readJson(path) as State;
  if(state.schema_version!=="xian-task-state/1"||state.profile_id!==config.profile_id||!Number.isInteger(state.rotation?.runs)||state.rotation.runs<0||!state.rotation.cursors||Object.values(state.rotation.cursors).some(n=>!Number.isInteger(n)||n<0)||!Array.isArray(state.rotation.completed_seeds)||!Array.isArray(state.records))throw new Error("INVALID_TASK_STATE");
  return state;
}
export interface TaskResult {status:string;task_completed:boolean;target_outcomes?:unknown[];}
export interface TaskRunOptions {live?:boolean;manual?:boolean;force?:boolean;retryFailed?:boolean;date?:string;now?:()=>string;execute?:(config:CompiledTask["config"],control:{deadline:number})=>Promise<TaskResult>;}
export async function runTask(configFile:string,options:TaskRunOptions={}) {
  const config=parseTaskConfig(readJson(resolve(configFile))),now=options.now??(()=>new Date().toISOString()),instant=now();
  if(options.date&&options.live)throw new Error("DATE_OVERRIDE_PREVIEW_ONLY");
  if(options.force&&!options.manual)throw new Error("FORCE_REQUIRES_MANUAL");
  const date=options.date??(!options.live||options.manual||config.mode==="bootstrap"?shanghaiDate(instant):dueDate(config,instant));
  if(options.live&&!options.manual&&(!config.schedule.enabled||config.mode==="bootstrap"))return {status:"skipped",reason:"SCHEDULE_DISABLED"};
  if(!date)return {status:"skipped",reason:"OUTSIDE_SCHEDULE_WINDOW"};
  privateFile(config.collection_defaults.output_dir);const root=privateFile(config.collection_defaults.publish_root!);
  const database=collectionDatabasePath(config.collection_defaults.database_path);
  const compile=(state:State)=>{
    const library=config.keyword_library?readJson(resolve(config.keyword_library)) as KeywordLibrary:undefined;
    const seeds=config.seed_file?readJson(resolve(config.seed_file)) as SeedList:undefined;
    const plan=compileTask(config,date,state.rotation,library,seeds);
    buildCollectionPlan(plan.config,createDefaultCollectionEngines({workspace:process.cwd(),python:"unused",deepseekKey:"",record:()=>{}}));
    return plan;
  };
  const finished=(state:State)=>({status:"complete",reason:"BOOTSTRAP_EXHAUSTED",processed_targets:state.rotation.completed_seeds.length,api_calls:0});
  if(!options.live){const state=stateFor(config);try{const plan=compile(state);return {status:"preview",api_calls:0,schedule_enabled:config.schedule.enabled,plan};}catch(error){if(config.mode==="bootstrap"&&error instanceof Error&&error.message==="BOOTSTRAP_COMPLETE")return finished(state);throw error;}}
  // One lock covers both profiles if they publish into the same collection.
  let unlock:()=>void;
  try{unlock=acquireExclusiveLock(database+".task.lock","TASK_LOCKED");}catch(error){if(error instanceof Error&&error.message==="TASK_LOCKED")return {status:"skipped",reason:"TASK_LOCKED"};throw error;}
  try{
    const state=stateFor(config),last=state.records.at(-1);
    if(config.mode==="supplement"&&!options.force&&state.records.some(r=>r.date===date))return {status:"skipped",reason:"ALREADY_ATTEMPTED_SCHEDULED_DAY"};
    if(config.mode==="bootstrap"&&last&&last.status!=="complete"&&!options.retryFailed)return {status:"skipped",reason:"USE_RETRY_FAILED_FOR_BOOTSTRAP",record_id:last.id};
    let plan:CompiledTask;
    try{plan=compile(state);}catch(error){if(config.mode==="bootstrap"&&error instanceof Error&&error.message==="BOOTSTRAP_COMPLETE")return finished(state);throw error;}
    const record:TaskRecord={id:randomUUID(),date,fingerprint:planFingerprint(plan.config),status:"running",started_at:instant,plan};
    state.records.push(record);atomicJson(privateFile(config.state_file),state);
    // Persist before IO. A crash or config change must not launch an unbounded paid replay.
    try{
      const result=await (options.execute??runCollection)(plan.config,{deadline:Date.parse(instant)+config.schedule.max_run_minutes*60000});
      record.result=result;record.finished_at=now();record.status=result.task_completed?"complete":result.status==="failed"?"failed":"partial";
      if(result.task_completed){state.rotation=plan.next;state.rotation.completed_seeds=[...new Set([...state.rotation.completed_seeds,...plan.seed_ids])];}
      atomicJson(privateFile(config.state_file),state);return {status:record.status,record_id:record.id,result};
    }catch(error){record.status="failed";record.finished_at=now();record.result={error:"TASK_EXECUTION_FAILED"};atomicJson(privateFile(config.state_file),state);throw error;}
  }finally{unlock();}
}

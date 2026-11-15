import {runTask} from "../src/collection/task-runner.ts";
import {collectionError} from "../src/collection/collector.ts";
async function main(){
  const args=process.argv.slice(2);let config="configs/collection.scheduled.json",live=false,manual=false,force=false,retryFailed=false,date:string|undefined,backend:"windows_task_scheduler"|"cron"|undefined;
  const seen=new Set<string>();
  for(let i=0;i<args.length;i++){
    const flag=args[i];if(seen.has(flag))throw new Error("DUPLICATE_TASK_ARGUMENT");seen.add(flag);
    if(flag==="--config"){config=args[++i];if(!config)throw new Error("CONFIG_PATH_REQUIRED");}
    else if(flag==="--live")live=true;
    else if(flag==="--manual")manual=true;
    else if(flag==="--force")force=true;
    else if(flag==="--retry-failed")retryFailed=true;
    else if(flag==="--date"){date=args[++i];if(!date)throw new Error("DATE_REQUIRED");}
    else if(flag==="--backend"){const value=args[++i];if(value!=="windows_task_scheduler"&&value!=="cron")throw new Error("INVALID_SCHEDULE_BACKEND");backend=value;}
    else if(flag==="--help"){console.log("npm run collect:task -- --config <file> [--date YYYY-MM-DD] [--backend cron|windows_task_scheduler] [--manual [--force] --live]");return;}
    else throw new Error("INVALID_TASK_ARGUMENT");
  }
  const result=await runTask(config,{live,manual,force,retryFailed,date,backend});console.log(JSON.stringify(result,null,2));
  if(result.status==="partial")process.exitCode=2;else if(result.status==="failed")process.exitCode=1;
}
main().catch(error=>{console.error(collectionError(error));process.exitCode=1;});

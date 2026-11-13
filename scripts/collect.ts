import {readFileSync} from "node:fs";
import {resolve,relative,isAbsolute} from "node:path";
import {parseCollectionRunConfig} from "../src/collection/run-config.ts";
import {buildCollectionPlan,collectionError} from "../src/collection/collector.ts";
import {createDefaultCollectionEngines} from "../src/collection/source-adapters.ts";
import {runCollection} from "../src/collection/run.ts";
import {collectionDatabasePath} from "../src/collection/database.ts";
function privatePath(path:string){
  const full=resolve(path),child=relative(resolve(".local-data"),full);
  if(!child||child.startsWith("..")||isAbsolute(child))throw new Error("PATH_MUST_BE_PRIVATE");
  return full;
}
async function main(){
  const args=process.argv.slice(2);let path="configs/collection.example.json",live=false,seenConfig=false;
  for(let i=0;i<args.length;i++){
    if(args[i]==="--live"&&!live){live=true;continue;}
    if((args[i]==="--config"||args[i].startsWith("--config="))&&!seenConfig){path=args[i]==="--config"?args[++i]:args[i].slice(9);seenConfig=true;if(!path)throw new Error("CONFIG_PATH_REQUIRED");continue;}
    if(args[i]==="--help"){console.log("npm run collect -- --config configs/collection.example.json [--live]");return;}
    throw new Error("INVALID_COLLECTION_ARGUMENTS");
  }
  const config=parseCollectionRunConfig(JSON.parse(readFileSync(resolve(path),"utf8")));
  const output=privatePath(config.output_dir);if(config.publish_root)privatePath(config.publish_root);
  const database=config.processing.enabled?collectionDatabasePath(config.database_path):null;
  const workspace=process.cwd(),python=resolve(".local-data/tools/mediacrawler-venv/Scripts/python.exe");
  const dryRegistry=createDefaultCollectionEngines({workspace,python,deepseekKey:"",record:()=>{}});
  const plan=buildCollectionPlan(config,dryRegistry);
  if(!live){console.log(JSON.stringify({mode:"dry-run",plan,output_dir:output,database_path:database,api_calls:0},null,2));return;}
  const result=await runCollection(config);
  if(result.status!=="success")process.exitCode=result.status==="failed"?1:2;
}
main().catch(error=>{console.error(collectionError(error));process.exitCode=1;});

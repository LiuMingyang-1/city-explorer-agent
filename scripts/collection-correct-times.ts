import {readFileSync,existsSync} from "node:fs";
import {resolve,relative,isAbsolute} from "node:path";
import {correctCollectionTimes,collectionDatabasePath} from "../src/collection/database.ts";
import type {TimeCorrection} from "../src/collection/database.ts";
import {acquireExclusiveLock} from "../src/collection/lock.ts";

// Maintenance command for conservative, cached-source audits. Normal collection still
// goes through model/map validation; this command cannot fill new times or coordinates.
function main(){
  const args=process.argv.slice(2),apply=args.at(-1)==="--apply";
  if(args.length!==(apply?2:1))throw new Error("USAGE: node scripts/collection-correct-times.ts <private-manifest.json> [--apply]");
  const file=resolve(args[0]),child=relative(resolve(".local-data"),file);
  if(!child||child.startsWith("..")||isAbsolute(child))throw new Error("AUDIT_MANIFEST_MUST_BE_PRIVATE");
  const manifest=JSON.parse(readFileSync(file,"utf8")) as {schema_version:string;database_path:string;batch_id:string;corrections:TimeCorrection[]};
  if(manifest.schema_version!=="xian-time-corrections/1"||!Array.isArray(manifest.corrections)||!manifest.corrections.length)throw new Error("INVALID_TIME_CORRECTION_MANIFEST");
  const database=collectionDatabasePath(manifest.database_path);
  if(!apply){console.log(JSON.stringify({status:"preview",database,corrections:manifest.corrections.length,api_calls:0}));return;}
  if(!existsSync(database))throw new Error("COLLECTION_DATABASE_NOT_INITIALIZED");
  const unlock=acquireExclusiveLock(database+".task.lock","TASK_LOCKED");
  try{
    const receipt=correctCollectionTimes(database,manifest.corrections,{batchId:manifest.batch_id,asOf:new Date().toISOString()});
    console.log(JSON.stringify(receipt,null,2));
  }finally{unlock();}
}
try{main();}catch(error){console.error(error instanceof Error?error.message:"TIME_CORRECTION_FAILED");process.exitCode=1;}

import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import {resolve,relative,isAbsolute,join} from "node:path";
import {randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {parseCollectionRunConfig} from "../src/collection/run-config.ts";
import {buildCollectionPlan,collectSources,collectionError} from "../src/collection/collector.ts";
import {createDefaultCollectionEngines} from "../src/collection/source-adapters.ts";
import {collectionCredentials,geocodingKey} from "../src/collection/config.ts";
import {redact} from "../src/collection/pilot-api.ts";
import type {Attempt} from "../src/collection/pilot-api.ts";
import {createToolAnalysisExtractor,createAmapSearch} from "../src/collection/analysis-model.ts";
import {createLocalOcr} from "../src/collection/ocr.ts";
import {processCollection} from "../src/collection/pipeline.ts";
import {publishRelease,inspectRelease} from "../src/collection/releases.ts";

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
  const workspace=process.cwd(),python=resolve(".local-data/tools/mediacrawler-venv/Scripts/python.exe");
  const dryRegistry=createDefaultCollectionEngines({workspace,python,deepseekKey:"",record:()=>{}});
  const plan=buildCollectionPlan(config,dryRegistry);
  if(!live){console.log(JSON.stringify({mode:"dry-run",plan,output_dir:output,publish_root:config.publish_root??"new run directory / release",api_calls:0},null,2));return;}
  if(existsSync(".env"))process.loadEnvFile(".env");
  const needsModel=config.processing.enabled||config.engines.some(e=>e.enabled&&e.name==="deepseek");
  const credentials=needsModel?collectionCredentials():undefined;
  const mapKey=config.processing.enabled?geocodingKey():"";
  const secrets=[credentials?.deepseekKey??"",mapKey];
  const now=()=>new Date().toISOString(),runId=`run-${now().replace(/[^0-9TZ]/g,"")}-${randomUUID().slice(0,8)}`;
  mkdirSync(output,{recursive:true});const directory=join(output,runId);mkdirSync(directory);
  const save=(name:string,value:unknown)=>writeFileSync(join(directory,name),JSON.stringify(redact(value,secrets),null,2)+"\n");
  const apiAttempts:{operation:string;query:string;code:string;elapsed_ms:number}[]=[];let apiNo=0,mapNo=0,ocrNo=0;
  const record=(a:Attempt)=>{save(`api-${++apiNo}.json`,a);apiAttempts.push({operation:a.operation,query:a.query,code:a.code,elapsed_ms:a.elapsed_ms});};
  save("config.json",config);save("plan.json",plan);
  const registry=createDefaultCollectionEngines({workspace,python,deepseekKey:credentials?.deepseekKey??"",record});
  const started=Date.now();
  const collected=await collectSources(config,registry,{directory:join(directory,"sources"),now});
  save("sources.json",collected.sources);save("coverage.json",collected.coverage);save("duplicate-sources.json",collected.duplicates);
  const processing:any[]=[];const mapAttempts:{elapsed_ms:number;code:string}[]=[];
  const releaseRoot=config.processing.enabled?privatePath(config.publish_root??join(directory,"release")):undefined;
  if(config.processing.enabled&&collected.sources.length){
    const mapApi=createAmapSearch({key:mapKey,requestLimit:config.budgets.map_requests,onRequest:event=>mapAttempts.push(event)});
    const map={search:async(keywords:string)=>{const places=await mapApi.search(keywords);save(`map-${++mapNo}.json`,{keywords,places});return places;}};
    const invoke=createToolAnalysisExtractor({deepseekKey:credentials!.deepseekKey,model:credentials!.extractionModel,map,record,extractLimit:config.budgets.model_requests,scenicSearchLimit:config.budgets.level_searches});
    const ocr=config.processing.ocr?createLocalOcr({python,record:(url,result)=>save(`ocr-${++ocrNo}.json`,{url,...result})}):undefined;
    const date=config.base_date??new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date());
    for(const [index,source]of collected.sources.entries()){
      const batchId=`${runId}-doc-${index+1}`,asOf=now();
      try{
        const prior=existsSync(join(releaseRoot!,"CURRENT"))?inspectRelease(releaseRoot!):undefined;
        const result=await processCollection([{document:source.document}],{asOf,baseDate:date,now,invoke,ocr,modelBudget:2,eventLimit:3,identities:prior?.sidecar.identities,attractionDuplicateMeters:config.processing.attraction_duplicate_meters,geocoder:{resolve:async()=>({ok:false,reason:"MODEL_LOCATION_NOT_BOUND"})}});
        save(`document-${index+1}.json`,{source,dataset:result.prepared.dataset,rejected:result.rejected,deduplicated:result.deduplicated,metrics:result.metrics});
        let publicationError:string|null=null;
        if(result.prepared.dataset.events.length){
          try{await publishRelease(releaseRoot!,result.prepared,{batchId,asOf:now(),attractionDuplicateMeters:config.processing.attraction_duplicate_meters});}
          catch(error){publicationError=collectionError(error);}
        }
        const processingError=result.rejected.some(r=>r.reasons.some(c=>["INVALID_EXTRACTION_SCHEMA","MODEL_REQUIRED"].includes(c)))?"EXTRACTION_FAILED":null;
        processing.push({index:index+1,engine:source.engine,url:source.document.url,accepted_before_cross_source_dedup:result.prepared.dataset.events.length,rejected:result.rejected,deduplicated:result.deduplicated,ocr_errors:result.metrics.ocr_errors,publication_error:publicationError,processing_error:processingError});
      }catch(error){processing.push({index:index+1,engine:source.engine,url:source.document.url,error:collectionError(error)});}
      save("processing.json",processing);console.log(JSON.stringify({stage:"processed",index:index+1,total:collected.sources.length,...processing.at(-1)}));
    }
  }
  let database:string|null=null,databaseRecords=0;
  if(releaseRoot&&existsSync(join(releaseRoot,"CURRENT"))){
    const release=inspectRelease(releaseRoot);database=release.database;
    const db=new DatabaseSync(database,{readOnly:true});try{
      if(db.prepare("PRAGMA integrity_check").get()!.integrity_check!=="ok")throw new Error("DATABASE_INTEGRITY_FAILED");
      const rows=db.prepare("SELECT * FROM events ORDER BY id").all() as any[];databaseRecords=rows.length;
      save("events.json",rows.map(row=>{const{start_at,end_at,...business}=row;return {...business,schedule_json:row.schedule_json?JSON.parse(row.schedule_json):null,image_urls:JSON.parse(row.image_urls)};}));
    }finally{db.close();}
    save("attraction-duplicates.json",release.sidecar.attraction_duplicates??[]);
  }
  if(config.processing.enabled&&!database)save("events.json",[]);
  const processingFailed=processing.some(p=>p.error||p.processing_error||p.publication_error||p.ocr_errors?.length);
  const status=collected.status==="failed"?"failed":processingFailed?"partial":collected.status;
  const summary={run_id:runId,status,directory,requested_documents:plan.requested_documents,collected_documents:collected.sources.length,search_coverage:collected.coverage,processing_enabled:config.processing.enabled,accepted_before_cross_source_dedup:processing.reduce((n,p)=>n+(p.accepted_before_cross_source_dedup??0),0),rejected_candidates:processing.reduce((n,p)=>n+(p.rejected?.length??0),0),database,database_records:databaseRecords,api_attempts:apiAttempts,map_attempts:mapAttempts,elapsed_ms:Date.now()-started};
  save("summary.json",summary);console.log(JSON.stringify(summary));
  if(status!=="success")process.exitCode=status==="failed"?1:2;
}
main().catch(error=>{console.error(collectionError(error));process.exitCode=1;});

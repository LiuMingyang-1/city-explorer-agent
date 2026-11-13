import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import {resolve,relative,isAbsolute,join} from "node:path";
import {randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {parseCollectionRunConfig} from "./run-config.ts";
import {buildCollectionPlan,collectSources,collectionError} from "./collector.ts";
import {createDefaultCollectionEngines} from "./source-adapters.ts";
import {collectionCredentials,geocodingKey} from "./config.ts";
import {redact} from "./pilot-api.ts";
import type {Attempt} from "./pilot-api.ts";
import {createToolAnalysisExtractor,createAmapSearch} from "./analysis-model.ts";
import {createLocalOcr} from "./ocr.ts";
import {processCollection} from "./pipeline.ts";
import {initializeCollectionDatabase,inspectCollectionDatabase,writeCollectionDatabase,collectionDatabasePath} from "./database.ts";

function privatePath(path:string){
  const full=resolve(path),child=relative(resolve(".local-data"),full);
  if(!child||child.startsWith("..")||isAbsolute(child))throw new Error("PATH_MUST_BE_PRIVATE");
  return full;
}

/** Shared live runner; callers validate configuration and own scheduling/locking. */
export async function runCollection(config: ReturnType<typeof parseCollectionRunConfig>, control:{deadline?:number}={}) {
  const output=privatePath(config.output_dir);if(config.publish_root)privatePath(config.publish_root);
  const canonical=config.processing.enabled?collectionDatabasePath(config.database_path):undefined;
  const workspace=process.cwd(),python=resolve(".local-data/tools/mediacrawler-venv/Scripts/python.exe");
  const plan=buildCollectionPlan(config,createDefaultCollectionEngines({workspace,python,deepseekKey:"",record:()=>{}}));
  if(existsSync(".env"))process.loadEnvFile(".env");
  const needsModel=config.processing.enabled||config.engines.some(e=>e.enabled&&e.name==="deepseek");
  const credentials=needsModel?collectionCredentials():undefined;
  const mapKey=config.processing.enabled?geocodingKey():"";
  const secrets=[credentials?.deepseekKey??"",mapKey];
  const now=()=>new Date().toISOString(),runId=`run-${now().replace(/[^0-9TZ]/g,"")}-${randomUUID().slice(0,8)}`;
  mkdirSync(output,{recursive:true});const directory=join(output,runId);mkdirSync(directory);
  const save=(name:string,value:unknown)=>writeFileSync(join(directory,name),JSON.stringify(redact(value,secrets),null,2)+"\n");
  const apiAttempts:{operation:string;query:string;code:string;elapsed_ms:number}[]=[];let apiNo=0,mapNo=0,ocrNo=0;
  let providerError:string|null=null;
  const record=(a:Attempt)=>{if(["INSUFFICIENT_BALANCE","AUTH_FAILED"].includes(a.code))providerError=a.code;save(`api-${++apiNo}.json`,a);apiAttempts.push({operation:a.operation,query:a.query,code:a.code,elapsed_ms:a.elapsed_ms});};
  save("config.json",config);save("plan.json",plan);
  const baseline=canonical?await initializeCollectionDatabase(canonical,config.publish_root):undefined;
  const registry=createDefaultCollectionEngines({workspace,python,deepseekKey:credentials?.deepseekKey??"",record});
  const started=Date.now();
  const collected=await collectSources(config,registry,{directory:join(directory,"sources"),now,deadline:control.deadline});
  save("sources.json",collected.sources);save("coverage.json",collected.coverage);save("duplicate-sources.json",collected.duplicates);
  const processing:any[]=[];const mapAttempts:{elapsed_ms:number;code:string}[]=[];
  const receipts:ReturnType<typeof writeCollectionDatabase>[]=[];
  if(config.processing.enabled&&collected.sources.length){
    const mapApi=createAmapSearch({key:mapKey,requestLimit:config.budgets.map_requests,onRequest:event=>mapAttempts.push(event)});
    const map={search:async(keywords:string)=>{const places=await mapApi.search(keywords);save(`map-${++mapNo}.json`,{keywords,places});return places;}};
    const invoke=createToolAnalysisExtractor({deepseekKey:credentials!.deepseekKey,model:credentials!.extractionModel,map,record,extractLimit:config.budgets.model_requests,scenicSearchLimit:config.budgets.level_searches});
    const ocr=config.processing.ocr?createLocalOcr({python,maxImages:config.processing.ocr_max_images,record:(url,result)=>save(`ocr-${++ocrNo}.json`,{url,...result})}):undefined;
    const date=config.base_date??new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date());
    for(const [index,source]of collected.sources.entries()){
      if(providerError){processing.push({error:providerError,remaining:collected.sources.length-index});break;}
      if(control.deadline!==undefined&&Date.now()>=control.deadline){processing.push({error:"RUN_DEADLINE_REACHED",remaining:collected.sources.length-index});break;}
      const batchId=`${runId}-doc-${index+1}`,asOf=now();
      try{
        const prior=inspectCollectionDatabase(canonical!);
        const result=await processCollection([{document:source.document}],{asOf,baseDate:date,now,invoke,ocr,modelBudget:2,eventLimit:3,target:config.targets?.[source.keyword],identities:prior?.sidecar.identities,attractionDuplicateMeters:config.processing.attraction_duplicate_meters,geocoder:{resolve:async()=>({ok:false,reason:"MODEL_LOCATION_NOT_BOUND"})}});
        save(`document-${index+1}.json`,{source,dataset:result.prepared.dataset,rejected:result.rejected,deduplicated:result.deduplicated,metrics:result.metrics});
        let publicationError:string|null=null;
        if(result.prepared.dataset.events.length){
          try{const receipt=writeCollectionDatabase(canonical!,result.prepared,{batchId,asOf:now(),attractionDuplicateMeters:config.processing.attraction_duplicate_meters});receipts.push(receipt);save(`write-${index+1}.json`,receipt);}
          catch(error){publicationError=collectionError(error);}
        }
        const processingError=result.rejected.some(r=>r.reasons.some(c=>["INVALID_EXTRACTION_SCHEMA","MODEL_REQUIRED"].includes(c)))?"EXTRACTION_FAILED"
          :result.rejected.some(r=>r.reasons.includes("LOCATION_LOOKUP_FAILED"))?"LOCATION_LOOKUP_FAILED":null;
        processing.push({index:index+1,engine:source.engine,url:source.document.url,target:config.targets?.[source.keyword]?.seed_id,accepted_before_cross_source_dedup:result.prepared.dataset.events.length,rejected:result.rejected,deduplicated:result.deduplicated,ocr_errors:result.metrics.ocr_errors,publication_error:publicationError,processing_error:processingError});
      }catch(error){processing.push({index:index+1,engine:source.engine,url:source.document.url,error:collectionError(error)});}
      save("processing.json",processing);console.log(JSON.stringify({stage:"processed",index:index+1,total:collected.sources.length,...processing.at(-1)}));
    }
  }
  let database:string|null=null,databaseRecords=0;
  if(canonical&&existsSync(canonical)){
    const release=inspectCollectionDatabase(canonical);database=release.database;
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
  const task_completed=!processingFailed&&collected.coverage.every(c=>!c.warnings.some(w=>!["INSUFFICIENT_UNIQUE_RESULTS"].includes(w)))&&(!config.processing.enabled||processing.length===collected.sources.length);
  const target_outcomes=Object.entries(config.targets??{}).map(([keyword,target])=>({seed_id:target.seed_id,keyword,accepted_candidates:processing.filter(p=>p.target===target.seed_id).reduce((n,p)=>n+(p.accepted_before_cross_source_dedup??0),0)}));
  const summary={run_id:runId,status,task_completed,provider_error:providerError,target_outcomes,directory,requested_documents:plan.requested_documents,collected_documents:collected.sources.length,search_coverage:collected.coverage,processing_enabled:config.processing.enabled,accepted_before_cross_source_dedup:processing.reduce((n,p)=>n+(p.accepted_before_cross_source_dedup??0),0),rejected_candidates:processing.reduce((n,p)=>n+(p.rejected?.length??0),0),database,database_id:baseline?.database_id,database_records_before:baseline?.records,database_records:databaseRecords,database_writes:receipts.length,api_attempts:apiAttempts,map_attempts:mapAttempts,elapsed_ms:Date.now()-started};
  save("summary.json",summary);console.log(JSON.stringify(summary));
  return summary;
}

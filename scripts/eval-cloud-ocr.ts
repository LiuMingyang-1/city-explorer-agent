import{readFileSync,writeFileSync,mkdirSync,existsSync}from"node:fs";import{resolve,relative,isAbsolute,join}from"node:path";
import{createCloudOcr,cloudOcrEnvironment}from"../src/collection/cloud-ocr.ts";
// Private input/output only; never runs collection or writes events.db.
const input=resolve(process.argv[2]??".local-data/xian/issue-21/samples.json"),root=resolve(".local-data");
const rel=relative(root,input);if(!rel||rel.startsWith("..")||isAbsolute(rel))throw Error("EVAL_INPUT_MUST_BE_PRIVATE");
if(existsSync(".env"))process.loadEnvFile(".env");const options=cloudOcrEnvironment(),samples=JSON.parse(readFileSync(input,"utf8"));
if(!Array.isArray(samples)||samples.length>10)throw Error("INVALID_OCR_SAMPLES");
const directory=join(root,"xian","issue-21",new Date().toISOString().replace(/[^0-9TZ]/g,""));mkdirSync(directory,{recursive:true});
let latest:any;const results=[];
for(const [index,sample]of samples.entries()){
 const fetcher:typeof fetch=sample.local_images?async(url,init)=>{
  const at=sample.document.image_urls.indexOf(String(url));if(at<0)return fetch(url,init);
  const path=resolve(sample.local_images[at]),child=relative(root,path);if(!child||child.startsWith("..")||isAbsolute(child))throw Error("EVAL_IMAGE_MUST_BE_PRIVATE");return new Response(readFileSync(path));
 }:fetch;
 const ocr=createCloudOcr({...options,fetch:fetcher,maxImages:20,record:(_url,r)=>latest=r});
 const output=await ocr(sample.document);const entry={label:sample.label,result:latest,output,local_ocr_reference:sample.local_ocr_reference};results.push(entry);writeFileSync(join(directory,`sample-${index+1}.json`),JSON.stringify(entry,null,2)+"\n");console.log(JSON.stringify({sample:index+1,label:sample.label,pages:latest.pages.length,elapsed_ms:latest.elapsed_ms,errors:output.errors}));
}
const pages=results.flatMap(r=>r.result.pages),times=pages.map(p=>p.elapsed_ms).sort((a,b)=>a-b);
const summary={model:options.model,base_url:options.baseUrl,documents:results.length,images:pages.length,successes:pages.filter(p=>!p.error).length,failures:pages.filter(p=>p.error).length,elapsed_ms:results.reduce((n,r)=>n+r.result.elapsed_ms,0),p50_ms:times[Math.max(0,Math.ceil(times.length*.5)-1)],p95_ms:times[Math.max(0,Math.ceil(times.length*.95)-1)],usage:pages.reduce((a,p)=>({prompt_tokens:a.prompt_tokens+(p.usage?.prompt_tokens??0),completion_tokens:a.completion_tokens+(p.usage?.completion_tokens??0),total_tokens:a.total_tokens+(p.usage?.total_tokens??0)}),{prompt_tokens:0,completion_tokens:0,total_tokens:0}),directory};
writeFileSync(join(directory,"summary.json"),JSON.stringify(summary,null,2)+"\n");console.log(JSON.stringify(summary));

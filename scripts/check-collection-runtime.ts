import {execFileSync} from "node:child_process";
import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {collectionPython} from "../src/collection/runtime.ts";
import {createLocalOcr} from "../src/collection/ocr.ts";

async function main(){
  const args=process.argv.slice(2);
  if(args.some(a=>!["--ocr","--crawler"].includes(a)))throw new Error("USAGE: node scripts/check-collection-runtime.ts [--ocr] [--crawler]");
  if(existsSync(".env"))process.loadEnvFile(".env");
  const python=collectionPython();
  const version=execFileSync(python,["-c","import sys; assert sys.version_info >= (3, 11), 'Python >=3.11 required'; print(sys.version.split()[0])"],{encoding:"utf8",windowsHide:true,timeout:30000}).trim();
  if(args.includes("--ocr")){
    // Real Python/RapidOCR/model initialization, no image download or API calls.
    const result=await createLocalOcr({python})({url:"https://www.xiaohongshu.com/explore/runtime-check",text:"",published_at:null,fetched_at:new Date().toISOString(),authority:"unverified",content_scope:"exported_text",image_urls:["https://example.com/not-allowed.png"]});
    if(result.errors.length!==1||!result.errors[0].includes("IMAGE_HOST_NOT_ALLOWED"))throw new Error("OCR_RUNTIME_CHECK_FAILED");
  }
  if(args.includes("--crawler"))execFileSync(python,[fileURLToPath(new URL("./mediacrawler-local.py",import.meta.url)),"--check"],{encoding:"utf8",windowsHide:true,timeout:120000,stdio:["ignore","pipe","pipe"]});
  console.log(JSON.stringify({status:"ok",platform:process.platform,python,python_version:version,ocr:args.includes("--ocr"),crawler:args.includes("--crawler"),api_calls:0}));
}
main().catch(()=>{console.error("COLLECTION_RUNTIME_CHECK_FAILED: check Python >=3.11, selected venv, optional dependencies and Playwright installation");process.exitCode=1;});

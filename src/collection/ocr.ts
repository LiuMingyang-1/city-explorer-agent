import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtractionDocument } from "./extraction.ts";

export interface OcrResult { pages: {image:number; text:string; error:string|null}[]; elapsed_ms:number; }
export function createLocalOcr(options: {python: string; maxImages?: number; record?: (url:string,result:OcrResult) => void}) {
  const limit = options.maxImages ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("INVALID_OCR_LIMIT");
  return async (doc: ExtractionDocument): Promise<{text:string; errors:string[]}> => {
    const result = await new Promise<OcrResult>((resolve,reject) => {
      const child = spawn(options.python, [fileURLToPath(new URL("../../scripts/collection-ocr.py",import.meta.url))], {stdio:["pipe","pipe","pipe"],windowsHide:true,env:{...process.env,PYTHONUTF8:"1"}});
      child.stdout.setEncoding("utf8");
      let output = "", bytes = 0;
      const timer = setTimeout(() => {child.kill(); reject(new Error("OCR_TIMEOUT"));}, 180000);
      child.stdout.on("data", (chunk: string) => {bytes+=Buffer.byteLength(chunk,"utf8");if(bytes>256000){child.kill();reject(new Error("OCR_OUTPUT_TOO_LARGE"));}else output+=chunk;});
      child.stderr.resume();
      child.on("error", () => {clearTimeout(timer);reject(new Error("OCR_START_FAILED"));});
      child.on("close", code => {clearTimeout(timer);try{if(code!==0)throw new Error();const value=JSON.parse(output);if(!Array.isArray(value.pages))throw new Error();resolve(value);}catch{reject(new Error("OCR_FAILED"));}});
      child.stdin.on("error",()=>undefined);
      child.stdin.end(JSON.stringify(doc.image_urls.slice(0,limit)));
    });
    options.record?.(doc.url,result);
    const errors = result.pages.flatMap(p=>p.error?[`图片${p.image}：${p.error}`]:[]);
    if(doc.image_urls.length>limit) errors.push(`OCR_IMAGE_LIMIT：仅识别前${limit}张，共${doc.image_urls.length}张`);
    return {text:result.pages.map(p=>`【图片${p.image}】\n${p.text}`).join("\n\n"),errors};
  };
}

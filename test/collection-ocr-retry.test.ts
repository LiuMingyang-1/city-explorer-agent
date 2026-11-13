import {test} from "node:test";
import assert from "node:assert/strict";
import {createLocalOcr} from "../src/collection/ocr.ts";
import type {OcrResult} from "../src/collection/ocr.ts";
import {extractionFixture} from "./collection-downstream-fixture.ts";
test("OCR retries only failed images once and preserves original picture numbers",async()=>{
  const {document}=extractionFixture();document.image_urls=["https://a.xhscdn.com/1","https://a.xhscdn.com/2","https://a.xhscdn.com/3"];
  const calls:string[][]=[];let recorded:OcrResult|undefined;
  const initial={pages:[{image:1,text:"第一图",error:null},{image:2,text:"",error:"IMAGE_OCR_FAILED"},{image:3,text:"第三图",error:null}],elapsed_ms:20};
  const before=structuredClone(initial);
  const ocr=createLocalOcr({python:"not-used",run:async urls=>{calls.push(urls);return calls.length===1?initial:{pages:[{image:1,text:"恢复第二图",error:null}],elapsed_ms:7};},record:(_url,r)=>recorded=r});
  const result=await ocr(document);assert.deepEqual(result.errors,[]);assert(result.text.includes("【图片2】\n恢复第二图"));assert.deepEqual(calls[1],[document.image_urls[1]]);assert.deepEqual(initial,before);assert.equal(recorded!.elapsed_ms,27);assert.deepEqual(recorded!.retry!.images,[2]);
});
test("persistent OCR failure is observable and is never retried indefinitely",async()=>{
  const {document}=extractionFixture();document.image_urls=["https://a.xhscdn.com/1"];let calls=0;
  const ocr=createLocalOcr({python:"not-used",run:async()=>{calls++;return {pages:[{image:1,text:"",error:"IMAGE_OCR_FAILED"}],elapsed_ms:1};}});
  const result=await ocr(document);assert.equal(calls,2);assert.deepEqual(result.errors,["图片1：IMAGE_OCR_FAILED"]);
});
test("deterministically invalid image hosts are not retried",async()=>{
  const {document}=extractionFixture();document.image_urls=["https://invalid.example/file"];let calls=0;
  const ocr=createLocalOcr({python:"not-used",run:async()=>{calls++;return {pages:[{image:1,text:"",error:"IMAGE_HOST_NOT_ALLOWED"}],elapsed_ms:1};}});
  await ocr(document);assert.equal(calls,1);
});

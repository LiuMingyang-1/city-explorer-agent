import {test} from "node:test";
import assert from "node:assert/strict";
import {collectionCredentials} from "../src/collection/config.ts";
test("collection credentials use dedicated variables, never planner fallback",()=>{
 assert.throws(()=>collectionCredentials({EXPLORER_API_KEY:"planner-only"}),/MISSING_COLLECTION_CONFIG:DEEPSEEK_API_KEY/);
 assert.throws(()=>collectionCredentials({QOVIA_KEY:"fixture"}),/MISSING_COLLECTION_CONFIG:DEEPSEEK_API_KEY/);
 assert.deepEqual(collectionCredentials({QOVIA_KEY:" qovia-fixture ",DEEPSEEK_API_KEY:" ds-fixture "}),{deepseekKey:"ds-fixture",extractionModel:"deepseek-flash"});
});
test("extraction model defaults to flash and accepts an explicit configuration",()=>{
 const env={QOVIA_KEY:"fixture",DEEPSEEK_API_KEY:"fixture"};
 assert.equal(collectionCredentials({...env,EXPLORER_COLLECTION_MODEL:" "}).extractionModel,"deepseek-flash");
 assert.equal(collectionCredentials({...env,EXPLORER_COLLECTION_MODEL:" custom-model "}).extractionModel,"custom-model");
 assert.throws(()=>collectionCredentials({...env,EXPLORER_COLLECTION_MODEL:"model\nextra"}),/INVALID_COLLECTION_CONFIG:EXPLORER_COLLECTION_MODEL/);
});
test("config errors do not echo credential material",()=>{
 const value="private-material\nheader-injection";
 try{collectionCredentials({DEEPSEEK_API_KEY:value});assert.fail("must reject");}catch(error){assert(!String(error).includes("private-material"));assert.match(String(error),/INVALID_COLLECTION_CONFIG/);}
});

test("retired Qovia key is not required or read",()=>{assert.equal(collectionCredentials({DEEPSEEK_API_KEY:"fixture",QOVIA_KEY:"ignored\ninvalid"}).deepseekKey,"fixture");});

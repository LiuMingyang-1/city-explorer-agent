import {test} from "node:test";
import assert from "node:assert/strict";
import {collectionPython} from "../src/collection/runtime.ts";
import {parseCollectionRunConfig} from "../src/collection/run-config.ts";
import {parseTaskConfig,compileTask,initialRotation} from "../src/collection/task-plan.ts";
import {readFileSync} from "node:fs";

test("default Python layout follows Windows, Linux and macOS without reading credentials",()=>{
  assert.equal(collectionPython({platform:"win32",workspace:"C:\\city explorer",env:{}}),"C:\\city explorer\\.local-data\\tools\\mediacrawler-venv\\Scripts\\python.exe");
  for(const platform of ["linux","darwin"] as const)assert.equal(collectionPython({platform,workspace:"/srv/city explorer",env:{}}),"/srv/city explorer/.local-data/tools/mediacrawler-venv/bin/python");
});

test("Python injection accepts executable paths with spaces and PATH names; config wins over env",()=>{
  assert.equal(collectionPython({python:"my venv/bin/python",platform:"linux",workspace:"/srv/city",env:{COLLECTION_PYTHON:"other"}}),"/srv/city/my venv/bin/python");
  assert.equal(collectionPython({platform:"linux",env:{COLLECTION_PYTHON:"python3"}}),"python3");
  assert.equal(collectionPython({python:"C:\\Python venv\\Scripts\\python.exe",platform:"win32",env:{}}),"C:\\Python venv\\Scripts\\python.exe");
  assert.equal(collectionPython({python:"/opt/my venv/bin/python",platform:"darwin",env:{}}),"/opt/my venv/bin/python");
  for(const python of ["   ","python\nother","python\x00"]){assert.throws(()=>collectionPython({python}),/INVALID_COLLECTION_PYTHON/);}
});

test("manual and task config preserve Python injection and reject empty/multiline paths",()=>{
  const input={engines:[{name:"deepseek",keywords:["西安"]}],output_dir:".local-data/test"};
  assert.equal(parseCollectionRunConfig({...input,python:"/opt/collector/bin/python"}).python,"/opt/collector/bin/python");
  for(const python of ["","   ","python\nother","python\x00"])assert.throws(()=>parseCollectionRunConfig({...input,python}));
  const original=JSON.parse(readFileSync("configs/collection.scheduled.json","utf8"));
  for(const backend of ["windows_task_scheduler","cron","manual"]){
    const c=parseTaskConfig({...original,schedule:{...original.schedule,backend},collection_defaults:{...original.collection_defaults,python:".venv/bin/python"}});
    assert.equal(compileTask(c,"2026-11-13",initialRotation(),JSON.parse(readFileSync(c.keyword_library!,"utf8"))).config.python,".venv/bin/python");
  }
  assert.throws(()=>parseTaskConfig({...original,schedule:{...original.schedule,backend:"unknown"}}));
  assert.throws(()=>parseTaskConfig({...original,collection_defaults:{...original.collection_defaults,python:"\n"}}));
});

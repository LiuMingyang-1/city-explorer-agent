import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {rmSync,readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {runCollection} from "../src/collection/run.ts";
import {parseCollectionRunConfig} from "../src/collection/run-config.ts";
import {extractionFixture} from "./collection-downstream-fixture.ts";

test("real shared runner searches, uses the map tool, validates and commits SQLite on this platform",async()=>{
  const root=`.local-data/run-smoke-${randomUUID()}`,oldFetch=globalThis.fetch;
  const oldKey=process.env.DEEPSEEK_API_KEY,oldMap=process.env.AMAP_WEB_KEY;
  process.env.DEEPSEEK_API_KEY="offline-model-key";process.env.AMAP_WEB_KEY="offline-map-key";
  const {facts,document}=extractionFixture();let searches=0,maps=0,rounds=0;
  const record={...facts,record_type:"attraction",category:"等级未知",start_at:null,end_at:null,confirmed_start_date:null,confirmed_end_date:null,schedule_type:"unknown",time_status:"unknown",schedule_json:null,valid_from:null,valid_to:null,time_note:"未给出长期开放时间",amap_poi_id:"B_RUN_SMOKE",latitude:34.23,longitude:108.95};
  globalThis.fetch=async(input)=>{
    const url=String(input);
    if(url==="https://api.deepseek.com/v1/tools/search"){searches++;return Response.json({results:[{url:document.url,title:facts.title,content:document.text}]});}
    if(url.startsWith("https://restapi.amap.com/v3/place/text?")){maps++;return Response.json({status:"1",infocode:"10000",pois:[{id:"B_RUN_SMOKE",name:facts.venue_name,address:"文化路1号",adcode:"610113",adname:"雁塔区",cityname:"西安市",location:"108.95,34.23"}]});}
    assert.equal(url,"https://api.deepseek.com/chat/completions");
    if(rounds++===0)return Response.json({choices:[{finish_reason:"tool_calls",message:{content:null,tool_calls:[{id:"map1",type:"function",function:{name:"amap_search",arguments:'{"keywords":"西安文化展厅"}'}}]}}]});
    return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({activities:[record]})}}]});
  };
  try{
    const result=await runCollection(parseCollectionRunConfig({engines:[{name:"deepseek",keywords:["西安景点"],limit:1}],output_dir:root+"/runs",database_path:root+"/events.db",processing:{enabled:true,ocr:false}}));
    assert.equal(result.status,"success");assert.equal(result.database_records,1);assert.equal(result.database_writes,1);assert.equal(searches,1);assert.equal(maps,1);assert.equal(rounds,2);
    const db=new DatabaseSync(root+"/events.db",{readOnly:true});try{const row=db.prepare("SELECT * FROM events").get()!;assert.equal(row.amap_poi_id,"B_RUN_SMOKE");assert.equal(row.longitude,108.95);assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check,"ok");}finally{db.close();}
    const processing=JSON.parse(readFileSync(result.directory+"/processing.json","utf8"));assert.equal(processing[0].publication_error,null);
  }finally{
    globalThis.fetch=oldFetch;
    for(const [key,value]of [["DEEPSEEK_API_KEY",oldKey],["AMAP_WEB_KEY",oldMap]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}
    rmSync(root,{recursive:true,force:true});
  }
});

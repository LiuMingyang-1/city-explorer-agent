import {test} from "node:test";
import assert from "node:assert/strict";
import {createToolAnalysisExtractor} from "../src/collection/analysis-model.ts";
import {extractionSchema,FACT_EXTRACTION_PROMPT} from "../src/collection/extraction.ts";

const source="https://www.shaanxi.gov.cn/scenic-level-list";
const toolCall={id:"level1",type:"function",function:{name:"search_scenic_level",arguments:JSON.stringify({venue_name:"测试景区"})}};
const answer=(category:string,record_type="attraction",url=source)=>({activities:[{title:"测试景区",record_type,category,evidence:{scenic_level_source:url}}]});
const choice=(message:any,finish_reason="stop")=>Response.json({choices:[{finish_reason,message}]});

test("scenic-level search uses the same DeepSeek key, retains a real source and caches repeated venues",async()=>{
  let chats=0,searches=0;
  const invoke=createToolAnalysisExtractor({deepseekKey:"shared-key",record:()=>{},map:{search:async()=>[]},fetch:async(url,init)=>{
    assert.equal((init?.headers as any).Authorization,"Bearer shared-key");
    if(String(url).endsWith("/tools/search")){
      searches++;const body=JSON.parse(String(init?.body));assert.match(body.query,/测试景区.*A级/);
      return Response.json({results:[{url:source,title:"国家AAAAA级旅游景区名单",content:"测试景区为国家AAAAA级旅游景区。"}]});
    }
    const body=JSON.parse(String(init?.body));
    if(body.messages[0].content.startsWith("你是景点A级等级核验器"))return choice({content:JSON.stringify({category:"5A",source_url:source,reason:"文旅部门明确评定目标景区"})});
    chats++;
    return chats%2?choice({tool_calls:[toolCall]},"tool_calls"):choice({content:JSON.stringify(answer("5A"))});
  }});
  for(const id of [1,2]){
    const result=JSON.parse(await invoke(FACT_EXTRACTION_PROMPT,{text:"测试景区可游览，未写等级",source_url:`https://www.sxhm.com/${id}`,schema:extractionSchema}));
    assert.equal(result.activities[0].category,"5A");assert.equal(result.activities[0].evidence.scenic_level_source,source);
  }
  assert.equal(searches,1);assert.equal(chats,4);
});

for(const kind of ["empty","rating","failure"] as const)test(`${kind} grade lookup falls back to 暂无评级 without discarding the attraction`,async()=>{
  let chats=0;
  const invoke=createToolAnalysisExtractor({deepseekKey:"shared-key",record:()=>{},map:{search:async()=>[]},fetch:async(url)=>{
    if(String(url).endsWith("/tools/search"))return kind==="failure"?Response.json({error:"unavailable"},{status:503}):Response.json({results:kind==="empty"?[]:[{url:source,title:"景点用户评分",content:"游客评分4.8分，五星好评。"}]});
    return ++chats===1?choice({tool_calls:[toolCall]},"tool_calls"):choice({content:JSON.stringify(answer("5A"))});
  }});
  const result=JSON.parse(await invoke(FACT_EXTRACTION_PROMPT,{text:"景区介绍，无等级",source_url:"https://www.sxhm.com/a",schema:extractionSchema}));
  assert.equal(result.activities.length,1);assert.equal(result.activities[0].category,"暂无评级");
});

test("a made-up evidence URL cannot justify a grade even when search returned another URL",async()=>{
  let chats=0;
  const invoke=createToolAnalysisExtractor({deepseekKey:"test",record:()=>{},map:{search:async()=>[]},fetch:async(url)=>{
    if(String(url).endsWith("/tools/search"))return Response.json({results:[{url:source,title:"国家5A级旅游景区",content:"测试景区5A级"}]});
    return ++chats===1?choice({tool_calls:[toolCall]},"tool_calls"):choice({content:JSON.stringify(answer("5A","attraction","https://www.shaanxi.gov.cn/invented"))});
  }});
  const result=JSON.parse(await invoke("system",{text:"景区资料",source_url:"https://www.sxhm.com/a",schema:extractionSchema}));assert.equal(result.activities[0].category,"暂无评级");
});

test("activity categories are unchanged and no level-search request is required",async()=>{
  const invoke=createToolAnalysisExtractor({deepseekKey:"test",record:()=>{},map:{search:async()=>[]},fetch:async(url)=>{assert(!String(url).endsWith("/tools/search"));return choice({content:JSON.stringify(answer("展览","activity"))});}});
  const result=JSON.parse(await invoke("system",{text:"展览",source_url:"https://www.sxhm.com/a",schema:extractionSchema}));assert.equal(result.activities[0].category,"展览");
});

test("explicit grades in original text need no extra search; unsupported remembered grades fall back",async()=>{
  const invoke=createToolAnalysisExtractor({deepseekKey:"test",record:()=>{},map:{search:async()=>[]},fetch:async(_url,init)=>JSON.parse(String(init?.body)).messages[0].content.startsWith("你是景点A级等级核验器")?choice({content:JSON.stringify({category:"4A",source_url:"https://www.sxhm.com/a",reason:"目标明确"})}):choice({content:JSON.stringify(answer("4A"))})});
  for(const [text,expected]of [["该景点为国家四A级旅游景区","4A"],["该景点为国家AAAA级旅游景区","4A"],["游客评价4.4分","暂无评级"]]){
    const result=JSON.parse(await invoke("system",{text,source_url:"https://www.sxhm.com/a",schema:extractionSchema}));assert.equal(result.activities[0].category,expected);
  }
});

test("a child park cannot inherit its combined parent scenic area's grade",async()=>{
  let chats=0,checks=0;
  const invoke=createToolAnalysisExtractor({deepseekKey:"test",record:()=>{},map:{search:async()=>[]},fetch:async(url,init)=>{
    if(String(url).endsWith("/tools/search"))return Response.json({results:[{url:source,title:"官方等级名单",content:"大雁塔－大唐芙蓉园组合景区为AAAAA级，包含某公园。没有单独列出某公园等级。"}]});
    const body=JSON.parse(String(init?.body));
    if(body.messages[0].content.startsWith("你是景点A级等级核验器")){checks++;return choice({content:JSON.stringify({category:"暂无评级",source_url:null,reason:"5A属于组合景区，不是该公园独立等级"})});}
    return ++chats===1?choice({tool_calls:[toolCall]},"tool_calls"):choice({content:JSON.stringify({activities:[{title:"某公园",record_type:"attraction",category:"5A",evidence:{scenic_level_source:source}}]})});
  }});
  const result=JSON.parse(await invoke("system",{text:"某公园游览",source_url:"https://www.sxhm.com/a",schema:extractionSchema}));assert.equal(checks,1);assert.equal(result.activities[0].category,"暂无评级");
});

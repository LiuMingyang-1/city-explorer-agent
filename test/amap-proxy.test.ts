import assert from 'node:assert/strict';
import test from 'node:test';
import {handleAMap} from '../src/web/amap.ts';
const env={AMAP_JS_KEY:'test-js-key',AMAP_SECURITY_JSCODE:'test-security-value'};
const request=(path:string,init?:RequestInit)=>new Request('https://city.example'+path,init);

test('map config exposes only the JS identifier and stays disabled without credentials',async()=>{
 const response=await handleAMap(request('/api/map-config'),env);const raw=await response!.text();
 assert(raw.includes('test-js-key'));assert(!raw.includes(env.AMAP_SECURITY_JSCODE));assert.equal(JSON.parse(raw).style,'amap://styles/light');
 const disabled=await handleAMap(request('/api/map-config'),{});assert.deepEqual(await disabled!.json(),{enabled:false,backendCoordinateSystem:'GCJ02'});
 assert.equal(await handleAMap(request('/api/chat'),env),null);
});

test('proxy forwards only approved AMap paths and replaces caller-provided credentials',async()=>{
 let called:URL|undefined;
 const fake:typeof fetch=async(input,init)=>{assert.equal(init?.redirect,'manual');called=new URL(String(input));return new Response('{"status":"1"}',{headers:{'Content-Type':'application/json'}});};
 const response=await handleAMap(request('/_AMapService/v3/geocode/regeo?key=attacker&jscode=attacker&location=108.95,34.27&platform=JS'),env,fake);
 assert.equal(response!.status,200);assert.equal(called!.origin,'https://restapi.amap.com');assert.equal(called!.searchParams.get('key'),env.AMAP_JS_KEY);assert.equal(called!.searchParams.get('jscode'),env.AMAP_SECURITY_JSCODE);assert.equal(called!.searchParams.get('platform'),'JS');
 assert(!(await response!.text()).includes(env.AMAP_SECURITY_JSCODE));
 assert.equal((await handleAMap(request('/_AMapService/https://evil.example'),env,fake))!.status,404);
 assert.equal((await handleAMap(request('/_AMapService/v3/geocode/regeo?callback=alert(1)'),env,fake))!.status,400);
});

test('cross-origin, unsupported method and upstream error do not disclose map credentials',async()=>{
 assert.equal((await handleAMap(request('/_AMapService/v3/place/text',{headers:{Referer:'https://other.example'}}),env))!.status,403);
 assert.equal((await handleAMap(request('/api/map-config',{method:'POST'}),env))!.status,405);
 const fake:typeof fetch=async()=>{throw new Error(env.AMAP_SECURITY_JSCODE);};
 const response=await handleAMap(request('/_AMapService/v3/place/text'),env,fake);assert.equal(response!.status,502);assert(!(await response!.text()).includes(env.AMAP_SECURITY_JSCODE));
 const redirect:typeof fetch=async()=>new Response(null,{status:302,headers:{Location:'https://other.example'}});
 assert.equal((await handleAMap(request('/_AMapService/v3/place/text'),env,redirect))!.status,502);
});

test('SDK JSONP responses are executable under nosniff while JSON stays JSON',async()=>{
 const fake:typeof fetch=async()=>new Response('jsonp_123({"status":"1"})',{headers:{'Content-Type':'application/json;charset=UTF-8'}});
 const response=await handleAMap(request('/_AMapService/v3/assistant/coordinate/convert?callback=jsonp_123'),env,fake);
 assert.equal(response!.headers.get('Content-Type'),'application/javascript; charset=utf-8');
 assert.equal(response!.headers.get('X-Content-Type-Options'),'nosniff');
 assert.equal(await response!.text(),'jsonp_123({"status":"1"})');
 const plain=await handleAMap(request('/_AMapService/v3/assistant/coordinate/convert'),env,fake);
 assert(plain!.headers.get('Content-Type')!.startsWith('application/json'));
});

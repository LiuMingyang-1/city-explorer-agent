import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {Element} from './frontend-fixture.ts';

test('passive location success or refusal cannot override a requested plan; explicit location still works',()=>{
 const elements=new Map<string,Element>();
 const $=(id:string)=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)!;};
 const callbacks:{success:(position:object)=>void;failure:()=>void}[]=[];
 const context=vm.createContext({document:{getElementById:$},window:{},AbortController,
  navigator:{geolocation:{getCurrentPosition(success:(position:object)=>void,failure:()=>void){callbacks.push({success,failure});}}},
  setTimeout:()=>0,clearTimeout(){},setInterval(){},fetch:async()=>({ok:true,json:async()=>({current:{temperature_2m:22,weather_code:0,is_day:1}})})});
 vm.runInContext(readFileSync(new URL('../frontend/app.js',import.meta.url),'utf8'),context);
 vm.runInContext('const picked=[];let failed=0;selectLocation=(...args)=>picked.push(args);locationFailed=()=>failed++;locate(false);state.manual=true;',context);
 callbacks[0]!.success({coords:{latitude:34,longitude:109}});assert.equal(vm.runInContext('picked.length',context),0);
 vm.runInContext('state.manual=false;locate(false);state.manual=true;',context);callbacks[1]!.failure();assert.equal(vm.runInContext('failed',context),0);
 vm.runInContext('locate(true)',context);callbacks[2]!.success({coords:{latitude:34,longitude:109}});assert.equal(vm.runInContext('picked.length',context),1);
});

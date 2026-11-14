import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../frontend/route-visuals.js',import.meta.url),'utf8');
function setup(){
 const frames=new Map<number,(time:number)=>void>(),changes=new Set<()=>void>();let frameId=0;
 const media={matches:false,addEventListener(_type:string,fn:()=>void){changes.add(fn)},removeEventListener(_type:string,fn:()=>void){changes.delete(fn)}};
 const context=vm.createContext({window:{location:{href:'https://city.example/'}},URL,console,setTimeout,clearTimeout,matchMedia:()=>media,requestAnimationFrame:(fn:(time:number)=>void)=>{frames.set(++frameId,fn);return frameId},cancelAnimationFrame:(id:number)=>frames.delete(id)});
 vm.runInContext(source,context);
 return {context,visuals:context.window.WanderRouteVisuals,frames,media,reduce(){media.matches=true;changes.forEach(fn=>fn())},step(time:number){const callbacks=[...frames.values()];frames.clear();callbacks.forEach(fn=>fn(time));}};
}
const plain=(value:unknown)=>JSON.parse(JSON.stringify(value));
const luminance=(hex:string)=>hex.slice(1).match(/../g)!.map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i]!,0);
const model=(urls=['',''])=>({events:urls.map((url,i)=>({event_id:'e'+i,thumbnail_url:url})),plans:urls.map((_,i)=>({plan_id:'plan-'+i,itinerary:{stops:[{event_id:'e'+i}]}}))});

test('screen-space route strokes remain clear at low zoom and bounded at high zoom',()=>{
 const {visuals}=setup();let previous=0;
 for(let zoom=3;zoom<=20;zoom+=.25){const selected=visuals.stroke(zoom),other=visuals.stroke(zoom,false);assert(selected.width>=5&&selected.width<=8);assert(selected.width>=previous);assert(selected.width>other.width);assert(selected.border>=2);previous=selected.width;}
});

test('reversed road geometry is oriented from the first stop without inventing connectors',()=>{
 const {visuals}=setup(),path=[[.002,.001],[.001,.001],[.001,0],[0,0]];
 const oriented=visuals.orient(path,[0,0],[.002,.001]);assert.deepEqual(plain(oriented),[...path].reverse());assert.deepEqual(path[0],[.002,.001]);
 const forward=[[0,0],[.001,0]];assert.equal(visuals.orient(forward,[0,0],[.001,0]),forward);
});

test('route reveal follows road vertices and finishes each leg before starting the next',()=>{
 const h=setup(),shown:number[][][]=[[],[]],paths=[[[0,0],[.001,0],[.001,.001]],[[.001,.001],[.002,.001]]];
 h.visuals.animate(paths.map((path,i)=>({path,show:(part:number[][])=>{shown[i]=plain(part)}})));
 h.step(0);h.step(600);assert(shown[0]!.length>=2);assert(shown[0]!.at(-1)![0]<=.001);assert.deepEqual(shown[1],[[.001,.001],[.001,.001]]);
 h.step(1450);assert.deepEqual(shown[0],paths[0]);assert(shown[1]!.at(-1)![0]>.001);assert.equal(shown[1]!.at(-1)![1],.001);
 h.step(4000);assert.deepEqual(shown,paths);assert.equal(h.frames.size,0);
});

test('switching cancels obsolete animation callbacks; reduced motion completes immediately',()=>{
 const h=setup(),path=[[0,0],[.01,.01]],shown:number[][][]=[],stop=h.visuals.animate([{path,show:(part:number[][])=>shown.push(plain(part))}]);
 const stale=[...h.frames.values()][0]!;stop();const count=shown.length;stale(1000);assert.equal(shown.length,count);assert.equal(h.frames.size,0);
 h.visuals.animate([{path,show:(part:number[][])=>shown.push(plain(part))}]);h.step(0);h.step(500);h.reduce();assert.deepEqual(shown.at(-1),path);assert.equal(h.frames.size,0);
 h.visuals.animate([{path,show:(part:number[][])=>shown.push(plain(part))}]);assert.deepEqual(shown.at(-1),path);assert.equal(h.frames.size,0);
});

test('long itineraries finish within 3.6 seconds and separated legs stay separated',()=>{
 const h=setup(),parts:number[][][]=[[],[]],paths=[[[0,0],[1,0]],[[10,10],[12,11]]];
 h.visuals.animate(paths.map((path,i)=>({path,show:(part:number[][])=>parts[i]=plain(part)})));h.step(0);h.step(3600);assert.deepEqual(parts,paths);assert.equal(h.frames.size,0);
});

test('fallback palettes are stable, distinct and contrast against the light basemap',async()=>{
 const h=setup(),input=model(),first=await h.visuals.palette(input),again=await h.visuals.palette(structuredClone(input));assert.equal(first,again);
 const [a,b]=[...first.values()];assert.equal(a.source,'fallback');assert.notEqual(a.color,b.color);assert(Math.min(Math.abs(a.hue-b.hue),360-Math.abs(a.hue-b.hue))>=75);
 for(const value of first.values())assert((luminance('#edf2e8')+.05)/(luminance(value.color)+.05)>=4.5);
});

test('thumbnail colors are sampled once before display and CORS failures use a stable fallback',async()=>{
 const h=setup();let loads=0,currentURL='';
 h.context.Image=class{onload:(()=>void)|null=null;onerror:(()=>void)|null=null;crossOrigin='';referrerPolicy='';set src(url:string){loads++;currentURL=url;assert.equal(this.crossOrigin,'anonymous');queueMicrotask(()=>url.includes('blocked')?this.onerror?.():this.onload?.());}};
 h.context.document={createElement:()=>({getContext:()=>({drawImage(image:unknown){},getImageData:()=>({data:new Uint8ClampedArray([28,90,200,255,28,90,200,255])})})})};
 const input=model(['/blue.jpg','https://images.example/blocked.jpg']),first=await h.visuals.palette(input);assert.equal(first.get('plan-0').source,'thumbnail');assert.equal(first.get('plan-1').source,'fallback');
 assert(currentURL.endsWith('blocked.jpg'));assert.equal(loads,2);assert.equal(await h.visuals.palette(structuredClone(input)),first);assert.equal(loads,2);
 assert.equal(h.visuals.extractHue(new Uint8ClampedArray([255,255,255,255,0,0,0,0])),null);
 assert.equal(h.visuals.extractHue(new Uint8ClampedArray([255,0,0,255])),0,'bright poster colors are not discarded as white highlights');
});

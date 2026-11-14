import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const context=vm.createContext({window:{}});
vm.runInContext(readFileSync(new URL('../frontend/map-layout.js',import.meta.url),'utf8'),context);
const frame=context.window.WanderMapLayout.routeFrame;
test('desktop route midpoint is two thirds across and camera padding clears the left card',()=>{
 for(const [width,right] of [[1440,488],[1920,536]]){
  const f=frame({width,height:900,card:{right,height:844}});
  assert(Math.abs(f.targetX-width*2/3)<1e-8);assert(f.left>right);
  assert.deepEqual(Array.from(f.amap),[f.top,f.bottom,f.left,f.right],'AMap uses top,bottom,left,right');
  assert.deepEqual(Array.from(f.paddingTopLeft),[f.left,f.top]);assert.deepEqual(Array.from(f.paddingBottomRight),[f.right,f.bottom]);
 }
});
test('compact screens keep routes within the visible map above or beside the card',()=>{
 const narrow=frame({width:823,height:880,card:{right:370,height:824}});assert(narrow.left>370);assert(narrow.targetX>370&&narrow.targetX<823);
 const mobile=frame({width:390,height:844,card:{right:378,height:464}});assert.equal(mobile.targetX,195);assert(mobile.targetY<844-464);assert(mobile.top+mobile.bottom<844);
});
test('conversation reading order puts messages above input and history below input',()=>{
 const html=readFileSync(new URL('../frontend/index.html',import.meta.url),'utf8');
 assert(html.indexOf('id="messages"')<html.indexOf('id="chat-form"'));
 assert(html.indexOf('id="chat-form"')<html.indexOf('id="history-list"'));
});

test('route frame avoids expanded right panels and remains unchanged for offscreen panels',()=>{
 const view={width:1440,height:900,card:{right:488,height:844}};
 const panel={left:966,right:1412,top:86,bottom:528};
 const f=frame({...view,panels:[panel]});
 assert(f.left>=528);assert(f.left<1440-f.right);assert(f.top<900-f.bottom);
 assert(1440-f.right<=panel.left-24||f.top>=panel.bottom+24||900-f.bottom<=panel.top-24);
 assert.deepEqual(JSON.parse(JSON.stringify(frame({...view,panels:[{left:1450,right:1900,top:0,bottom:500}]}))),JSON.parse(JSON.stringify(frame(view))));
});

test('compact route frame can use map space below a right panel instead of a sliver beside it',()=>{
 const panel={left:440,right:803,top:60,bottom:460},f=frame({width:823,height:880,card:{right:370,height:824},panels:[panel]});
 assert(f.top>=484);assert(f.left>370);assert(823-f.left-f.right>300);assert(f.top+f.bottom<880);
});

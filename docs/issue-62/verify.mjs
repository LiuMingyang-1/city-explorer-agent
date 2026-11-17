// Run with FRONTEND_PORT=5462 npm run dev:frontend, then node docs/issue-62/verify.mjs.
// Real Chromium + real avatar modules; explicit fixture transport, no LLM call.
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const chrome=process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile=mkdtempSync(join(tmpdir(),'avatars-62-'));
const proc=spawn(chrome,['--headless=new','--no-first-run','--remote-debugging-port=9462','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws;
try{
 let targets;for(let i=0;i<60;i++){try{targets=await(await fetch('http://127.0.0.1:9462/json/list')).json();break;}catch{await sleep(100);}}
 ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
 let seq=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}};
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,m=>m.error?reject(m.error):resolve(m.result));ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async(expression)=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
 const expect=async(expr)=>assert.equal(await evaluate(expr),true,expr);
 const wait=async(expr)=>{for(let i=0;i<100;i++){if(await evaluate(expr))return;await sleep(50);}throw new Error('Timed out: '+expr);};
 const nav=async(mock='answer')=>{await cdp('Page.navigate',{url:'http://127.0.0.1:5462/?mock='+mock});await wait('!!window.WanderMascot && !!window.WanderHistory && !!window.WanderUserAvatar');await sleep(500);};
 const send=async(text)=>{await evaluate('window.sendMessage('+JSON.stringify(text)+')');await wait('!state.busy');};
 for(const [name,width,height]of [['desktop',1280,900],['mobile',390,844],['narrow',320,568]]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<700});
  await nav();await evaluate('window.WanderHistory.newChat()');
  await expect('!document.querySelector(".glass-card > boop-face") && !document.querySelector("boop-face")');
  await send('想逛独立书店');await wait('!!document.querySelector(".assistant-avatar boop-face")');
  await expect('document.querySelectorAll(".message-avatar").length===2');
  await evaluate('window.__old=document.querySelector(".assistant-avatar boop-face");window.__pose=()=>document.querySelector(".assistant-avatar boop-face")?.shadowRoot.getElementById("wander-pose").getAttribute("transform");window.__before=window.__pose()');
  await sleep(160);await expect('window.__pose()!==window.__before');
  await send('再推荐一个');
  await expect('document.querySelectorAll(".assistant-avatar boop-face").length===1 && !window.__old.isConnected && window.__old._raf===0');
  await expect('[...document.querySelectorAll(".assistant-avatar img")].every(i=>i.complete&&i.naturalWidth>0)');
  await evaluate('window.__frozen=document.querySelector(".assistant-avatar img").src');await sleep(180);
  await expect('document.querySelector(".assistant-avatar img").src===window.__frozen');
  await evaluate('window.WanderUserAvatar.setName("👩🏽‍💻老绵羊")');
  await expect('[...document.querySelectorAll("[data-user-avatar]")].every(e=>e.textContent==="👩🏽‍💻")');
  await expect('[...document.querySelectorAll(".message")].every(e=>e.scrollWidth<=e.clientWidth+1)');
  await evaluate('document.getElementById("auth-open").click()');await expect('!document.getElementById("auth-panel").hidden');await evaluate('document.getElementById("auth-open").click()');
  await evaluate('document.getElementById("messages").scrollTo({top:document.getElementById("messages").scrollHeight,behavior:"instant"})');await sleep(150);
  const shot=await cdp('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(name+'.png',import.meta.url),Buffer.from(shot.data,'base64'));
  await evaluate('window.__historyId=window.WanderHistory;window.WanderHistory.capture();window.__entry=JSON.parse(localStorage.getItem("wander.chat-history.v1.demo.guest"))[0].id;window.WanderHistory.newChat();window.WanderHistory.open(window.__entry)');
  await expect('document.querySelectorAll(".assistant-avatar").length===2 && !document.querySelector(".assistant-avatar boop-face")');
  await expect('[...document.querySelectorAll(".assistant-avatar img")].every(i=>i.complete&&i.naturalWidth>0)');
  await send('继续');await expect('document.querySelectorAll(".assistant-avatar boop-face").length===1');
  await evaluate('window.WanderHistory.newChat()');await expect('!document.querySelector(".message-avatar") && !document.querySelector(".glass-card > boop-face")');
  console.log(name+': avatars, animation, static snapshots, account entry, history, reset, overflow passed');
 }
 await nav('comparison');await send('安排半日游');await expect('!!document.querySelector(".plan-bubble") && !!document.querySelector(".assistant-avatar boop-face")');
 await nav('clarification');await send('随便玩玩');await expect('!!document.querySelector(".assistant-avatar boop-face")');
 await nav('error');await send('失败重试');await expect('!!document.querySelector(".retry-button") && document.querySelectorAll(".assistant-avatar boop-face").length===1');
 await evaluate('document.querySelector(".retry-button").click()');await wait('!state.busy');await expect('document.querySelectorAll(".assistant-avatar boop-face").length===1');
 await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await nav();await send('减少动画');
 await evaluate('window.__pose=()=>document.querySelector(".assistant-avatar boop-face").shadowRoot.getElementById("wander-pose").getAttribute("transform")');await sleep(400);await evaluate('window.__before=window.__pose()');await sleep(160);await expect('window.__before===window.__pose()');
 console.log('plan / clarification / error / retry / reduced motion passed');
}finally{ws?.close();proc.kill();await sleep(150);rmSync(profile,{recursive:true,force:true});}

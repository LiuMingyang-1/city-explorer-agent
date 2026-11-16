#!/usr/bin/env node
// Issue #37 verification driver: serves a frontend build with the built-in
// ?mock= plan transport, drives headless Chromium over CDP, and captures
// screenshots + layout metrics for the plan preview card.
//
//   node docs/issue-24/capture.mjs --root <frontend> --mocks <docs/mocks/day0> --out <dir> [--profile=before|after]
//
// Mock scope: the page runs with ?mock=comparison / ?mock=single so
// WanderTransport serves plan fixtures from /__mocks/day0/ (aliased to
// --mocks). /api/me answers {authenticated:false}; other /api/* return 404
// so the page exercises its real fallbacks (/data/demo-events.json, OSM
// raster tiles). Fixture payloads are served with coordinate_system patched
// GCJ-02 -> WGS84 so the real Leaflet draw path runs without an AMap key.
// External calls (map tiles, open-meteo, nominatim) hit the real network.
import {createServer} from 'node:http';
import {createReadStream, existsSync, mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import {resolve, sep, extname, join} from 'node:path';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';

const argv = process.argv.slice(2); const args = {};
for (let i = 0; i < argv.length; i++) {const a = argv[i].replace(/^--/, ''); const eq = a.indexOf('=');
  if (eq > 0) args[a.slice(0, eq)] = a.slice(eq + 1); else {args[a] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;}}
const root = resolve(args.root || 'frontend');
const mockRoot = resolve(args.mocks || 'docs/mocks/day0');
const outDir = resolve(args.out || 'docs/issue-37/after');
const profile = args.profile || 'after';
const only = args.only || null; // 'narrow' re-shoots just the 390px card shots
const port = Number(args.port || 5437);
const CHROME = args.chrome || [
  '/Users/lmy/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const mime = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.sse': 'text/event-stream', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2'};
const mockFiles = new Set(['response-comparison.json', 'response-single.json', 'response-partial.json',
  'response-clarification.json', 'stream.sse', 'stream-error.sse']);
// Fixtures ship GCJ-02 because the production web backend serves AMap; this
// harness has no AMap key, so patch to WGS84 to exercise the real Leaflet
// route-drawing path (draw() accepts WGS84 without WanderAMap).
const wgs = text => args.amap ? text : text.replace(/"coordinate_system"\s*:\s*"GCJ-02"/g, '"coordinate_system":"WGS84"');

// --- mock + static server -------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;
  if(path === '/api/events'){
 const fixture=JSON.parse(readFileSync(resolve(mockRoot,'response-comparison.json'),'utf8'));
 const extra={...fixture.events[0],event_id:'nearby_outsider',title:'验收专用·行程外活动',latitude:34.25,longitude:108.99,is_demo:true};
 res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({coordinate_system:'WGS84',is_demo:true,events:[...fixture.events,extra]}));return;
 }
 if(path === '/api/map-config'||path.startsWith('/_AMapService/')){
 try{const upstream=await fetch('http://127.0.0.1:5455'+path+url.search);res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/json'});res.end(Buffer.from(await upstream.arrayBuffer()));}catch{res.writeHead(502).end('Map proxy unavailable')}return;
 }
 if (path === '/api/me') {res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'}).end('{"authenticated":false}'); return;}
  if (path.startsWith('/api/')) {res.writeHead(404).end('Not found'); return;}
  if (req.method !== 'GET' && req.method !== 'HEAD') {res.writeHead(405).end('Method not allowed'); return;}
  const mockFile = path.startsWith('/__mocks/day0/') ? path.slice('/__mocks/day0/'.length) : null;
  try {
    if (mockFile !== null) {
      const file = resolve(mockRoot, mockFile);
      if (!mockFiles.has(mockFile) || !(await stat(file)).isFile()) {res.writeHead(404).end('Not found'); return;}
      res.writeHead(200, {'Content-Type': (mime[extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-cache'});
      res.end(wgs(readFileSync(file, 'utf8'))); return;
    }
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : decodeURIComponent(path)));
    if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) {res.writeHead(404).end('Not found'); return;}
    res.writeHead(200, {'Content-Type': (mime[extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-cache'});
    if (req.method === 'HEAD') res.end(); else createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch {res.writeHead(404).end('Not found');}
});
await new Promise(r => server.listen(port, '127.0.0.1', r));

// --- minimal CDP client ----------------------------------------------------
const chrome = spawn(CHROME, ['--headless=new', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${tmpdir()}/issue37-chrome-${port}`, 'about:blank'], {stdio: ['ignore', 'pipe', 'pipe']});
const wsUrl = await new Promise((res, rej) => {let buf = ''; chrome.stderr.on('data', d => {buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]);}); chrome.on('exit', () => rej(new Error('chrome exited'))); setTimeout(() => rej(new Error('ws timeout')), 15000);});
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, {once: true}));
let seq = 0; const pending = new Map(); const events = new Map();
ws.addEventListener('message', ev => {const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);}
  else if (m.method) (events.get(m.method) || []).forEach(f => f(m.params));});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {const id = ++seq; pending.set(id, {res, rej}); ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));});
const on = (m, f) => events.set(m, [...(events.get(m) || []), f]);
const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
const cdp = (method, params) => send(method, params, sessionId);
await cdp('Page.enable'); await cdp('Runtime.enable');await cdp('Page.bringToFront');await cdp('Emulation.setFocusEmulationEnabled',{enabled:true});
const evaluate = async expr => (await cdp('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true})).result?.value;
const waitFor = async (expr, ms = 10000) => {const t0 = Date.now(); while (Date.now() - t0 < ms) {if (await evaluate(`Boolean(${expr})`)) return; await new Promise(r => setTimeout(r, 120));} throw new Error(`waitFor timeout (${ms}ms): ${expr.slice(0, 90)}`);};
const failures = []; const metrics = {}; const log = [];
const expect = (name, cond, info = {}) => {metrics[name] = {...info, assert: cond ? 'pass' : 'FAIL'}; if (!cond) {failures.push(name); log.push(`FAIL ${name}`);} return cond;};
let loaded; on('Page.loadEventFired', () => loaded = true);
const key = (k, code, keyCode, text = '') => cdp('Input.dispatchKeyEvent', {type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, text, unmodifiedText: text})
  .then(() => cdp('Input.dispatchKeyEvent', {type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode}));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async name => {const {data} = await cdp('Page.captureScreenshot', {format: 'png'}); writeFileSync(join(outDir, name + '.png'), Buffer.from(data, 'base64')); log.push(`shot ${name}`);};
const viewport = (w, h) => cdp('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: 1, mobile: w < 700});



mkdirSync(outDir,{recursive:true});
const probe=`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};const m=document.getElementById('map'),f=document.getElementById('itinerary-map-frame');
 return {ready:window.WanderAMap.ready,hasSDK:!!window.AMap,phase:window.WanderItineraryFocus.phase,map:rect(m),frame:rect(f),maps:document.querySelectorAll('#map').length,
  canvases:[...m.querySelectorAll('canvas')].map(c=>({rect:rect(c),width:c.width,height:c.height})),
  stations:[...document.querySelectorAll('.native-route-dot')].map(e=>(()=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {title:e.title,rect:rect(e),hitClass:typeof hit?.className==='string'?hit.className:'',centerHit:e===hit||e.contains(hit)}})()),
  scenes:[...document.querySelectorAll('.place-wrap')].map(e=>e.textContent),activities:document.querySelectorAll('.activity-bubble').length,
  status:document.getElementById('map-status').textContent,visibility:document.visibilityState};})()`;
const phase=p=>waitFor(`window.WanderItineraryFocus.phase===${JSON.stringify(p)}`,10000);
const capture=async name=>metrics[name]=await evaluate(probe);
const checkDetail=(name,s,label)=>{
 expect(name+'-ready',s.ready&&s.hasSDK);expect(name+'-single-map',s.maps===1);
 expect(name+'-geometry',['x','y','w','h'].every(k=>Math.abs(s.map[k]-s.frame[k])<1),s);
 const c=s.frame;const values=s.stations.map(p=>Math.hypot(p.rect.x+p.rect.w/2-c.x-c.w/2,p.rect.y+p.rect.h/2-c.y-c.h/2)/c.w);
 expect(name+'-stations',s.stations.length===2&&s.stations.every(p=>p.title.startsWith('方案 '+label)),s);
 expect(name+'-safe-circle',values.length===2&&values.every(r=>r<.44),{values});expect(name+'-station-unobscured',s.stations.every(p=>p.centerHit),{stations:s.stations});
 expect(name+'-canvas',s.canvases.length>0&&s.canvases.some(c=>c.width>0&&c.height>0),s.canvases);
};
try{
 await viewport(1440,900);await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/?mock=comparison`});
 await waitFor(`window.WanderAMap && window.WanderPlans`,15000);await waitFor(`window.WanderAMap.ready`,35000);await sleep(1500);
 metrics.initial=await capture('initial');await shot('initial');
 await evaluate(`const i=document.getElementById('message-input');i.value='帮我规划半天';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('chat-form').requestSubmit()`);await waitFor(`document.querySelector('.plan-preview')`,20000);await sleep(2000);metrics.generated=await capture('generated');await shot('generated');
 for(const [name,w,h] of [['desktop',1440,900],['narrow',390,844],['small',320,844]]){
  await viewport(w,h);await sleep(600);const samples=await evaluate(`new Promise(resolve=>{const rows=[],start=performance.now();let last=-100;const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
 const loop=()=>{const elapsed=performance.now()-start;if(elapsed-last>=90){last=elapsed;const m=document.getElementById('map');rows.push({elapsed,phase:window.WanderItineraryFocus.phase,map:rect(m),frame:rect(document.getElementById('itinerary-map-frame')),stations:[...document.querySelectorAll('.native-route-dot')].map(e=>(()=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {title:e.title,rect:rect(e),hitClass:typeof hit?.className==='string'?hit.className:'',centerHit:e===hit||e.contains(hit)}})()),canvases:[...m.querySelectorAll('canvas')].map(c=>({rect:rect(c),width:c.width,height:c.height}))})}if(elapsed<1600)requestAnimationFrame(loop);else resolve(rows)};
 document.querySelector('.plan-preview').click();requestAnimationFrame(loop)})`);
 metrics[name+'-frames']=samples;const stableSamples=samples.filter(r=>r.phase==='detail');expect(name+'-stable-tail',stableSamples.length>=3&&stableSamples.slice(-3).every(r=>JSON.stringify(r.stations)===JSON.stringify(stableSamples.at(-1).stations)),{samples:stableSamples});await phase('detail');await sleep(500);
  const a=await capture(name+'-a');checkDetail(name+'-a',a,'A');await shot(name+'-detail-a');
  await sleep(400);const stable=await capture(name+'-stable');expect(name+'-stable-stations',JSON.stringify(a.stations)===JSON.stringify(stable.stations));
  await evaluate(`document.querySelectorAll('.plan-tab')[1].click()`);await sleep(1600);const b=await capture(name+'-b');checkDetail(name+'-b',b,'B');await shot(name+'-detail-b');
  await evaluate(`document.querySelector('.plan-back').click()`);await phase('explore');await sleep(700);const returned=await capture(name+'-returned');expect(name+'-restored-routes',returned.stations.length===4,returned);await shot(name+'-returned');
  await evaluate(`document.querySelectorAll('.plan-tab')[0].click()`);await sleep(800);
 }
 await viewport(390,844);await sleep(600);
 await evaluate(`document.querySelector('.plan-preview').click()`);await sleep(80);await evaluate(`document.querySelector('.plan-back').click()`);await sleep(80);await evaluate(`document.querySelector('.plan-preview').click();document.querySelectorAll('.plan-tab')[1].click()`);await phase('detail');await sleep(1000);checkDetail('rapid-b',await capture('rapid-b'),'B');await shot('rapid-b');
 await evaluate(`window.WanderHistory.capture();document.getElementById('new-chat').click()`);await sleep(1200);const reset=await capture('reset');expect('reset-clear',reset.stations.length===0&&reset.phase==='explore',reset);
 await evaluate(`document.querySelector('.history-entry').click()`);await waitFor(`document.querySelector('.plan-preview')`);await sleep(1500);expect('history-explore',(await capture('history')).phase==='explore');
 await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await evaluate(`document.querySelector('.plan-preview').click()`);await sleep(300);await phase('detail');await sleep(500);checkDetail('reduced-restored-b',await capture('reduced-restored-b'),'B');await shot('reduced-restored-b');
 await evaluate(`document.querySelector('.plan-back').click()`);await sleep(300);expect('reduced-return',(await capture('reduced-return')).phase==='explore');
}catch(e){failures.push('fatal: '+e.message);try{metrics.failure=await capture('failure');await shot('fatal')}catch{}}
finally{writeFileSync(join(outDir,'metrics.json'),JSON.stringify({profile:'real-amap-original-gcj-fixture',failures,metrics,log},null,2));chrome.kill('SIGKILL');server.close();ws.close();}
console.log('AMap failures',failures);process.exitCode=failures.length?1:0;

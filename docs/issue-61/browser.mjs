// #61 browser regression. Real AMap: --amap plus proxy on 5455
// (FRONTEND_PORT=5455 npm run dev:frontend). Otherwise real Leaflet.
// Plan data comes from the Day 0 fixture; no LLM call is made.
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
const outDir = resolve(args.out || 'docs/issue-61/browser');
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
 if(path==='/api/map-config'&&!args.amap){res.writeHead(200,{'Content-Type':'application/json'}).end('{"enabled":false}');return;}
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
  '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${tmpdir()}/issue61-chrome-${port}`, 'about:blank'], {stdio: ['ignore', 'pipe', 'pipe']});
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
const evaluate = async expr => {const r=await cdp('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
const waitFor = async (expr, ms = 10000) => {const t0 = Date.now(); while (Date.now() - t0 < ms) {if (await evaluate(`Boolean(${expr})`)) return; await new Promise(r => setTimeout(r, 120));} throw new Error(`waitFor timeout (${ms}ms): ${expr.slice(0, 90)}`);};
const failures = []; const metrics = {}; const log = [];
const expect = (name, cond, info = {}) => {metrics[name] = {...info, assert: cond ? 'pass' : 'FAIL'}; if (!cond) {failures.push(name); log.push(`FAIL ${name}`);} return cond;};
let loaded; on('Page.loadEventFired', () => loaded = true);
const key = (k, code, keyCode, text = '') => cdp('Input.dispatchKeyEvent', {type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, text, unmodifiedText: text})
  .then(() => cdp('Input.dispatchKeyEvent', {type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode}));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async name => {const {data} = await cdp('Page.captureScreenshot', {format: 'png'}); writeFileSync(join(outDir, name + '.png'), Buffer.from(data, 'base64')); log.push(`shot ${name}`);};
const viewport = (w,h)=>cdp('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile:w<700});
mkdirSync(outDir,{recursive:true});
try{
 for(const [name,w,h] of [['desktop',1440,900],['mobile',390,844]]){
  await viewport(w,h);
  await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/?mock=comparison`});
  await waitFor(args.amap?'window.WanderAMap?.ready && window.WanderPlans':'window.WanderPlans && typeof map!=="undefined" && typeof map?.fitBounds==="function"');
  await evaluate(`(async()=>{const p=await fetch('/__mocks/day0/response-comparison.json').then(r=>r.json());window.WanderPlans.append(p);})()`);
  await waitFor('document.querySelector(".plan-preview")');await sleep(800);
  await evaluate(`window.__counts={resize:0,fit:0,draw:0};for(const [method,key] of [['resize','resize'],['fitRoutes','fit'],['drawPlans','draw']]){if(window.WanderAMap?.ready){const fn=window.WanderAMap[method];window.WanderAMap[method]=function(...a){window.__counts[key]++;return fn.apply(this,a);};}}`);
  const sample=await evaluate(`(async()=>{const gaps=[],sizes=new Set();let last=performance.now(),until=last+1100;document.querySelector('.plan-preview').click();await new Promise(resolve=>{function tick(now){gaps.push(now-last);last=now;const m=document.getElementById('map');sizes.add(m.clientWidth+','+m.clientHeight);if(now<until)requestAnimationFrame(tick);else resolve();}requestAnimationFrame(tick);});return {maxGap:Math.max(...gaps),over50:gaps.filter(n=>n>50).length,frames:gaps.length,sizes:[...sizes],counts:{...window.__counts}};})()`);
  await waitFor('window.WanderItineraryFocus.phase==="detail"');
  const inspect=()=>evaluate(`(()=>{const f=window.WanderItineraryFocus,m=document.getElementById('map').getBoundingClientRect(),labels=[...document.querySelectorAll('.route-stop-name')];return {plan:f.model.active_plan,expected:f.model.plans.find(p=>p.plan_id===f.model.active_plan).itinerary.stops.map(s=>f.model.events.find(e=>e.event_id===s.event_id).title),labels:labels.map(l=>({name:l.textContent,inside:(()=>{const r=l.getBoundingClientRect();return r.left>=m.left-1&&r.right<=m.right+1&&r.top>=m.top-1&&r.bottom<=m.bottom+1;})()}))};})()`);
  let state=await inspect();
  expect(name+' labels A',JSON.stringify(state.labels.map(l=>l.name).sort())===JSON.stringify(state.expected.sort()),state);
  expect(name+' bubbles in frame',state.labels.every(l=>l.inside),state);
  expect(name+' stable SDK layout',sample.sizes.length===1,sample);
  if(args.amap)expect(name+' bounded SDK work',sample.counts.resize<=2&&sample.counts.fit<=3&&sample.counts.draw===1,sample);
  await shot(name+'-a');
  await evaluate(`document.querySelectorAll('#plan-detail .plan-tab')[1].click()`);await sleep(700);state=await inspect();
  expect(name+' labels B',JSON.stringify(state.labels.map(l=>l.name).sort())===JSON.stringify(state.expected.sort()),state);await shot(name+'-b');
  const close=await evaluate(`(async()=>{window.__counts.resize=0;window.__counts.fit=0;document.querySelector('.plan-back').click();const gaps=[];let last=performance.now(),end=last+1100;await new Promise(resolve=>{function tick(now){gaps.push(now-last);last=now;if(now<end)requestAnimationFrame(tick);else resolve();}requestAnimationFrame(tick);});return {maxGap:Math.max(...gaps),over50:gaps.filter(n=>n>50).length,frames:gaps.length,counts:{...window.__counts}};})()`);
  await waitFor('window.WanderItineraryFocus.phase==="explore"');
  expect(name+' closed labels',await evaluate(`document.querySelectorAll('.route-stop-name').length===0`),close);
  await evaluate(`(async()=>{document.querySelector('.plan-preview').click();await new Promise(r=>setTimeout(r,170));document.querySelector('.plan-back').click();await new Promise(r=>setTimeout(r,150));document.querySelector('.plan-preview').click();})()`);
  await waitFor('window.WanderItineraryFocus.phase==="detail"');
  expect(name+' reversed animation settles',await evaluate(`(()=>{const a=document.getElementById('map-shell').getBoundingClientRect(),b=document.getElementById('itinerary-map-frame').getBoundingClientRect();return ['left','top','width','height'].every(k=>Math.abs(a[k]-b[k])<1);})()`));
  await evaluate(`document.getElementById('new-chat').click()`);await sleep(200);
  expect(name+' reset clears labels',await evaluate(`!window.WanderItineraryFocus.active&&document.querySelectorAll('.route-stop-name').length===0`));
 }
 writeFileSync(join(outDir,'metrics.json'),JSON.stringify({provider:args.amap?'real AMap SDK':'real Leaflet',metrics,failures},null,2));
 console.log(JSON.stringify({outDir,failures,metrics},null,2));
 process.exitCode=failures.length?1:0;
}finally{await send('Browser.close').catch(()=>{});ws.close();chrome.kill();server.close();}

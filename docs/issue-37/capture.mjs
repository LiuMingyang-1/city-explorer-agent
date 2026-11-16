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
const wgs = text => text.replace(/"coordinate_system"\s*:\s*"GCJ-02"/g, '"coordinate_system":"WGS84"');

// --- mock + static server -------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;
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

// Contract checks run in a real browser; no duplicate transition implementation.
const stateExpr = `(() => {
 const s=window.WanderItineraryFocus, shell=document.getElementById('map-shell'), mapElement=document.getElementById('map'), frame=document.getElementById('itinerary-map-frame');
 const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
 return {phase:s?.phase,active:s?.active,plan:s?.model?.active_plan,plans:s?.model?.plans?.length,
  shell:shell&&rect(shell),frame:frame&&rect(frame),map:rect(mapElement),
  clip:shell&&getComputedStyle(shell).clipPath,radius:shell&&getComputedStyle(shell).borderRadius,shellFeather:shell&&getComputedStyle(shell,'::after').backgroundImage,shellFeatherOpacity:shell&&getComputedStyle(shell,'::after').opacity,
  canvases:[...mapElement.querySelectorAll('canvas')].map(c=>({rect:rect(c),width:c.width,height:c.height})),
  stationPoints:(()=>{try{if(typeof map==='undefined'||!map||!s?.model)return [];const p=s.model.plans.find(p=>p.plan_id===s.model.active_plan);return p.itinerary.stops.map(stop=>{const e=s.model.events.find(e=>e.event_id===stop.event_id);const q=map.latLngToContainerPoint([e.latitude,e.longitude]);return {event:e.event_id,x:q.x,y:q.y}})}catch{return []}})(),
  stationRects:[...document.querySelectorAll('.route-station-number')].map(rect),
  markers:document.querySelectorAll('.place-icon').length,
  mapSame:mapElement===window.__originalMap,
  maps:document.querySelectorAll('#map').length,focus:document.activeElement?.className,
  transitioning:document.body.classList.contains('itinerary-transition'),
  detail:!document.getElementById('plan-detail').hidden,
  overflow:document.documentElement.scrollWidth>innerWidth+1,
  sdk:window.WanderAMap?.ready?'AMap':(window.L?'Leaflet':'unavailable'),
  mask:shell&&getComputedStyle(shell).maskImage,
  shadow:shell&&getComputedStyle(shell).boxShadow,
  events:window.__focusEvents||[]};})()`;
const check=async(name,phase,active)=>{const s=await evaluate(stateExpr);metrics[name]=s;
 expect(name+'-state',s.phase===phase&&s.active===active,s);
 expect(name+'-one-map',s.maps===1&&s.mapSame);
 expect(name+'-no-overflow',!s.overflow);return s;};
const phase=p=>waitFor(`window.WanderItineraryFocus?.phase===${JSON.stringify(p)}`,6000);
const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
const open=()=>click('.plan-preview');
const close=()=>click('.plan-back');
const generate=async()=>{await evaluate(`(()=>{const i=document.getElementById('message-input');i.value='帮我规划一个下午';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('chat-form').requestSubmit();})()`);
 await waitFor(`document.querySelector('.plan-preview')`,20000);await sleep(1200);};
const setupPage=async(w,h,reduced=false)=>{
 await viewport(w,h);await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]});
 await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/?mock=comparison`});
 await waitFor(`window.WanderPlans && window.WanderHistory`,15000);
 await evaluate(`localStorage.clear();window.__originalMap=document.getElementById('map');window.__focusEvents=[];
 window.addEventListener('wander:itinerary-focus',e=>{const s=window.WanderItineraryFocus;
 const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
 const actual=rect(document.getElementById('map-shell')),target=rect(e.detail.active?document.getElementById('itinerary-map-frame'):document.querySelector('.canvas'));
 window.__focusEvents.push({phase:e.detail.phase,active:e.detail.active,plan:e.detail.model?.active_plan,same:s?.phase===e.detail.phase&&s?.model===e.detail.model,actual,target,atTarget:['x','y','w','h'].every(k=>Math.abs(actual[k]-target[k])<1)});});`);
 await generate();};
mkdirSync(outDir,{recursive:true});
try {
 for(const [name,w,h] of [['desktop',1440,900],['narrow',390,844]]){
  await setupPage(w,h);await check(name+'-generated','explore',false);await shot(name+'-explore');
  await evaluate(`document.querySelector('.plan-preview').focus()`);await key('Enter','Enter',13,'\r');
  await sleep(150);metrics[name+'-middle']=await evaluate(stateExpr);await shot(name+'-entering');
  await phase('detail');await sleep(450);const detail=await check(name+'-detail','detail',true);await shot(name+'-detail');
  await key('Tab','Tab',9);const focused=await evaluate(`({insideHiddenCard:!!document.activeElement?.closest('.glass-card'),cls:document.activeElement?.className})`);expect(name+'-tab-not-hidden-card',!focused.insideHiddenCard,focused);
  expect(name+'-full-model',detail.plans===2&&detail.plan==='plan_mock_a');
  expect(name+'-region',detail.frame&&Math.abs(detail.frame.x+detail.frame.w-w)<2&&detail.frame.y<2&&detail.frame.w<w&&detail.frame.h<=h&&!detail.radius?.includes('50%')&&parseFloat(detail.radius||'0')===0,{frame:detail.frame,radius:detail.radius});
  expect(name+'-edge',detail.shellFeather?.includes('radial-gradient')&&detail.shellFeather?.includes('linear-gradient')&&(detail.shellFeather.match(/radial-gradient/g)||[]).length>=2,{feather:detail.shellFeather});
  await click('.plan-tab:nth-child(2)');await sleep(1000);const b=await check(name+'-b','detail',true);
  expect(name+'-switch-model',b.plan==='plan_mock_b');await shot(name+'-detail-b');
  await key('Escape','Escape',27);await phase('explore');const back=await check(name+'-back','explore',false);
  expect(name+'-focus-return',back.focus?.includes('plan-preview'));await shot(name+'-returned');
  // Reversal during entering, followed by a new open and B switch.
  await open();await sleep(80);await close();await sleep(80);await open();await click('.plan-tab:nth-child(2)');
  await phase('detail');await sleep(900);const burst=await check(name+'-burst','detail',true);
  expect(name+'-burst-model',burst.plan==='plan_mock_b');await close();await phase('explore');
  await evaluate(`window.WanderHistory.capture();document.getElementById('new-chat').click()`);
  await check(name+'-new-chat','explore',false);
  await click('#history-list > :first-child');await waitFor(`document.querySelector('.plan-preview')`);
  await check(name+'-history','explore',false);await open();await phase('detail');
  const restored=await check(name+'-restored-detail','detail',true);expect(name+'-restored-b',restored.plan==='plan_mock_b');await shot(name+'-restored');
  expect(name+'-events-match-global',restored.events.length>0&&restored.events.every(e=>e.same));
  expect(name+'-stable-event-geometry',restored.events.filter(e=>e.phase==='detail'||e.phase==='explore').every(e=>e.atTarget),{events:restored.events});
  const phases=restored.events.map(e=>e.phase);expect(name+'-event-phases',['entering','detail','leaving','explore'].every(p=>phases.includes(p)),{phases});
 }
 await setupPage(390,844,true);await open();await sleep(100);await check('reduced-detail','detail',true);await shot('reduced-detail');
 await close();await sleep(100);await check('reduced-back','explore',false);
} catch(e){failures.push('fatal: '+e.message);log.push(e.stack);try{metrics['fatal-state']=await evaluate(stateExpr);await shot('fatal')}catch{}}
finally{writeFileSync(join(outDir,'metrics.json'),JSON.stringify({profile,failures,metrics,log},null,2));chrome.kill('SIGKILL');server.close();ws.close();}
console.log(`captured -> ${outDir} | failures: ${failures.length}`);if(failures.length)console.log(failures.join('\n'));process.exitCode=failures.length?1:0;

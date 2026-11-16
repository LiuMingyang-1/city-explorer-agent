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
  if(path === '/api/events'){
 const fixture=JSON.parse(readFileSync(resolve(mockRoot,'response-comparison.json'),'utf8'));
 const extra={...fixture.events[0],event_id:'nearby_outsider',title:'验收专用·行程外活动',latitude:34.25,longitude:108.99,is_demo:true};
 res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({coordinate_system:'WGS84',is_demo:true,events:[...fixture.events,extra]}));return;
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
const probe=`(()=>{const placesOn=[],activities=[],stations=[],tracks=[],screenTracks=[];const mr=document.getElementById('map').getBoundingClientRect(),fr=document.getElementById('itinerary-map-frame').getBoundingClientRect();map.eachLayer(layer=>{
 const cls=layer.options?.icon?.options?.className;
 if(cls==='place-icon')placesOn.push(layer.options.title);
 if(cls==='activity-map-icon')activities.push(layer.options.title);
 if(layer.getTooltip?.()?.options?.className==='route-station-number'){const p=layer.getLatLng();stations.push({lat:p.lat,lng:p.lng,title:layer.getTooltip().getContent().title});}
 if(layer.options?.className==='route-track'){tracks.push(layer.getLatLngs().map(p=>[p.lat,p.lng]));screenTracks.push(layer.getLatLngs().map(p=>{const q=map.latLngToContainerPoint(p);return {x:mr.x+q.x,y:mr.y+q.y}}));}
 });return {phase:window.WanderItineraryFocus.phase,places:placesOn.sort(),activities:activities.sort(),stations,tracks,screenTracks,circle:{x:fr.x,y:fr.y,w:fr.width,h:fr.height},active:state.activePlanId,overflow:document.documentElement.scrollWidth>innerWidth+1}})()`;
const capture=async name=>metrics[name]=await evaluate(probe);
const phase=p=>waitFor(`window.WanderItineraryFocus.phase===${JSON.stringify(p)}`);
const sameView=async()=>{await evaluate(`map.setView([34.25,108.95],13,{animate:false});updatePlaceMarkers();window.dispatchEvent(new Event('wander:viewport'))`);await sleep(600)};
const checkDetail=(name,s,label)=>{
 expect(name+'-no-outside-business',s.places.length===0&&s.activities.length===0,s);
 expect(name+'-active-stations',s.stations.length===2&&s.stations.every(p=>p.title.startsWith('方案 '+label)),s);
 expect(name+'-single-route',s.tracks.length===1,s);
 const c=s.circle,points=s.screenTracks.flat();
 const ratios=points.map(p=>Math.hypot(p.x-c.x-c.w/2,p.y-c.y-c.h/2)/c.w);
 const box={left:Math.min(...points.map(p=>p.x)),right:Math.max(...points.map(p=>p.x)),top:Math.min(...points.map(p=>p.y)),bottom:Math.max(...points.map(p=>p.y))};
 expect(name+'-route-safe-in-circle',points.length>=2&&ratios.every(r=>r<.44),{ratios,box,circle:c});
};
try{
 await viewport(1440,900);await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/?mock=comparison`});await waitFor(`window.WanderPlans && typeof map!=='undefined' && map`,20000);await sleep(1000);
 await sameView();const before=await capture('before');expect('feed-outside-present',before.activities.includes('验收专用·行程外活动'),before);expect('curated-present',before.places.length>0,before);await shot('before');
 await evaluate(`const i=document.getElementById('message-input');i.value='半天';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('chat-form').requestSubmit()`);await waitFor(`document.querySelector('.plan-preview')`,20000);await sleep(1000);
 await sameView();const generated=await capture('generated');expect('explore-curated-retained',JSON.stringify(before.places)===JSON.stringify(generated.places),{before,generated});expect('explore-outside-feed-retained',generated.activities.includes('验收专用·行程外活动'),generated);expect('explore-two-routes',generated.tracks.length===2,generated);await shot('generated');
 await evaluate(`document.querySelector('.plan-preview').click()`);await phase('detail');await sleep(500);checkDetail('a',await capture('a'),'A');await shot('detail-a');
 await evaluate(`document.querySelectorAll('.plan-tab')[1].click()`);await sleep(1000);checkDetail('b',await capture('b'),'B');await shot('detail-b');
 // A real feed reload arriving in detail must not reveal off-plan business markers.
 await evaluate(`window.WanderActivities.reload()`);await sleep(200);checkDetail('late-feed',await capture('late-feed'),'B');
 // Resize while entering and rapid A/B selection converge to the requested plan.
 await evaluate(`document.querySelector('.plan-back').click()`);await phase('explore');await evaluate(`document.querySelector('.plan-preview').click();document.querySelectorAll('.plan-tab')[0].click();document.querySelectorAll('.plan-tab')[1].click()`);await viewport(390,844);await phase('detail');await sleep(500);checkDetail('resize-burst',await capture('resize-burst'),'B');expect('narrow-overflow',!metrics['resize-burst'].overflow);await shot('narrow-resize-burst');
 await evaluate(`document.querySelector('.plan-back').click()`);await phase('explore');await viewport(1440,900);await sleep(500);await sameView();const returned=await capture('returned');
 expect('return-curated-restored',JSON.stringify(returned.places)===JSON.stringify(before.places),{before,returned});expect('return-outside-feed-restored',returned.activities.includes('验收专用·行程外活动'),returned);expect('return-both-routes',returned.tracks.length===2,returned);await shot('returned');
 // Finish resetting during entry. A stale animation callback may not republish detail.
 await evaluate(`document.querySelector('.plan-preview').click();document.getElementById('new-chat').click()`);await sleep(1500);const reset=await capture('reset');expect('reset-stable',reset.phase==='explore'&&reset.stations.length===0&&reset.tracks.length===0,reset);await shot('reset');
}catch(e){failures.push('fatal: '+e.message);try{await shot('fatal')}catch{}}
finally{writeFileSync(join(outDir,'metrics.json'),JSON.stringify({profile:'business-leaflet',failures,metrics,log},null,2));chrome.kill('SIGKILL');server.close();ws.close();}
console.log('business failures',failures);process.exitCode=failures.length?1:0;

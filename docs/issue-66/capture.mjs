// Issue #66 browser regression: real SDKs, fixture plans, local read-only map-config proxy.
// node docs/issue-66/capture.mjs [--root frontend] [--out docs/issue-66/after] [--amap --upstream 8080]
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
const outDir = resolve(args.out || 'docs/issue-66/after');
const profile = args.profile || 'after';
const only = args.only || null; // 'narrow' re-shoots just the 390px card shots
const port = Number(args.port || 5466);
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
  if(args.amap && (path === '/api/map-config'||path.startsWith('/_AMapService/'))){
   try{const upstream=await fetch('http://127.0.0.1:'+Number(args.upstream||8080)+path+url.search);res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/json'}).end(Buffer.from(await upstream.arrayBuffer()));}catch{res.writeHead(502).end('Map proxy unavailable')}return;
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

// Contract checks run in a real browser; no duplicate transition implementation.

mkdirSync(outDir,{recursive:true});
const phase=p=>waitFor(`window.WanderItineraryFocus?.phase===${JSON.stringify(p)}`,10000);
const click=s=>evaluate(`document.querySelector(${JSON.stringify(s)})?.click()`);
const probe=`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
 const shell=document.getElementById('map-shell'),detail=document.getElementById('plan-detail'),m=document.getElementById('map');
 return {phase:window.WanderItineraryFocus.phase,sdk:window.WanderAMap?.ready?'AMap':'Leaflet',shell:rect(shell),map:rect(m),frame:rect(document.getElementById('itinerary-map-frame')),detail:rect(detail),card:rect(detail.querySelector('.event-card')),overflow:document.documentElement.scrollWidth>innerWidth,
 stations:[...document.querySelectorAll('.native-route-dot,.route-station-number')].map(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {rect:rect(e),hit:e===hit||e.contains(hit)}}),
 zoom:[...m.querySelectorAll('.amap-toolbar,.leaflet-control-zoom')].map(e=>({rect:rect(e),visible:getComputedStyle(e).visibility!=='hidden'})),maps:document.querySelectorAll('#map').length};})()`;
async function check(name,w,h){
 const s=await evaluate(probe);metrics[name]=s;
 expect(name+'-sdk',s.sdk===(args.amap?'AMap':'Leaflet'));
 expect(name+'-geometry',['left','top','width','height'].every(k=>Math.abs(s.map[k]-s.frame[k])<1));
 expect(name+'-overflow',!s.overflow);expect(name+'-one-map',s.maps===1);
 if(w>700&&profile!=='before'){
  const gap=s.shell.left-s.card.right;
  expect(name+'-content-gap',gap>=0&&gap<=36,{gap});
  expect(name+'-fills-right',Math.abs(s.shell.right-w)<1);
 }
 expect(name+'-stations',s.stations.length===2&&s.stations.every(p=>p.rect.left>=s.shell.left&&p.rect.top>=s.shell.top&&p.rect.right<=s.shell.right&&p.rect.bottom<=s.shell.bottom),{stations:s.stations});
 if(args.amap&&w>700)expect(name+'-native-station-hit',s.stations.every(p=>p.hit));
 expect(name+'-zoom',s.zoom.length===1&&s.zoom.every(z=>z.visible&&z.rect.left>=s.shell.left&&z.rect.bottom<=s.shell.bottom&&z.rect.right<=s.shell.right));
 await shot(name);
}
try{
 await viewport(1920,1080);await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/?mock=comparison`});
 await waitFor(`window.WanderPlans&&window.WanderItineraryMap`,15000);
 if(args.amap)await waitFor(`window.WanderAMap?.ready`,35000);
 else await waitFor(`typeof map!=='undefined'&&map`,15000);
 await evaluate(`const i=document.getElementById('message-input');i.value='帮我规划半天';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('chat-form').requestSubmit()`);
 await waitFor(`document.querySelector('.plan-preview')`,20000);await sleep(1600);
 await click('.plan-preview');await phase('detail');await sleep(1200);
 for(const [w,h] of [[1920,1080],[2560,1080],[1440,900],[1024,768],[823,880],[701,800],[700,844],[390,844],[320,568]]){
  await viewport(w,h);await sleep(1000);await check('focus-'+w,w,h);
 }
 await viewport(1440,900);await sleep(700);await click('#plan-detail .plan-tab:nth-child(2)');await sleep(1300);await check('switch-b',1440,900);
 await click('.plan-back');await phase('explore');await sleep(500);
 const back=await evaluate(`(()=>{const r=document.getElementById('map').getBoundingClientRect();return {left:r.left,width:r.width,height:r.height}})()`);
 expect('exit-full-map',back.left===0&&back.width===1440&&back.height===900,back);await shot('returned');
 await click('.plan-preview');await sleep(100);await viewport(1920,1080);await phase('detail');await sleep(700);await check('resize-during-entry',1920,1080);
 await click('.plan-back');await sleep(80);await click('.plan-preview');await phase('detail');await sleep(700);await check('rapid-reentry',1920,1080);
 await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await click('.plan-back');await phase('explore');await click('.plan-preview');await phase('detail');await sleep(500);await check('reduced',1920,1080);
 await evaluate(`window.WanderActivities.openEvents([window.WanderItineraryFocus.model.events[0]])`);await sleep(500);metrics.panel=await evaluate(`({visible:!document.getElementById('activity-detail').hidden})`);expect('details-open',metrics.panel.visible);await shot('activity-detail');
}catch(e){failures.push(e.message);try{await shot('fatal')}catch{}}
finally{writeFileSync(join(outDir,'metrics.json'),JSON.stringify({profile,provider:args.amap?'AMap':'Leaflet',failures,metrics,log},null,2));chrome.kill('SIGKILL');server.close();ws.close();}
console.log(JSON.stringify({failures,checks:Object.keys(metrics).length}));process.exitCode=failures.length?1:0;

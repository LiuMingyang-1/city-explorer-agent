#!/usr/bin/env node
// Issue #24 verification driver: serves a frontend build with the built-in
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
const outDir = resolve(args.out || 'docs/issue-24/capture');
const profile = args.profile || 'after';
const only = args.only || null; // 'narrow' re-shoots just the 390px card shots
const port = Number(args.port || 5424);
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
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${tmpdir()}/issue24-chrome-${port}`, 'about:blank'], {stdio: ['ignore', 'pipe', 'pipe']});
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
await cdp('Page.enable'); await cdp('Runtime.enable');
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

// Geometry + structure probe for the newest plan preview card on screen.
const CARD_EXPR = `(() => {const previews=[...document.querySelectorAll('.plan-preview')];
  const p=previews.at(-1); if(!p)return {count:previews.length};
  const r=p.getBoundingClientRect();
  const rect=e=>{const b=e.getBoundingClientRect();return {x:+b.x.toFixed(1),y:+b.y.toFixed(1),w:+b.width.toFixed(1),h:+b.height.toFixed(1)};};
  const icon=p.querySelector('.plan-preview-icon, svg, img');
  const iconRect=icon?rect(icon):null;
  const iconStyle=icon?getComputedStyle(icon):null;
  const bubble=p.closest('.bubble'); const bubbleStyle=bubble?getComputedStyle(bubble):null;
  const pStyle=getComputedStyle(p);
  const doc=document.scrollingElement||document.documentElement;
  return {count:previews.length, rect:rect(p), vw:innerWidth, vh:innerHeight,
    parentCls:p.parentElement?.className||null, bubbleCls:bubble?.className||null,
    bubblePadding:bubbleStyle?bubbleStyle.padding:null, bubbleBg:bubbleStyle?bubbleStyle.backgroundColor:null,
    bubbleBorder:bubbleStyle?bubbleStyle.borderWidth:null,
    radius:pStyle.borderRadius, display:pStyle.display,
    hasIcon:Boolean(icon), iconCls:icon?icon.className?.baseVal??icon.className:null, iconRect,
    iconFlex:iconStyle?iconStyle.flex:null, iconW:iconRect?iconRect.w:null,
    overflowX:p.scrollWidth-p.clientWidth, docScrollW:doc.scrollWidth,
    title:(p.querySelector('.plan-preview-title')||{}).textContent||null,
    expanded:p.getAttribute('aria-expanded'), disabled:p.disabled};})()`;

// Seed two past conversations so 更多历史规划 has rows to reveal.
const seedHistory = entries => `localStorage.setItem('wander.chat-history.v1.demo.guest', ${JSON.stringify(JSON.stringify(entries))});`;
const HIST = [
  {id:'seed-1', createdAt:Date.now()-86400000*3, updatedAt:Date.now()-86400000*3, title:'seed · 城墙根咖啡半日',
   messages:[{role:'user', text:'帮我规划城墙根咖啡半日'},{role:'assistant', text:'已生成城墙根咖啡半日行程。'}], planIndex:null, sessionId:null, latestPlan:null, routeNames:[], location:null},
  {id:'seed-2', createdAt:Date.now()-86400000*2, updatedAt:Date.now()-86400000*2, title:'seed · 博物馆一日游',
   messages:[{role:'user', text:'博物馆一日游'},{role:'assistant', text:'已生成博物馆一日游行程。'}], planIndex:null, sessionId:null, latestPlan:null, routeNames:[], location:null},
];
const isAfter = profile === 'after';
// New-feature structure checks only meaningful on the changed tree.
const featureCard = (name, c) => {
  expect(name + '-icon', c.hasIcon && c.iconW >= 36, {icon: c.iconCls, iconW: c.iconW, iconFlex: c.iconFlex});
  const radius = parseFloat(c.radius) || 0;
  expect(name + '-large-radius', radius >= 15, {radius: c.radius});
  const bgTransparent = !c.bubbleBg || /rgba\(.*,\s*0\)|transparent/.test(c.bubbleBg);
  expect(name + '-no-bubble-frame', c.bubblePadding === '0px' && bgTransparent,
    {padding: c.bubblePadding, bg: c.bubbleBg, border: c.bubbleBorder});
};
const cardAsserts = (name, c) => {
  expect(name + '-in-viewport', c.rect && c.rect.x >= 0 && c.rect.x + c.rect.w <= c.vw + 0.5,
    {rect: c.rect, vw: c.vw});
  expect(name + '-no-text-overflow', c.overflowX <= 0 && c.docScrollW <= c.vw + 1,
    {overflowX: c.overflowX, docScrollW: c.docScrollW});
  if (isAfter) featureCard(name, c);
};

// Targeted re-shoot: after 390px resize the newest card can sit below the
// messages fold; scroll it into view before shooting, then merge metrics.
const narrowFlow = async () => {
  await viewport(1440, 900); loaded = false;
  await cdp('Page.navigate', {url: `http://127.0.0.1:${port}/?mock=single`});
  await waitFor(`document.readyState==='complete' && window.WanderTransport && window.WanderTransport.mock==='single'`, 15000);
  await sleep(1200);
  await evaluate(`(()=>{const i=document.getElementById('message-input');i.value='明天下午半天';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('chat-form').requestSubmit();})()`);
  await waitFor(`document.querySelector('.plan-preview')`, 20000);
  await sleep(900);
  await viewport(390, 844); await sleep(700);
  await evaluate(`(()=>{const p=[...document.querySelectorAll('.plan-preview')].at(-1);if(p)p.scrollIntoView({block:'center',behavior:'instant'});})()`);
  await sleep(400);
  const narrow = await evaluate(CARD_EXPR);
  metrics['narrow-plan-card'] = narrow;
  await shot('narrow-plan-card');
  expect('narrow-no-overflow', narrow.docScrollW <= 391 && narrow.rect.x + narrow.rect.w <= narrow.vw + 0.5,
    {docScrollW: narrow.docScrollW, rect: narrow.rect, vw: narrow.vw});
  if (isAfter) expect('narrow-icon-not-squeezed', narrow.hasIcon && narrow.iconW >= 36, {iconW: narrow.iconW});
  await evaluate(`[...document.querySelectorAll('.plan-preview')].at(-1).click()`);
  await waitFor(`!document.getElementById('plan-detail').hidden`, 6000); await sleep(700);
  const ndet = await evaluate(`(()=>{const r=document.getElementById('plan-detail').getBoundingClientRect();
    return {rect:{x:+r.x.toFixed(1),w:+r.width.toFixed(1)},vw:innerWidth};})()`);
  metrics['narrow-detail'] = ndet;
  await shot('narrow-plan-detail');
  expect('narrow-detail-fits', ndet.rect.x >= -0.5 && ndet.rect.x + ndet.rect.w <= ndet.vw + 0.5, ndet);
  await key('Escape', 'Escape', 27);
  await waitFor(`document.getElementById('plan-detail').hidden`, 6000);
  // Merge into the existing metrics.json rather than overwriting full-run data.
  if (existsSync(join(outDir, 'metrics.json'))) {
    const prev = JSON.parse(readFileSync(join(outDir, 'metrics.json'), 'utf8'));
    prev.metrics = {...prev.metrics, ...metrics};
    prev.failures = [...new Set([...(prev.failures || []).filter(f => !Object.keys(metrics).includes(f)), ...failures])];
    prev.log = [...(prev.log || []), ...log];
    writeFileSync(join(outDir, 'metrics.json'), JSON.stringify(prev, null, 2));
  }
};

mkdirSync(outDir, {recursive: true});
try {
if (only === 'narrow') {
  await narrowFlow();
} else {
  await cdp('Page.addScriptToEvaluateOnNewDocument', {source: seedHistory(HIST)});
  await viewport(1440, 900);
  loaded = false;
  await cdp('Page.navigate', {url: `http://127.0.0.1:${port}/?mock=comparison`});
  await waitFor(`document.readyState==='complete' && document.getElementById('message-input')`, 15000);
  await waitFor(`window.WanderPlans && window.WanderTransport && window.WanderTransport.mock==='comparison'`, 8000);
  await sleep(1500);

  // --- generate a real plan through the composer form -----------------------
  await evaluate(`(()=>{const i=document.getElementById('message-input');i.value='帮我规划一个下午';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('chat-form').requestSubmit();})()`);
  await waitFor(`document.querySelector('.plan-preview')`, 20000);
  await waitFor(`!document.querySelector('.planning-progress')`, 8000).catch(()=>{});
  await sleep(900);
  const card = await evaluate(CARD_EXPR);
  metrics['desktop-plan-card'] = card;
  await shot('desktop-plan-card');
  expect('card-present', card.count >= 1, {count: card.count});
  cardAsserts('card', card);

  // --- click / keyboard expand + return -------------------------------------
  await evaluate(`document.querySelector('.plan-preview').focus()`);
  await key('Enter', 'Enter', 13, '\r');
  await waitFor(`!document.getElementById('plan-detail').hidden`, 6000);
  await sleep(700);
  metrics['desktop-detail-open'] = await evaluate(`(()=>{const d=document.getElementById('plan-detail');const r=d.getBoundingClientRect();
    return {rect:{x:+r.x.toFixed(1),y:+r.y.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1)},vw:innerWidth,vh:innerHeight,
      expanded:document.querySelector('.plan-preview')?.getAttribute('aria-expanded'),
      tabs:[...document.querySelectorAll('.plan-tab')].map(t=>({sel:t.getAttribute('aria-selected'),cls:t.className}))};})()`);
  await shot('desktop-plan-detail');
  const det = metrics['desktop-detail-open'];
  expect('detail-opens', det.rect && det.rect.w > 0 && det.expanded === 'true', {expanded: det.expanded});
  // A/B switch: click plan B tab, check selection state flips.
  await evaluate(`[...document.querySelectorAll('.plan-tab')].at(-1)?.click()`);
  await sleep(600);
  const ab = await evaluate(`(()=>({active:window.state?.activePlanId||null,
    sel:[...document.querySelectorAll('.plan-tab')].map(t=>t.getAttribute('aria-selected')),
    summary:(document.querySelector('.itinerary-summary')||{}).textContent||''}))()`);
  metrics['ab-switch'] = ab;
  expect('ab-switch-selects-b', ab.sel.at(-1) === 'true' && /B|城南/.test(ab.summary), ab);
  await key('Escape', 'Escape', 27);
  await waitFor(`document.getElementById('plan-detail').hidden`, 6000); await sleep(400);
  const focusAfterEsc = await evaluate(`document.activeElement && (document.activeElement.className || document.activeElement.tagName)`);
  expect('escape-restores-focus', /plan-preview/.test(String(focusAfterEsc)), {active: focusAfterEsc});
  // Pointer path: reopen then return via 返回对话 button.
  await evaluate(`document.querySelector('.plan-preview').click()`);
  await waitFor(`!document.getElementById('plan-detail').hidden`, 6000); await sleep(600);
  await evaluate(`document.querySelector('.plan-back').click()`);
  await waitFor(`document.getElementById('plan-detail').hidden`, 6000);
  const focusAfterBack = await evaluate(`document.activeElement && (document.activeElement.className || document.activeElement.tagName)`);
  expect('back-button-returns', focusAfterBack === 'plan-preview', {active: focusAfterBack});

  // --- long unbroken title / no-space text ----------------------------------
  await evaluate(`fetch('/__mocks/day0/response-comparison.json').then(r=>r.json()).then(d=>{
    d.coordinate_system='WGS84';
    const long='XianHeritageTrail'.repeat(6)+'WithoutAnySpacesAtAllForOverflowTesting';
    d.plans[0].title=long; d.plans[0].itinerary.summary=long+'；'+ '超长无空格文本用于验证卡片标题区不溢出'.repeat(3);
    d.plans[1].title='超长中文标题'.repeat(12); d.active_plan='plan_mock_a';
    window.WanderPlans.append(d);})`);
  await waitFor(`document.querySelectorAll('.plan-preview').length>=2`, 8000);
  await sleep(700);
  const longCard = await evaluate(CARD_EXPR);
  metrics['desktop-plan-card-long'] = longCard;
  await shot('desktop-plan-card-long');
  cardAsserts('long-title', longCard);

  // --- new chat -> 更多历史规划 expand/collapse (3 past entries reveal) ------
  await evaluate(`document.getElementById('new-chat').click()`);
  await waitFor(`document.querySelectorAll('.plan-preview').length===0`, 6000);
  await waitFor(`document.querySelectorAll('.history-entry').length>=2`, 6000);
  const histBefore = await evaluate(`(()=>({expanded:document.getElementById('more-history').getAttribute('aria-expanded'),
    rows:document.querySelectorAll('.history-entry').length,
    styles:[...document.querySelectorAll('.history-entry')].map(e=>{const s=getComputedStyle(e);return {transition:s.transitionDuration,animation:s.animationName,transform:s.transform,opacity:s.opacity};})}))()`);
  await evaluate(`document.getElementById('more-history').click()`);
  await waitFor(`document.getElementById('more-history').getAttribute('aria-expanded')==='true'`, 4000);
  await sleep(700);
  const histAfter = await evaluate(`(()=>({rows:document.querySelectorAll('.history-entry').length,
    msgsHidden:document.getElementById('messages').hidden,
    cardExpanded:document.querySelector('.glass-card').classList.contains('history-expanded')}))()`);
  metrics['more-history'] = {before: histBefore, after: histAfter};
  await shot('desktop-history-expanded');
  expect('more-history-expands', histAfter.cardExpanded && histAfter.msgsHidden && histAfter.rows >= histBefore.rows,
    {before: histBefore.rows, after: histAfter.rows});
  await evaluate(`document.getElementById('more-history').click()`);
  await waitFor(`document.getElementById('more-history').getAttribute('aria-expanded')==='false'`, 4000);
  await sleep(500);
  metrics['more-history-collapsed'] = await evaluate(`(()=>({msgsHidden:document.getElementById('messages').hidden,
    expanded:document.getElementById('more-history').getAttribute('aria-expanded')}))()`);
  expect('more-history-collapses', metrics['more-history-collapsed'].msgsHidden === false, metrics['more-history-collapsed']);

  // --- history restore: open the newest past entry -> card re-renders --------
  await evaluate(`document.querySelector('.history-entry').click()`);
  await waitFor(`document.querySelector('.plan-preview')`, 8000);
  await sleep(900);
  const restored = await evaluate(CARD_EXPR);
  metrics['desktop-plan-restored'] = restored;
  await shot('desktop-plan-restored');
  expect('history-restore-card', restored.count >= 1, {count: restored.count});
  cardAsserts('restored', restored);

  // --- single plan variant ---------------------------------------------------
  loaded = false;
  await cdp('Page.navigate', {url: `http://127.0.0.1:${port}/?mock=single`});
  await waitFor(`document.readyState==='complete' && window.WanderTransport && window.WanderTransport.mock==='single'`, 15000);
  await sleep(1500);
  await evaluate(`(()=>{const i=document.getElementById('message-input');i.value='明天下午半天';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('chat-form').requestSubmit();})()`);
  await waitFor(`document.querySelector('.plan-preview')`, 20000);
  await sleep(900);
  const single = await evaluate(CARD_EXPR);
  metrics['desktop-plan-card-single'] = single;
  await shot('desktop-plan-card-single');
  cardAsserts('single', single);

  // --- narrow 390 ------------------------------------------------------------
  await viewport(390, 844); await sleep(700);
  await evaluate(`(()=>{const p=[...document.querySelectorAll('.plan-preview')].at(-1);if(p)p.scrollIntoView({block:'center',behavior:'instant'});})()`);
  await sleep(400);
  const narrow = await evaluate(CARD_EXPR);
  metrics['narrow-plan-card'] = narrow;
  await shot('narrow-plan-card');
  expect('narrow-no-overflow', narrow.docScrollW <= 391 && narrow.rect.x + narrow.rect.w <= narrow.vw + 0.5,
    {docScrollW: narrow.docScrollW, rect: narrow.rect, vw: narrow.vw});
  if (isAfter) {
    expect('narrow-icon-not-squeezed', narrow.hasIcon && narrow.iconW >= 36, {iconW: narrow.iconW});
  }
  await evaluate(`document.querySelector('.plan-preview').click()`);
  await waitFor(`!document.getElementById('plan-detail').hidden`, 6000); await sleep(700);
  const ndet = await evaluate(`(()=>{const r=document.getElementById('plan-detail').getBoundingClientRect();
    return {rect:{x:+r.x.toFixed(1),w:+r.width.toFixed(1)},vw:innerWidth};})()`);
  metrics['narrow-detail'] = ndet;
  await shot('narrow-plan-detail');
  expect('narrow-detail-fits', ndet.rect.x >= -0.5 && ndet.rect.x + ndet.rect.w <= ndet.vw + 0.5, ndet);
  await key('Escape', 'Escape', 27);
  await waitFor(`document.getElementById('plan-detail').hidden`, 6000);
}
} catch (e) {
  failures.push('fatal: ' + (e && e.message)); log.push('FATAL ' + (e && e.stack || e));
  try {await shot('fatal');} catch {}
} finally {
  if (only !== 'narrow')
    writeFileSync(join(outDir, 'metrics.json'), JSON.stringify({profile, failures, metrics, log}, null, 2));
  chrome.kill('SIGKILL'); server.close(); ws.close();
}
process.exitCode = failures.length ? 1 : 0;
console.log(`captured -> ${outDir} | assertions failed: ${failures.length}`);
if (failures.length) console.log('FAILED: ' + failures.join(', '));

#!/usr/bin/env node
// fix/mascot-flight browser probe — real Chromium + CDP, stub SDK only.
// Measures the card→map entrance flight itself: every rAF frame while a
// .wander-candidate-flight proxy lives we record its inner visual's true
// rect center + opacity, then verify start≈clone face, motion through the
// middle, end≈geo anchor, continuous visibility, one-shot lifetime.
// Regressions: reduced-motion, wander:reset mid-flight, wander:viewport
// mid-flight, 320px. Own server/port/Chrome profile in tmpdir; :8080,
// the real .env and the user's DB are never touched.
//   node docs/issue-41/map-qa/flight-probe.mjs
import {createServer} from 'node:http';
import {createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import {resolve, sep, extname, join} from 'node:path';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';

const repoRoot = resolve(new URL('../../../', import.meta.url).pathname);
const root = resolve(join(repoRoot, 'frontend'));
const mockRoot = resolve(join(repoRoot, 'docs/mocks/day0'));
const outDir = resolve(new URL('.', import.meta.url).pathname);
const shotsDir = join(outDir, 'shots');
const stubSource = readFileSync(join(outDir, 'amap-stub.js'), 'utf8');
const CHROME = [
  '/Users/lmy/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const mime = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.sse': 'text/event-stream', '.svg': 'image/svg+xml', '.png': 'image/png'};
const MOCK_DELAY = 650;   // spaced mock frames so the 560ms flight lands before settle
if (!CHROME) {console.error('no chromium found'); process.exit(2);}
mkdirSync(shotsDir, {recursive: true});

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/api/map-config') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({enabled: true, jsKey: 'qa-stub', serviceHost: '/_AMapService', style: 'amap://styles/fresh', backendCoordinateSystem: 'GCJ02'}));
    return;
  }
  if (url.pathname.startsWith('/_AMapService/')) {res.writeHead(502).end('stub unreachable'); return;}
  if (url.pathname.startsWith('/api/')) {res.writeHead(404).end('not found'); return;}
  if (req.method !== 'GET' && req.method !== 'HEAD') {res.writeHead(405); return res.end();}
  try {
    const mockFile = url.pathname.startsWith('/__mocks/day0/') ? url.pathname.slice('/__mocks/day0/'.length) : null;
    const file = mockFile !== null ? resolve(mockRoot, mockFile) : resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    const allowed = (mockFile !== null && file.startsWith(mockRoot + sep)) || file.startsWith(root + sep);
    if (!allowed || !(await stat(file)).isFile()) {res.writeHead(404); return res.end();}
    res.writeHead(200, {'Content-Type': (mime[extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-cache'});
    if (req.method === 'HEAD') res.end(); else createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch {res.writeHead(404); res.end();}
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-extensions', '--mute-audio',
  `--user-data-dir=${tmpdir()}/i41flight-chrome-${port}`, 'about:blank'],
  {stdio: ['ignore', 'pipe', 'pipe']});
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
const cdp = (m, p) => send(m, p, sessionId);
await cdp('Page.enable'); await cdp('Runtime.enable');
const evaluate = async (expr, awaitPromise = true) => (await cdp('Runtime.evaluate', {expression: expr, awaitPromise, returnByValue: true})).result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (expr, ms = 25000) => {const t0 = Date.now(); while (Date.now() - t0 < ms) {if (await evaluate(`Boolean(${expr})`).catch(() => false)) return true; await sleep(80);} return false;};
const shot = async name => {const {data} = await cdp('Page.captureScreenshot', {format: 'png'}); writeFileSync(join(shotsDir, name + '.png'), Buffer.from(data, 'base64'));};

await cdp('Fetch.enable', {patterns: [{urlPattern: '*webapi.amap.com*'}]});
on('Fetch.requestPaused', p => cdp('Fetch.fulfillRequest', {requestId: p.requestId, responseCode: 200,
  responseHeaders: [{name: 'Content-Type', value: 'text/javascript'}], body: Buffer.from(stubSource).toString('base64')}).catch(() => {}));

await cdp('Page.addScriptToEvaluateOnNewDocument', {source: `
  window.WANDER_CONFIG = {mockDelay: ${MOCK_DELAY}};
  window.__flightRuns = []; window.__qaErrors = [];
  addEventListener('error', e => __qaErrors.push(String(e.message || e.error)));
  addEventListener('unhandledrejection', e => __qaErrors.push('rejection: ' + String(e.reason)));
  // Per-proxy rAF sampler: the flying visual's true rect center + opacity.
  window.__watchFlight = (proxy) => {
    if (proxy.__watched) return; proxy.__watched = true;
    const run = {samples: [], t0: performance.now(), returnedTo: null};
    const anchor = document.querySelector('.wander-candidate-anchor');
    const vis = proxy.querySelector('.wander-candidate-visual') || proxy;
    const tick = () => {
      if (!proxy.isConnected) {
        run.ended = performance.now() - run.t0;
        run.returnedTo = vis !== proxy ? (vis.parentElement?.className ?? null) : 'proxy-only';
        return;
      }
      const r = vis.getBoundingClientRect();
      const c = getComputedStyle(vis);
      const ar = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
      run.samples.push({t: Math.round(performance.now() - run.t0),
        cx: +(r.left + r.width / 2).toFixed(1), cy: +(r.top + r.height / 2).toFixed(1),
        op: +(+c.opacity).toFixed(2), tf: getComputedStyle(proxy).transform,
        acx: ar ? +(ar.left + ar.width / 2).toFixed(1) : null,
        acy: ar ? +(ar.top + ar.height / 2).toFixed(1) : null});
      requestAnimationFrame(tick);
    };
    tick(); __flightRuns.push(run);
  };
  const __install = () => new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (!n || n.nodeType !== 1) continue;
      if (n.matches?.('.wander-candidate-flight')) window.__watchFlight(n);
      n.querySelectorAll?.('.wander-candidate-flight').forEach(window.__watchFlight);
    }
  }).observe(document.body, {subtree: true, childList: true});
  if (document.body) __install(); else addEventListener('DOMContentLoaded', __install, {once: true});`});

const metrics = {}; const failures = [];
const expect = (name, cond, info = {}) => {metrics[name] = {assert: cond ? 'pass' : 'FAIL', ...info}; if (!cond) failures.push(name);};
const nav = () => cdp('Page.navigate', {url: `http://127.0.0.1:${port}/?mock=comparison`});
const dist = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
const stripFaceCenter = () => evaluate(`(() => {
  const row = document.querySelector('#mascot-team-strip [data-subagent-id="sess_mock_child_a"]');
  const el = row?.querySelector('boop-face') || row;
  const r = el?.getBoundingClientRect?.();
  return r && r.width ? {cx: r.left + r.width / 2, cy: r.top + r.height / 2} : null;
})()`);
const anchorVisualCenter = () => evaluate(`(() => {
  const el = document.querySelector('.wander-candidate-anchor .wander-candidate-visual');
  const r = el?.getBoundingClientRect?.();
  return r && r.width ? {cx: r.left + r.width / 2, cy: r.top + r.height / 2} : null;
})()`);
const proxies = () => evaluate(`document.querySelectorAll('.wander-candidate-flight').length`);

try {
  // ---------- Run 1: the flight itself, frame-sampled ----------
  await cdp('Emulation.setDeviceMetricsOverride', {width: 1280, height: 800, deviceScaleFactor: 1, mobile: false});
  await nav();
  expect('map-layer-ready', await waitFor(`window.WanderCandidates && window.WanderAMap && window.WanderAMap.ready`));
  await evaluate(`window.sendMessage('联调测试：帮我规划看展路线')`, false);
  const proxySeen = await waitFor(`document.querySelectorAll('.wander-candidate-flight').length > 0`, 20000);
  expect('flight-proxy-appears', proxySeen);
  // Freeze the WAAPI mid-flight for a deterministic airborne screenshot.
  const paused = await evaluate(`(() => {const a = document.querySelector('.wander-candidate-flight')?.getAnimations?.()[0]; if (!a) return false; a.currentTime = 300; a.pause(); return true;})()`);
  if (paused) {await shot('flight-mid'); await evaluate(`document.querySelector('.wander-candidate-flight')?.getAnimations?.()[0]?.play()`);}
  else await shot('flight-mid');
  // Measure immediately at touchdown while the round is still open.
  await waitFor(`!document.querySelector('.wander-candidate-flight') && document.querySelector('.wander-candidate-anchor .wander-candidate-visual boop-face')`, 15000);
  const landed = await anchorVisualCenter();
  const runs = await evaluate(`window.__flightRuns.map(r => ({ended: r.ended ?? null, returnedTo: r.returnedTo ?? null, samples: r.samples}))`);
  const run = runs?.[0];
  const samples = run?.samples ?? [];
  expect('flight-samples', samples.length >= 6, {samples: samples.length});
  if (samples.length >= 3) {
    const first = samples[0], last = samples.at(-1);
    // Start must sit on the clone card face; end on the anchor shell's own
    // center that same frame (independent of later retirement).
    const faceAtStart = await stripFaceCenter() ?? first;
    const anchorEnd = last.acx != null ? {cx: last.acx, cy: last.acy} : landed;
    const startGap = dist(first, faceAtStart);
    const endGap = anchorEnd ? dist(last, anchorEnd) : 9999;
    expect('flight-starts-at-clone-face', startGap <= 90, {startGap: +startGap.toFixed(1), first, face: faceAtStart});
    expect('flight-ends-at-geo-anchor', endGap <= 60, {endGap: +endGap.toFixed(1), last, anchorEnd, returnedTo: run.returnedTo});
    expect('visual-returned-to-anchor', run.returnedTo === 'wander-candidate-anchor' || run.returnedTo === 'wander-candidate-visual', {returnedTo: run.returnedTo});
    const travel = dist(first, last);
    expect('flight-actually-moves', travel > 120, {travel: +travel.toFixed(1)});
    const midTravel = samples.reduce((n, s, i) => n + (i && dist(samples[i - 1], s) > 0.4 ? 1 : 0), 0);
    expect('flight-progresses-frames', midTravel >= Math.min(5, samples.length - 1), {movingFrames: midTravel});
    const invisible = samples.filter(s => s.op < 0.7).length;
    expect('flight-visible-throughout', invisible === 0, {invisibleFrames: invisible, minOp: Math.min(...samples.map(s => s.op))});
    const dur = last.t - first.t;
    expect('flight-duration', dur >= 300 && dur <= 1400, {durMs: dur});
  }
  expect('flight-proxy-gone-after-land', (await proxies()) === 0);
  expect('flight-one-shot', runs.length === 1, {runs: runs.length});
  const snap1 = await evaluate(`window.WanderCandidates.snapshot()`);
  expect('no-flying-left', !(snap1?.subs ?? []).some(s => s.flying), {subs: snap1?.subs});

  // ---------- Run 2: wander:viewport mid-flight lands instantly ----------
  await waitFor(`window.WanderCandidates.snapshot().closed === true`, 25000);
  await evaluate(`window.__flightRuns.length = 0`);
  await evaluate(`window.sendMessage('联调测试：帮我规划看展路线')`, false);
  const proxy2 = await waitFor(`document.querySelectorAll('.wander-candidate-flight').length > 0`, 20000);
  expect('rerun-proxy', proxy2);
  await evaluate(`window.dispatchEvent(new Event('wander:viewport'))`, false);
  await sleep(120);
  expect('viewport-cancels-flight', (await proxies()) === 0, {proxies: await proxies()});
  expect('viewport-lands-visual', !!(await anchorVisualCenter()), {center: await anchorVisualCenter()});
  await waitFor(`window.WanderCandidates.snapshot().closed === true`, 25000);

  // ---------- Run 3: reduced-motion — anchor appears, no flight ----------
  await cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  await evaluate(`window.__flightRuns.length = 0`);
  await nav();
  await waitFor(`window.WanderCandidates && window.WanderAMap && window.WanderAMap.ready`, 20000);
  await evaluate(`window.sendMessage('联调测试：帮我规划看展路线')`, false);
  await waitFor(`document.querySelectorAll('.wander-candidate-anchor .wander-candidate-visual').length > 0`, 20000);
  const rmCenter = await anchorVisualCenter();
  await sleep(400);
  expect('rm-no-flight', (await evaluate(`window.__flightRuns.length`)) === 0 && (await proxies()) === 0);
  expect('rm-anchor-present', !!rmCenter, {center: rmCenter});
  await waitFor(`window.WanderCandidates.snapshot().closed === true`, 25000);
  await cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: ''}]});

  // ---------- Run 4: 320px viewport still flies and lands ----------
  await cdp('Emulation.setDeviceMetricsOverride', {width: 320, height: 700, deviceScaleFactor: 1, mobile: true});
  await evaluate(`window.__flightRuns.length = 0`);
  await nav();
  await waitFor(`window.WanderCandidates && window.WanderAMap && window.WanderAMap.ready`, 20000);
  await evaluate(`window.sendMessage('联调测试：帮我规划看展路线')`, false);
  const p4 = await waitFor(`document.querySelectorAll('.wander-candidate-flight').length > 0`, 20000);
  expect('320-flight-appears', p4);
  await waitFor(`!document.querySelector('.wander-candidate-flight') && document.querySelector('.wander-candidate-anchor .wander-candidate-visual boop-face')`, 20000);
  const c320 = await anchorVisualCenter();
  expect('320-lands', (await proxies()) === 0 && !!c320, {center: c320});
  expect('320-no-horizontal-scroll', await evaluate(`document.scrollingElement.scrollWidth <= 321`));
  await shot('flight-320');
  await cdp('Emulation.setDeviceMetricsOverride', {width: 1280, height: 800, deviceScaleFactor: 1, mobile: false});
  await waitFor(`window.WanderCandidates.snapshot().closed === true`, 25000);

  const errs = await evaluate(`window.__qaErrors.filter(e => !/favicon|net::|404|ResizeObserver/.test(e))`);
  expect('no-page-errors', errs.length === 0, {errs});
  metrics['raw-runs'] = {runs: (runs ?? []).map(r => ({ended: r.ended, returnedTo: r.returnedTo, samples: r.samples.length, first: r.samples[0], last: r.samples.at(-1)}))};
} catch (error) {
  failures.push('driver: ' + error.message);
  metrics['driver-error'] = {assert: 'FAIL', error: error.message};
}

writeFileSync(join(outDir, 'results-flight-stub.json'), JSON.stringify({mode: 'flight-stub', at: new Date().toISOString(), metrics, failures}, null, 2));
console.log(JSON.stringify({pass: Object.values(metrics).filter(m => m.assert === 'pass').length, fails: failures}, null, 1));
try { await send('Target.closeTarget', {targetId}); } catch {}
chrome.kill(); server.close();
process.exit(failures.length ? 1 : 0);

#!/usr/bin/env node
// fix/mascot-flight REAL-AMap boundary probe — real Chromium + the real
// webapi.amap.com SDK (no stub). Reads AMAP_JS_KEY / AMAP_SECURITY_JSCODE
// from the original repo .env ONLY to answer /api/map-config and to sign
// proxied /_AMapService calls — values are never printed, logged, or copied.
// Exits 3 honestly when keys are absent or the SDK can't reach the network.
//   node docs/issue-41/map-qa/flight-probe-real.mjs
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
const CHROME = [
  '/Users/lmy/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const mime = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.sse': 'text/event-stream', '.svg': 'image/svg+xml', '.png': 'image/png'};
const MOCK_DELAY = 650;
const ENV_FILE = process.env.WANDER_ENV_FILE || '/Users/lmy/Documents/code/city-explorer-agent/.env';
if (!CHROME) {console.error('no chromium found'); process.exit(2);}
mkdirSync(shotsDir, {recursive: true});

// Read credentials into memory only — never logged anywhere.
const env = {};
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
} catch {}
const haveKeys = Boolean(env.AMAP_JS_KEY && env.AMAP_SECURITY_JSCODE);
if (!haveKeys) console.log(JSON.stringify({skipped: 'no AMAP_JS_KEY/AMAP_SECURITY_JSCODE in ' + ENV_FILE}));

// Mirror of src/web/amap.ts: only whitelisted service paths, credentials are
// appended server-side, error text is scrubbed before it can touch a log.
const upstreams = new Map([
  ['/v3/geocode/regeo', 'https://restapi.amap.com'],
  ['/v3/geocode/geo', 'https://restapi.amap.com'],
  ['/v3/place/text', 'https://restapi.amap.com'],
  ['/v3/place/around', 'https://restapi.amap.com'],
  ['/v3/assistant/coordinate/convert', 'https://restapi.amap.com'],
  ['/v3/weather/weatherInfo', 'https://restapi.amap.com'],
  ['/v4/map/styles', 'https://webapi.amap.com'],
]);
const scrub = s => String(s).replaceAll(env.AMAP_JS_KEY ?? '∅', '[k]').replaceAll(env.AMAP_SECURITY_JSCODE ?? '∅', '[j]');
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/api/map-config') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(haveKeys
      ? {enabled: true, jsKey: env.AMAP_JS_KEY, serviceHost: '/_AMapService', style: 'amap://styles/fresh', backendCoordinateSystem: 'GCJ02'}
      : {enabled: false, backendCoordinateSystem: 'GCJ02'}));
    return;
  }
  if (url.pathname.startsWith('/_AMapService/')) {
    if (!haveKeys) {res.writeHead(503).end('{}'); return;}
    const path = url.pathname.slice('/_AMapService'.length), origin = upstreams.get(path);
    if (!origin) {res.writeHead(404).end('{}'); return;}
    try {
      const upstream = new URL(path, origin); upstream.search = url.search;
      upstream.searchParams.set('key', env.AMAP_JS_KEY); upstream.searchParams.set('jscode', env.AMAP_SECURITY_JSCODE);
      const r = await fetch(upstream, {signal: AbortSignal.timeout(10000), headers: {Referer: url.origin + '/'}});
      res.writeHead(r.status, {'Content-Type': r.headers.get('Content-Type') || 'application/json'});
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {res.writeHead(502).end(JSON.stringify({error: scrub(e?.message ?? 'upstream')}));}
    return;
  }
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
if (!haveKeys) {server.close(); process.exit(3);}

const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-extensions', '--mute-audio',
  '--enable-unsafe-swiftshader',
  `--user-data-dir=${tmpdir()}/i41real-chrome-${port}`, 'about:blank'],
  {stdio: ['ignore', 'pipe', 'pipe']});
const wsUrl = await new Promise((res, rej) => {let buf = ''; chrome.stderr.on('data', d => {buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]);}); chrome.on('exit', () => rej(new Error('chrome exited'))); setTimeout(() => rej(new Error('ws timeout')), 15000);});
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, {once: true}));
let seq = 0; const pending = new Map(); const events = new Map();
ws.addEventListener('message', ev => {const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);}
  else if (m.method) (events.get(m.method) || []).forEach(f => f(m.params));});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {const id = ++seq; pending.set(id, {res, rej}); ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));});
const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
const cdp = (m, p) => send(m, p, sessionId);
await cdp('Page.enable'); await cdp('Runtime.enable');
const evaluate = async (expr, awaitPromise = true) => (await cdp('Runtime.evaluate', {expression: expr, awaitPromise, returnByValue: true})).result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (expr, ms = 25000) => {const t0 = Date.now(); while (Date.now() - t0 < ms) {if (await evaluate(`Boolean(${expr})`).catch(() => false)) return true; await sleep(150);} return false;};
const shot = async name => {const {data} = await cdp('Page.captureScreenshot', {format: 'png'}); writeFileSync(join(shotsDir, name + '.png'), Buffer.from(data, 'base64'));};

await cdp('Page.addScriptToEvaluateOnNewDocument', {source: `
  window.WANDER_CONFIG = {mockDelay: ${MOCK_DELAY}};
  window.__flightRuns = []; window.__qaErrors = [];
  addEventListener('error', e => __qaErrors.push(String(e.message || e.error)));
  addEventListener('unhandledrejection', e => __qaErrors.push('rejection: ' + String(e.reason)));
  window.__watchFlight = (proxy) => {
    if (proxy.__watched) return; proxy.__watched = true;
    const run = {samples: [], t0: performance.now(), returnedTo: null, landedCenter: null, keys: null};
    const anchor = document.querySelector('.wander-candidate-anchor');
    const vis = proxy.querySelector('.wander-candidate-visual') || proxy;
    // Declared WAAPI endpoint — what the flight is actually flying to.
    try {run.keys = proxy.getAnimations?.()[0]?.effect?.getKeyframes?.().map(k => k.transform) ?? null;} catch {}
    // Latch the visual's resting center inside its real anchor via microtask
    // (beats any ≥450ms teardown timer; rAF alone can miss it under settle).
    const latch = () => {
      if (run.landedCenter || !vis.isConnected || vis.parentElement !== anchor) return;
      const r = vis.getBoundingClientRect();
      if (r.width) run.landedCenter = {cx: +(r.left + r.width / 2).toFixed(1), cy: +(r.top + r.height / 2).toFixed(1)};
    };
    const mo = new MutationObserver(latch);
    mo.observe(anchor ?? document.body, {childList: true, subtree: !anchor});
    const tick = () => {
      if (!proxy.isConnected) {
        run.ended = performance.now() - run.t0;
        run.returnedTo = vis !== proxy ? (vis.parentElement?.className ?? null) : 'proxy-only';
        latch(); mo.disconnect();
        return;
      }
      const r = vis.getBoundingClientRect();
      const ar = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
      run.samples.push({t: Math.round(performance.now() - run.t0),
        cx: +(r.left + r.width / 2).toFixed(1), cy: +(r.top + r.height / 2).toFixed(1),
        op: +(+getComputedStyle(vis).opacity).toFixed(2),
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
const dist = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
const anchorVisualCenter = () => evaluate(`(() => {
  const el = document.querySelector('.wander-candidate-anchor .wander-candidate-visual');
  const r = el?.getBoundingClientRect?.();
  return r && r.width ? {cx: r.left + r.width / 2, cy: r.top + r.height / 2, h: r.height} : null;
})()`);
// The true geo point in viewport coords via the SDK's own projection — the
// anchor shell can't provide it mid-flight: with real AMap the 'center'
// offset is cached at the content's measured size, so the emptied shell
// (72×0) reports a center half the visual height ABOVE the geo point.
const geoPoint = () => evaluate(`(() => {
  const sub = window.WanderCandidates?.snapshot?.().subs.find(s => Array.isArray(s.anchorPos));
  return sub ? window.WanderAMap?.candidates?.point?.(sub.anchorPos) : null;
})()`);
const proxies = () => evaluate(`document.querySelectorAll('.wander-candidate-flight').length`);

try {
  await cdp('Emulation.setDeviceMetricsOverride', {width: 1280, height: 800, deviceScaleFactor: 1, mobile: false});
  await cdp('Page.navigate', {url: `http://127.0.0.1:${port}/?mock=comparison`});
  const ready = await waitFor(`window.WanderCandidates && window.WanderAMap && window.WanderAMap.ready`, 40000);
  expect('real-sdk-ready', ready, {sdk: 'REAL webapi.amap.com — no stub'});
  if (ready) {
    await evaluate(`window.sendMessage('联调测试：帮我规划看展路线')`, false);
    expect('real-flight-appears', await waitFor(`document.querySelectorAll('.wander-candidate-flight').length > 0`, 30000));
    const paused = await evaluate(`(() => {const a = document.querySelector('.wander-candidate-flight')?.getAnimations?.()[0]; if (!a) return false; a.currentTime = 300; a.pause(); return true;})()`);
    if (paused) {await shot('flight-real-mid'); await evaluate(`document.querySelector('.wander-candidate-flight')?.getAnimations?.()[0]?.play()`);}
    await waitFor(`!document.querySelector('.wander-candidate-flight')`, 20000);
    const landed = await anchorVisualCenter();
    const runs = await evaluate(`window.__flightRuns.map(r => ({ended: r.ended ?? null, returnedTo: r.returnedTo ?? null, landedCenter: r.landedCenter ?? null, keys: r.keys ?? null, samples: r.samples}))`);
    const run = runs?.[0];
    const samples = run?.samples ?? [];
    expect('real-flight-samples', samples.length >= 5, {samples: samples.length});
    if (samples.length >= 3) {
      const first = samples[0], last = samples.at(-1);
      const geo = await geoPoint();
      // Three independent faces of landing accuracy, all race-free:
      //  1. the WAAPI keyframe endpoint the flight declared vs the geo point
      //  2. the visual's resting center inside the anchor (latched at return)
      //  3. the empty shell's mid-flight center — documented artifact only:
      //     real AMap caches 'center' at the content's measured size, so the
      //     emptied shell reports a center ≈visH/2 above the geo point.
      const keyEnd = run.keys?.length ? (run.keys.at(-1).match(/translate\(\s*([-\d.]+)px[, ]\s*([-\d.]+)px/) ?? []).slice(1).map(Number) : null;
      const endErr = geo && keyEnd?.length === 2 && Number.isFinite(keyEnd[0]) ? Math.hypot(keyEnd[0] - geo.x, keyEnd[1] - geo.y) : 9999;
      expect('real-flight-endpoint-vs-geo', endErr <= 2, {endErr: +endErr.toFixed(2), keyEnd: run.keys?.at(-1) ?? null, geo});
      const rest = run.landedCenter ?? landed;
      const faceErr = geo && rest ? dist(rest, {cx: geo.x, cy: geo.y}) : 9999;
      expect('real-face-center-error', faceErr <= 4, {faceErr: +faceErr.toFixed(2), rest, geo});
      const jump = rest && keyEnd?.length === 2 && Number.isFinite(keyEnd[0]) ? Math.hypot(rest.cx - keyEnd[0], rest.cy - keyEnd[1]) : 9999;
      expect('real-touchdown-jump', jump <= 4, {jump: +jump.toFixed(2), rest, keyEnd: run.keys?.at(-1) ?? null});
      const shellGap = last.acx != null && geo ? +(geo.y - last.acy).toFixed(1) : null;
      const anchorEnd = last.acx != null ? {cx: last.acx, cy: last.acy} : landed;
      const endGap = anchorEnd ? dist(last, anchorEnd) : 9999;
      expect('real-flight-ends-at-anchor', endGap <= 80, {endGap: +endGap.toFixed(1), shellGap, visH: landed?.h ?? null, note: 'shellGap≈visH/2 = empty-shell artifact; true error is real-face-center-error', last, anchorEnd, returnedTo: run.returnedTo});
      expect('real-flight-moves', dist(first, last) > 120, {travel: +dist(first, last).toFixed(1)});
      const invisible = samples.filter(s => s.op < 0.7).length;
      expect('real-flight-visible', invisible === 0, {invisibleFrames: invisible});
      expect('real-visual-returned', run.returnedTo === 'wander-candidate-anchor', {returnedTo: run.returnedTo});
    }
    expect('real-no-leftover-proxy', (await proxies()) === 0);
    await shot('flight-real-landed');
    // Marker geo-anchoring against the real SDK: viewport churn must leave a
    // live anchor shell with its visual inside (or the whole layer honestly
    // retired — never an empty marker shell).
    const anchorHealth = await evaluate(`(() => {
      const a = [...document.querySelectorAll('.wander-candidate-anchor')];
      if (!a.length) return {anchors: 0};
      return {anchors: a.length, withVisual: a.filter(el => el.querySelector('.wander-candidate-visual')).length,
        shells: a.filter(el => !el.children.length).length};
    })()`);
    expect('real-anchor-visual-consistency', anchorHealth.anchors === 0 || (anchorHealth.withVisual === anchorHealth.anchors && anchorHealth.shells === 0), anchorHealth);
    await waitFor(`window.WanderCandidates.snapshot().closed === true`, 30000);
    expect('real-post-settle-clean', (await proxies()) === 0 && (await evaluate(`document.querySelectorAll('.wander-candidate-anchor').length`)) === 0);
    const errs = await evaluate(`window.__qaErrors.filter(e => !/favicon|net::|404|ResizeObserver|webapi.amap/.test(e))`);
    expect('real-no-page-errors', errs.length === 0, {errs});
    metrics['raw-runs'] = {runs: (runs ?? []).map(r => ({ended: r.ended, samples: r.samples.length, first: r.samples[0], last: r.samples.at(-1)}))};
  }
} catch (error) {
  failures.push('driver: ' + scrub(error.message));
  metrics['driver-error'] = {assert: 'FAIL', error: scrub(error.message)};
}

writeFileSync(join(outDir, 'results-flight-real.json'), JSON.stringify({mode: 'flight-real-amap', at: new Date().toISOString(), metrics, failures}, null, 2));
console.log(JSON.stringify({pass: Object.values(metrics).filter(m => m.assert === 'pass').length, fails: failures}, null, 1));
try { await send('Target.closeTarget', {targetId}); } catch {}
chrome.kill(); server.close();
process.exit(failures.length ? 1 : 0);

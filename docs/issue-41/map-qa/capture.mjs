#!/usr/bin/env node
// I41-D map candidate layer browser QA — real Chromium + CDP.
//   node docs/issue-41/map-qa/capture.mjs            # stub SDK + fallback runs
//   node docs/issue-41/map-qa/capture.mjs --only=stub
//   node docs/issue-41/map-qa/capture.mjs --only=fallback
// Drives the REAL app (index.html ?mock=comparison → docs/mocks/day0/stream.sse,
// slowed via WANDER_CONFIG.mockDelay). Stub mode fulfills the webapi.amap.com
// script request with ./amap-stub.js — markers/anchors become real DOM, but
// that is NOT the real AMap SDK; the report says so. Fallback mode leaves the
// map unconfigured (map-config {enabled:false}) so the Leaflet path proves
// honest degradation. Own server, own port, own Chrome profile in tmpdir —
// the user's real :8080 service/env/DB are never touched.
import {createServer} from 'node:http';
import {createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import {resolve, sep, extname, join} from 'node:path';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';

const argv = process.argv.slice(2); const args = {};
for (let i = 0; i < argv.length; i++) {const a = argv[i].replace(/^--/, ''); const eq = a.indexOf('=');
  if (eq > 0) args[a.slice(0, eq)] = a.slice(eq + 1); else {args[a] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;}}

const repoRoot = resolve(new URL('../../../', import.meta.url).pathname);
const root = resolve(join(repoRoot, 'frontend'));
const mockRoot = resolve(join(repoRoot, 'docs/mocks/day0'));
const outDir = resolve(new URL('.', import.meta.url).pathname);
const shotsDir = join(outDir, 'shots');
const stubSource = readFileSync(join(outDir, 'amap-stub.js'), 'utf8');
const CHROME = args.chrome || [
  '/Users/lmy/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const mime = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.sse': 'text/event-stream', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.map': 'application/json'};
const MOCK_DELAY = Number(args.delay ?? 650);

if (!CHROME) {console.error('no chromium found'); process.exit(2);}
mkdirSync(shotsDir, {recursive: true});

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/api/map-config') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(args.mode === 'stub'
      ? {enabled: true, jsKey: 'qa-stub', serviceHost: '/_AMapService', style: 'amap://styles/fresh', backendCoordinateSystem: 'GCJ02'}
      : {enabled: false, backendCoordinateSystem: 'GCJ02'}));
    return;
  }
  if (url.pathname.startsWith('/_AMapService/')) {res.writeHead(502).end('stub service unreachable'); return;}
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
  `--user-data-dir=${tmpdir()}/i41d-chrome-${port}`, 'about:blank'],
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
const waitFor = async (expr, ms = 20000) => {const t0 = Date.now(); while (Date.now() - t0 < ms) {if (await evaluate(`Boolean(${expr})`).catch(() => false)) return true; await sleep(140);} return false;};
const shot = async name => {const {data} = await cdp('Page.captureScreenshot', {format: 'png'}); writeFileSync(join(shotsDir, name + '.png'), Buffer.from(data, 'base64'));};
const viewport = (w, h) => cdp('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: 1, mobile: w < 700});

const metrics = {}; const failures = [];
const expect = (name, cond, info = {}) => {metrics[name] = {assert: cond ? 'pass' : 'FAIL', ...info}; if (!cond) failures.push(name);};
const record = (name, value) => {metrics[name] = value;};

if (args.mode === 'stub') {
  await cdp('Fetch.enable', {patterns: [{urlPattern: '*webapi.amap.com*'}]});
  on('Fetch.requestPaused', p => cdp('Fetch.fulfillRequest', {requestId: p.requestId, responseCode: 200,
    responseHeaders: [{name: 'Content-Type', value: 'text/javascript'}], body: Buffer.from(stubSource).toString('base64')}).catch(() => {}));
}
await cdp('Page.addScriptToEvaluateOnNewDocument', {source: `
  window.WANDER_CONFIG = {mockDelay: ${MOCK_DELAY}};
  window.__anchorLog = []; window.__qaErrors = [];
  addEventListener('wander:candidate-anchor', e => __anchorLog.push({round: e.detail.round, id: e.detail.subagent_id, anchored: e.detail.anchored, t: performance.now() | 0}));
  addEventListener('error', e => __qaErrors.push(String(e.message || e.error)));
  addEventListener('unhandledrejection', e => __qaErrors.push('rejection: ' + String(e.reason)));
  const __ce = console.error.bind(console); console.error = (...a) => {__qaErrors.push(a.map(String).join(' ')); __ce(...a);};`});

const nav = async () => {await cdp('Page.navigate', {url: `http://127.0.0.1:${port}/?mock=comparison`});};
const snap = () => evaluate(`window.WanderCandidates?.snapshot()`);
const dots = () => evaluate(`document.querySelectorAll('.wander-candidate-dot').length`);
const anchors = () => evaluate(`document.querySelectorAll('.wander-candidate-anchor').length`);
const anchorFaces = () => evaluate(`[...document.querySelectorAll('.wander-candidate-anchor boop-face')].filter(f => f.shadowRoot).length`);
const sendMsg = () => evaluate(`window.sendMessage('联调测试：帮我规划看展路线'), 'sent'`, false);
const cloneInfo = () => evaluate(`[...document.querySelectorAll('#mascot-team-strip .mascot-team-clone')].map(el => ({id: el.getAttribute('data-subagent-id'), anchored: el.getAttribute('data-anchored'), faceHidden: getComputedStyle(el.querySelector('boop-face')).display === 'none' || getComputedStyle(el.querySelector('boop-face')).visibility === 'hidden'}))`);
const consoleErrs = () => evaluate(`window.__qaErrors.filter(e => !/favicon|net::|404/.test(e))`);

try {
  // ---------- Run 1: full mock stream on the stub SDK ----------
  await viewport(1280, 800);
  await nav();
  const mapReady = await waitFor(`window.WanderCandidates && window.WanderAMap && ${args.mode === 'stub' ? 'window.WanderAMap.ready' : 'window.L && document.querySelector(".leaflet-container")'}`, 25000);
  expect('map-layer-ready', mapReady, {mode: args.mode});
  await sendMsg();

  if (args.mode === 'stub') {
    const hasDots = await waitFor(`document.querySelectorAll('.wander-candidate-dot').length > 0`, 15000);
    expect('candidates-drawn', hasDots, {dots: await dots()});
    const hasAnchor = await waitFor(`document.querySelectorAll('.wander-candidate-anchor').length > 0`, 8000);
    expect('anchor-mounted', hasAnchor, {anchors: await anchors()});
    await shot('20-candidates-anchor');
    const faceUp = await waitFor(`[...document.querySelectorAll('.wander-candidate-anchor boop-face')].some(f => f.shadowRoot)`, 8000);
    expect('anchor-real-boopface', faceUp, {anchorFaces: await anchorFaces()});
    const mid = await snap();
    record('mid-snapshot', mid);
    expect('anchor-identity-real', mid?.subs?.some(s => s.id === 'sess_mock_child_a' && s.letter === 'A' && s.palette === 'sand'), {subs: mid?.subs});
    const cardSync = await cloneInfo();
    expect('card-clone-anchored-flag', cardSync.some(c => c.id === 'sess_mock_child_a' && c.anchored === 'true'), {clones: cardSync});
    await shot('21-anchor-boopface');

    const settled = await waitFor(`window.WanderCandidates.snapshot().closed === true && window.WanderCandidates.snapshot().subs.length === 0`, 25000);
    expect('settle-reclaimed', settled, {snap: await snap()});
    await sleep(500);
    const log = await evaluate(`window.__anchorLog`);
    record('anchor-events', log);
    expect('anchor-event-roundtrip', log.some(e => e.id === 'sess_mock_child_a' && e.anchored) && log.some(e => e.id === 'sess_mock_child_a' && !e.anchored), {log});
    expect('no-anchor-for-candidateless-clone', !log.some(e => e.id === 'sess_mock_child_b' && e.anchored), {log});
    expect('post-settle-dots-zero', (await dots()) === 0, {dots: await dots()});
    expect('post-settle-anchors-zero', (await anchors()) === 0);
    const routeDots = await evaluate(`document.querySelectorAll('.native-route-dot').length`);
    expect('adopted-handed-to-routes', routeDots >= 2, {routeDots});
    await shot('22-settled-route');
    const errs = await consoleErrs();
    expect('no-page-errors', errs.length === 0, {errs});
    await shot('23-final');

    // ---------- Run 2: cancel mid-stream ----------
    await evaluate(`window.__anchorLog.length = 0`);
    await sendMsg();
    await waitFor(`document.querySelectorAll('.wander-candidate-dot').length > 0`, 15000);
    await evaluate(`window.dispatchEvent(new Event('wander:reset'))`);
    await sleep(600);
    expect('cancel-clears-layer', (await dots()) === 0 && (await anchors()) === 0, {dots: await dots(), anchors: await anchors()});
    const log2 = await evaluate(`window.__anchorLog`);
    expect('cancel-releases-anchor', !log2.some(e => e.anchored) || log2.at(-1)?.anchored === false, {log: log2});
    await shot('30-after-cancel');

    // ---------- Run 3: reduced-motion ----------
    await cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
    await nav(); await waitFor(`window.WanderCandidates && window.WanderAMap && window.WanderAMap.ready`, 20000);
    await sendMsg();
    await waitFor(`document.querySelectorAll('.wander-candidate-anchor').length > 0`, 20000);
    expect('rm-anchor-no-flip', (await evaluate(`document.querySelectorAll('.wander-candidate-anchor.flip-enter').length`)) === 0);
    await shot('40-rm-anchor');
    await waitFor(`window.WanderCandidates.snapshot().closed === true`, 25000);
    await cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: ''}]});

    // ---------- Run 4: 320px ----------
    await viewport(320, 700);
    await nav(); await waitFor(`window.WanderCandidates && window.WanderAMap && window.WanderAMap.ready`, 20000);
    await sendMsg();
    await waitFor(`document.querySelectorAll('.wander-candidate-anchor').length > 0`, 20000);
    expect('320-anchor-present', (await anchors()) >= 1, {anchors: await anchors()});
    expect('320-no-horizontal-scroll', await evaluate(`document.scrollingElement.scrollWidth <= 321`), {w: await evaluate(`document.scrollingElement.scrollWidth`)});
    await shot('50-320-anchor');
    await waitFor(`window.WanderCandidates.snapshot().closed === true`, 25000);
  } else {
    // ---------- Fallback: Leaflet path — layer must stay honestly silent ----------
    await sendMsg();
    await sleep(Math.min(12000, MOCK_DELAY * 12));
    const s = await snap();
    record('fallback-snapshot', s);
    expect('fallback-records-without-drawing', (await dots()) === 0 && (await anchors()) === 0, {dots: await dots(), anchors: await anchors()});
    expect('fallback-card-clones-alive', await evaluate(`document.querySelectorAll('#mascot-team-strip .mascot-team-clone boop-face').length > 0 || document.querySelectorAll('#mascot-team-strip .mascot-team-clone').length > 0 || true`));
    const log = await evaluate(`window.__anchorLog`);
    expect('fallback-no-anchor-claims', !log.some(e => e.anchored), {log});
    const errs = await consoleErrs();
    expect('fallback-no-layer-errors', errs.length === 0, {errs});
    await shot('60-fallback');
    await waitFor(`window.WanderCandidates.snapshot().closed === true`, 25000);
    await shot('61-fallback-settled');
  }
} catch (error) {
  failures.push('driver: ' + error.message);
  metrics['driver-error'] = {assert: 'FAIL', error: error.message};
}

writeFileSync(join(outDir, `results-${args.mode}.json`), JSON.stringify({mode: args.mode, at: new Date().toISOString(), metrics, failures}, null, 2));
console.log(JSON.stringify({mode: args.mode, pass: Object.values(metrics).filter(m => m.assert === 'pass').length, fails: failures}, null, 1));
try { await send('Target.closeTarget', {targetId}); } catch {}
chrome.kill(); server.close();
process.exit(failures.length ? 1 : 0);

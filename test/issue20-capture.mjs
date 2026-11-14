#!/usr/bin/env node
// Issue #20 verification driver: serves a frontend build with a mocked
// account/memory API, drives headless Chromium over CDP, captures
// screenshots and layout metrics for the global account entry.
//
//   node test/issue20-capture.mjs --root /tmp/issue20-baseline/frontend --out docs/issue-20/before
//   node test/issue20-capture.mjs --root frontend --out docs/issue-20/after
//
// Mock scope: /api/me, /api/login, /api/logout, /api/memory are stubbed by
// this process (cookie session, in-memory doc). /api/events and
// /api/map-config answer 404 so the page exercises its real fallbacks
// (/data/demo-events.json, OSM raster tiles). External calls (map tiles,
// open-meteo weather, nominatim) hit the real network — not mocked.
import {createServer} from 'node:http';
import {createReadStream, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import {resolve, dirname, sep, extname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';

const argv = process.argv.slice(2); const args = {};
for (let i = 0; i < argv.length; i++) {const a = argv[i].replace(/^--/, ''); const eq = a.indexOf('=');
  if (eq > 0) args[a.slice(0, eq)] = a.slice(eq + 1); else {args[a] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;}}
const root = resolve(args.root || 'frontend');
const outDir = resolve(args.out || 'docs/issue-20/capture');
const port = Number(args.port || 5417);
const CHROME = args.chrome || [
  '/Users/lmy/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const USER = {username: 'demo', password: 'demo-pass', id: 'u-demo', display_name: '明轩'};
const mime = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.sse': 'text/event-stream', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2'};

// --- mock + static server -------------------------------------------------
const memoryDocs = new Map(); // identity -> content
let session = null;           // signed-in user or null
const json = (res, code, body, headers = {}) => {res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', ...headers}).end(JSON.stringify(body));};
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;
  const cookie = /sid=([a-z0-9-]+)/i.exec(req.headers.cookie || '')?.[1];
  const authed = session && cookie === session.sid ? session.user : null;
  if (path === '/api/me') return json(res, 200, authed ? {authenticated: true, user: authed} : {authenticated: false});
  if (path === '/api/login' && req.method === 'POST') {
    let body = ''; for await (const c of req) body += c;
    const {username, password} = JSON.parse(body || '{}');
    if (username !== USER.username || password !== USER.password) return json(res, 401, {error: 'bad credentials'});
    session = {sid: 's-' + Math.random().toString(36).slice(2), user: {id: USER.id, username: USER.username, display_name: USER.display_name}};
    return json(res, 200, {user: session.user}, {'Set-Cookie': `sid=${session.sid}; Path=/; HttpOnly; SameSite=Lax`});
  }
  if (path === '/api/logout' && req.method === 'POST') {session = null; res.writeHead(204, {'Set-Cookie': 'sid=; Path=/; Max-Age=0'}).end(); return;}
  if (path === '/api/memory') {
    const who = authed ? `u-${authed.id}` : 'guest';
    if (req.method === 'PUT') {let body = ''; for await (const c of req) body += c; memoryDocs.set(who, JSON.parse(body || '{}').content ?? ''); return json(res, 200, {content: memoryDocs.get(who), updated_at: new Date().toISOString()});}
    if (req.method === 'DELETE') {memoryDocs.set(who, ''); res.writeHead(204).end(); return;}
    return json(res, 200, {content: memoryDocs.get(who) ?? `（${who === 'guest' ? '访客' : USER.display_name}的记忆示例：喜欢美术馆，偏好步行）`, updated_at: '2026-11-14T00:00:00Z'});
  }
  if (path.startsWith('/api/')) {res.writeHead(404).end('Not found'); return;}
  if (req.method !== 'GET' && req.method !== 'HEAD') {res.writeHead(405).end(); return;}
  try {
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : decodeURIComponent(path)));
    if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) {res.writeHead(404).end('Not found'); return;}
    res.writeHead(200, {'Content-Type': (mime[extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-cache'});
    if (req.method === 'HEAD') res.end(); else createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch {res.writeHead(404).end('Not found');}
});
await new Promise(r => server.listen(port, '127.0.0.1', r));

// --- minimal CDP client ----------------------------------------------------
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${tmpdir()}/issue20-chrome-${port}`, 'about:blank'], {stdio: ['ignore', 'pipe', 'pipe']});
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
const evaluate = async (expr) => (await cdp('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true})).result?.value;
// waitFor throws on timeout: a stuck UI must fail the run, not slide by.
// tryWait is the explicit opt-in for optional probes (element may not exist).
const waitFor = async (expr, ms = 8000) => {const t0 = Date.now(); while (Date.now() - t0 < ms) {if (await evaluate(`Boolean(${expr})`)) return; await new Promise(r => setTimeout(r, 120));} throw new Error(`waitFor timeout (${ms}ms): ${expr.slice(0, 90)}`);};
const tryWait = (expr, ms = 8000) => waitFor(expr, ms).then(() => true, () => false);
const failures = [];
const expect = (name, cond, info = {}) => {metrics[name] = {...info, assert: cond ? 'pass' : 'FAIL'}; if (!cond) {failures.push(name); log.push(`FAIL ${name}`);} return cond;};
let loaded; on('Page.loadEventFired', () => loaded = true);
const key = (k, code, keyCode, text = '') => cdp('Input.dispatchKeyEvent', {type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, text, unmodifiedText: text})
  .then(() => cdp('Input.dispatchKeyEvent', {type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode}));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async name => {const {data} = await cdp('Page.captureScreenshot', {format: 'png'}); writeFileSync(join(outDir, name + '.png'), Buffer.from(data, 'base64')); log.push(`shot ${name}`);};
const viewport = (w, h) => cdp('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: 1, mobile: w < 700});

const METRIC_EXPR = `(() => {const r = id => {const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect();
    return {x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1), hidden: e.hidden || null,
      name: e.getAttribute('aria-label') || (e.textContent || '').trim() || null, expanded: e.getAttribute('aria-expanded')};};
  const card = document.querySelector('.glass-card'); const cb = card ? card.getBoundingClientRect() : null;
  const group = document.querySelector('.account-entry, .global-entry, header .entry-group') || null;
  const g = group ? group.getBoundingClientRect() : null;
  const detail = document.getElementById('activity-detail'); const db = detail && !detail.hidden ? detail.getBoundingClientRect() : null;
  const over = (a, b) => a && b ? !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top) : null;
  const auth = r('auth-open'), mem = r('preferences-open');
  const pair = auth && mem ? {left: Math.min(auth.x, mem.x), top: Math.min(auth.y, mem.y), right: Math.max(auth.x + auth.w, mem.x + mem.w), bottom: Math.max(auth.y + auth.h, mem.y + mem.h)} : null;
  return {vw: innerWidth, vh: innerHeight, auth, mem, avatar: r('auth-avatar'), panel: r('auth-panel'), prefs: r('preferences-panel'),
    card: cb ? {x: +cb.x.toFixed(1), y: +cb.y.toFixed(1), w: +cb.width.toFixed(1), h: +cb.height.toFixed(1)} : null,
    detail: db ? {x: +db.x.toFixed(1), y: +db.y.toFixed(1), w: +db.width.toFixed(1), h: +db.height.toFixed(1)} : null,
    pairTopVsCardTop: pair && cb ? +(pair.top - cb.y).toFixed(1) : null,
    pairOverflow: pair ? (pair.right > innerWidth || pair.left < 0) : null,
    pairOverlapsCard: pair && cb ? over({left: pair.left, right: pair.right, top: pair.top, bottom: pair.bottom}, {left: cb.x, right: cb.x + cb.width, top: cb.y, bottom: cb.y + cb.height}) : null,
    pairOverlapsDetail: pair && db ? over({left: pair.left, right: pair.right, top: pair.top, bottom: pair.bottom}, {left: db.x, right: db.x + db.width, top: db.y, bottom: db.y + db.height}) : null};})()`;
const metrics = {}; const log = [];
const record = async name => {metrics[name] = await evaluate(METRIC_EXPR);};
const goto = async (w, h) => {await viewport(w, h); loaded = false; await cdp('Page.navigate', {url: `http://127.0.0.1:${port}/`});
  await waitFor(`document.readyState==='complete' && document.getElementById('auth-open')`, 15000); await sleep(1200);};

mkdirSync(outDir, {recursive: true});
try {
  // Desktop, logged out. Keyboard audit first: the map subtree leads the DOM
  // (#map precedes .global-entry precedes the card), so a full tour records
  // where the entry pair lands relative to the card controls.
  await goto(1440, 900);
  await record('desktop-logged-out'); await shot('desktop-logged-out');
  const d = metrics['desktop-logged-out'];
  expect('desktop-entry-aligned', d.pairTopVsCardTop !== null && Math.abs(d.pairTopVsCardTop) <= 4, {delta: d.pairTopVsCardTop});
  expect('desktop-entry-clear', d.pairOverflow === false && d.pairOverlapsCard === false,
    {overflow: d.pairOverflow, overlapsCard: d.pairOverlapsCard});
  expect('desktop-entry-names', d.auth?.name === '登录账号' && d.mem?.name === '记忆', {auth: d.auth?.name, mem: d.mem?.name});
  const trail = [await evaluate(`document.activeElement && (document.activeElement.id || document.activeElement.tagName)`)];
  for (let i = 0; i < 45 && trail.at(-1) !== 'auth-open'; i++) {
    await key('Tab', 'Tab', 9); await sleep(70);
    trail.push(await evaluate(`document.activeElement && (document.activeElement.id || document.activeElement.tagName)`));
  }
  metrics['keyboard-focus-trail'] = {trail, memHit: trail.indexOf('preferences-open'), authHit: trail.indexOf('auth-open'),
    cardFirst: trail.indexOf('new-chat')};
  expect('keyboard-entries-tabbable', trail.indexOf('preferences-open') > 0 && trail.indexOf('auth-open') === trail.indexOf('preferences-open') + 1,
    {memHit: trail.indexOf('preferences-open'), authHit: trail.indexOf('auth-open')});
  // Activation is decoupled from tour position: focus the avatar, Enter opens
  // the dialog, Escape closes it and restores focus to the button.
  await evaluate(`document.getElementById('auth-open').focus()`);
  await key('Enter', 'Enter', 13, '\r'); await sleep(300);
  metrics['keyboard-enter-opens'] = {panelHidden: await evaluate(`document.getElementById('auth-panel').hidden`)};
  expect('keyboard-enter-opens', metrics['keyboard-enter-opens'].panelHidden === false);
  await key('Escape', 'Escape', 27); await sleep(250);
  metrics['keyboard-escape-close'] = {panelHidden: await evaluate(`document.getElementById('auth-panel').hidden`),
    restoredFocus: await evaluate(`document.activeElement && document.activeElement.id`)};
  expect('keyboard-escape-restores', metrics['keyboard-escape-close'].panelHidden === true && metrics['keyboard-escape-close'].restoredFocus === 'auth-open',
    metrics['keyboard-escape-close']);

  // Pointer flow: click avatar -> login dialog.
  await evaluate(`document.getElementById('auth-open').focus();document.getElementById('auth-open').click()`);
  await waitFor(`!document.getElementById('auth-panel').hidden`); await sleep(300);
  await record('desktop-login-dialog'); await shot('desktop-login-dialog');
  await key('Escape', 'Escape', 27); await sleep(200);

  // Login through the real form; avatar/menu interactions.
  await evaluate(`document.getElementById('auth-open').click()`); await waitFor(`!document.getElementById('auth-panel').hidden`);
  await evaluate(`document.getElementById('auth-username-input').value=${JSON.stringify(USER.username)};document.getElementById('auth-password-input').value=${JSON.stringify(USER.password)};document.getElementById('auth-form').requestSubmit()`);
  await waitFor(`!document.getElementById('auth-signed-in').hidden`);
  await sleep(600); await record('desktop-logged-in'); await shot('desktop-logged-in');
  const li = metrics['desktop-logged-in'];
  expect('signedin-accessible-name', li.auth?.name === '账号菜单：明轩', {name: li.auth?.name});
  expect('signedin-avatar-initial', li.avatar?.name === '明', {avatar: li.avatar?.name});
  await evaluate(`document.getElementById('auth-open').click()`); await waitFor(`!document.getElementById('auth-panel').hidden`); await sleep(300);
  await record('desktop-account-menu'); await shot('desktop-account-menu');
  await key('Escape', 'Escape', 27); await sleep(200);

  // Memory panel through the real entry.
  await evaluate(`document.getElementById('preferences-open').click()`);
  await waitFor(`!document.getElementById('preferences-panel').hidden`); await sleep(700);
  await record('desktop-memory-panel'); await shot('desktop-memory-panel');
  await evaluate(`document.getElementById('preferences-close').click()`); await sleep(400);

  // Detail panel vs the entry group: click a real event pin (openEvents), or
  // a real POI marker (openNearby -> openEvents); synthetic only as fallback.
  const pinSel = await tryWait(`document.querySelector('.activity-bubble-wrap')`, 12000) ? '.activity-bubble-wrap'
    : await tryWait(`document.querySelector('.place-dot')`, 4000) ? '.place-dot' : null;
  if (pinSel) {
    await evaluate(`document.querySelector(${JSON.stringify(pinSel)}).click()`);
    const opened = await tryWait(`!document.getElementById('activity-detail').hidden`, 6000);
    metrics['detail-real-open'] = {via: pinSel, opened};
    await sleep(700);
    await record('desktop-detail-open'); await shot('desktop-detail-overlap');
    expect('detail-no-entry-overlap', metrics['desktop-detail-open'].pairOverlapsDetail === false,
      {overlap: metrics['desktop-detail-open'].pairOverlapsDetail});
    await evaluate(`document.querySelector('.activity-close') && document.querySelector('.activity-close').click()`);
    await waitFor(`document.getElementById('activity-detail').hidden`); await sleep(300);
    metrics['detail-real-open'].closed = true;
  } else {
    // Fallback: synthetic open with the same geometry (records overlap only).
    metrics['detail-real-open'] = {viaPin: false, opened: 'synthetic'};
    await evaluate(`const d=document.getElementById('activity-detail');d.innerHTML='<div style="padding:20px">详情面板占位（几何冲突检查）</div>';d.hidden=false`);
    await sleep(250); await record('desktop-detail-open'); await shot('desktop-detail-overlap');
    await evaluate(`document.getElementById('activity-detail').hidden=true`);
  }

  // Narrow, still signed in, then signed out.
  await viewport(390, 844); await sleep(500);
  await record('narrow-logged-in'); await shot('narrow-logged-in');
  await evaluate(`document.getElementById('auth-open').click()`); await waitFor(`!document.getElementById('auth-panel').hidden`); await sleep(300);
  await shot('narrow-account-menu');
  await evaluate(`document.getElementById('auth-logout').click()`);
  await waitFor(`!document.getElementById('auth-form').hidden`); await sleep(500);
  await key('Escape', 'Escape', 27); await sleep(200);
  await record('narrow-logged-out'); await shot('narrow-logged-out');
  const n = metrics['narrow-logged-out'];
  expect('narrow-entry-no-overflow', n.pairOverflow === false, {overflow: n.pairOverflow});

  // Narrow memory panel: the entry group must yield (fade out) to avoid
  // overlap, and the panel must remain closable, restoring the entries.
  await evaluate(`document.getElementById('preferences-open').click()`);
  await waitFor(`!document.getElementById('preferences-panel').hidden`); await sleep(800);
  await shot('narrow-memory-panel');
  const yielded = await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('.global-entry'));
    return {opacity:+s.opacity,visibility:s.visibility,pe:s.pointerEvents}})()`);
  await evaluate(`document.getElementById('preferences-close').click()`);
  await waitFor(`document.getElementById('preferences-panel').hidden`); await sleep(500);
  const restoredEntry = await evaluate(`(()=>{const s=getComputedStyle(document.querySelector('.global-entry'));
    return {opacity:+s.opacity,visibility:s.visibility}})()`);
  metrics['narrow-memory-panel'] = {yieldedWhileOpen: yielded, restoredAfterClose: restoredEntry};
  expect('narrow-panel-yields-entry', yielded.opacity < 0.05 && yielded.visibility === 'hidden', yielded);
  expect('narrow-panel-close-restores', restoredEntry.visibility === 'visible' && restoredEntry.opacity > 0.9, restoredEntry);
  await record('narrow-after-memory');

  // P2 regression: focus preferences-open, open memory, close -> focus must
  // return to the entry button (the visibility fade used to strand it on BODY).
  await evaluate(`document.getElementById('preferences-open').focus()`);
  await evaluate(`document.getElementById('preferences-open').click()`);
  await waitFor(`!document.getElementById('preferences-panel').hidden`); await sleep(700);
  await evaluate(`document.getElementById('preferences-close').click()`);
  await waitFor(`document.getElementById('preferences-panel').hidden`); await sleep(600);
  const focusAfter = await evaluate(`document.activeElement && (document.activeElement.id || document.activeElement.tagName)`);
  expect('narrow-memory-focus-restored', focusAfter === 'preferences-open', {activeElement: focusAfter});

  // Same flow under prefers-reduced-motion: transition durations collapse,
  // so the focus restore must not depend on transition timing.
  await cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  await evaluate(`document.getElementById('preferences-open').focus()`);
  await evaluate(`document.getElementById('preferences-open').click()`);
  await waitFor(`!document.getElementById('preferences-panel').hidden`); await sleep(300);
  await evaluate(`document.getElementById('preferences-close').click()`);
  await waitFor(`document.getElementById('preferences-panel').hidden`); await sleep(300);
  const focusAfterRM = await evaluate(`document.activeElement && (document.activeElement.id || document.activeElement.tagName)`);
  expect('narrow-memory-focus-restored-reduced-motion', focusAfterRM === 'preferences-open', {activeElement: focusAfterRM});
  await cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: ''}]});

  // Wide-short window (1440x600): entries compact (top:20) must not collide
  // with the card or overflow the viewport.
  await viewport(1440, 600); await sleep(500);
  await record('wideshort-logged-out'); await shot('wideshort-logged-out');
  const ws = metrics['wideshort-logged-out'];
  expect('wideshort-entry-clear', ws.pairOverflow === false && ws.pairOverlapsCard === false && Math.abs(ws.pairTopVsCardTop) <= 4,
    {overflow: ws.pairOverflow, overlapsCard: ws.pairOverlapsCard, delta: ws.pairTopVsCardTop});

  // P2 regression: find a real detail that actually has action buttons by
  // clicking POI markers (openNearby); if no nearby venue yields buttons, open
  // real demo events through WanderActivities.openEvents — the same function
  // the pin click calls. Then shrink to 1280x320 and assert visibility.
  const ACTIONS = `(()=>{const sel='#activity-detail .activity-detail-footer button,#activity-detail .activity-actions button,#activity-detail .activity-ask,#activity-detail .activity-add';
    const bs=[...document.querySelectorAll(sel)].filter(b=>b.getBoundingClientRect().height>0);
    return {count:bs.length,rects:bs.map(b=>{const r=b.getBoundingClientRect();return {y:+r.y.toFixed(1),bottom:+r.bottom.toFixed(1),h:+r.height.toFixed(1)}}),vh:innerHeight};})()`;
  let actions = null, via = null;
  const dotCount = await evaluate(`document.querySelectorAll('.place-dot').length`);
  for (let i = 0; i < Math.min(dotCount, 15); i++) {
    await evaluate(`document.querySelectorAll('.place-dot')[${i}].click()`);
    if (!await tryWait(`!document.getElementById('activity-detail').hidden`, 4000)) continue;
    await sleep(600);
    actions = await evaluate(ACTIONS); via = `.place-dot[${i}]`;
    if (actions.count > 0) break;
    await evaluate(`document.querySelector('.activity-close')?.click()`);
    await tryWait(`document.getElementById('activity-detail').hidden`, 2000);
    actions = null;
  }
  if (!(actions && actions.count > 0)) {
    // Real-click fallback reason: openNearby() must convert WGS84->GCJ-02 via
    // WanderAMap.convert, but /api/map-config is mocked 404 in this harness,
    // so demo venues can never match within 2.5km of a real POI. We still open
    // through WanderActivities.openEvents — the exact handler a pin click
    // calls — with real event objects from /data/demo-events.json.
    via = `WanderActivities.openEvents(real demo events; ${dotCount} real POI clicks yielded no nearby group: AMap convert mocked out)`;
    await evaluate(`fetch('/data/demo-events.json').then(r=>r.json()).then(d=>window.WanderActivities.openEvents(d.events.slice(0,4),{placeName:'验证场馆'}))`);
    await waitFor(`!document.getElementById('activity-detail').hidden`, 5000); await sleep(500);
    actions = await evaluate(ACTIONS);
  }
  metrics['detail-actions-open'] = {via, dotsTried: Math.min(dotCount, 15), buttons: actions?.count};
  await shot('detail-with-actions');
  await viewport(1280, 320); await sleep(700);
  actions = await evaluate(ACTIONS); // re-measure after the shrink
  await record('short-detail'); await shot('short-detail-actions');
  expect('short-detail-actions-in-viewport',
    actions !== null && actions.count > 0 && actions.rects.every(r => r.y >= 0 && r.bottom <= actions.vh),
    {via, vh: actions?.vh, buttons: actions?.rects});
  await evaluate(`document.querySelector('.activity-close')?.click()`);
  await tryWait(`document.getElementById('activity-detail').hidden`, 3000);
} catch (e) {
  failures.push('fatal: ' + (e && e.message)); log.push('FATAL ' + (e && e.stack || e));
} finally {
  writeFileSync(join(outDir, 'metrics.json'), JSON.stringify({viewport_note: 'pairTopVsCardTop: px delta between entry group top and card top; pairOverlaps*: geometric overlap booleans; *-assert: pass/FAIL entries', failures, metrics, log}, null, 2));
  chrome.kill('SIGKILL'); server.close(); ws.close();
}
process.exitCode = failures.length ? 1 : 0;
console.log(`captured -> ${outDir} | assertions failed: ${failures.length}`);
if (failures.length) console.log('FAILED: ' + failures.join(', '));

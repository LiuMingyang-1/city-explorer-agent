#!/usr/bin/env node
// Issue #16 verification driver: serves the frontend with a mocked
// account API, seeds per-identity history buckets in localStorage, drives
// headless Chromium over CDP, and records sampled CSS mid-flight metrics
// (opacity / translateY / bounding y / heights) to prove the "更多历史规划"
// expand slides-up-fades-in and the collapse fades-down-then-hides — not
// just that the end state is right.
//
//   node docs/issue-16/capture.mjs --root frontend --out docs/issue-16/after
//   node docs/issue-16/capture.mjs --root /tmp/issue16-baseline/frontend --out docs/issue-16/before
//
// Mock scope: /api/me, /api/login, /api/logout are stubbed by this process
// (cookie session, demo/demo-pass -> user u-demo "明轩"); /api/memory is
// stubbed too so the page never hits a real backend. Other /api/* answer
// 404 so the page exercises real fallbacks (/data/demo-events.json, OSM
// tiles). External calls (map tiles, open-meteo, nominatim) hit the real
// network — not mocked, same as docs/issue-20.
// History needs no /api/chat: entries are seeded into the identity buckets
// 'wander.chat-history.v1.guest' (6) and 'wander.chat-history.v1.u-u-demo'
// (3, titles prefixed 账号·) via Page.addScriptToEvaluateOnNewDocument.
import {createServer} from 'node:http';
import {createReadStream, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import {resolve, sep, extname, join} from 'node:path';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';

const argv = process.argv.slice(2); const args = {};
for (let i = 0; i < argv.length; i++) {const a = argv[i].replace(/^--/, ''); const eq = a.indexOf('=');
  if (eq > 0) args[a.slice(0, eq)] = a.slice(eq + 1); else {args[a] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;}}
const root = resolve(args.root || 'frontend');
const outDir = resolve(args.out || 'docs/issue-16/after');
const port = Number(args.port || 5419);
const CHROME = args.chrome || [
  '/Users/lmy/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const USER = {username: 'demo', password: 'demo-pass', id: 'u-demo', display_name: '明轩'};
const mime = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.sse': 'text/event-stream', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2'};

// --- mock + static server (same block as test/issue20-capture.mjs) ---------
const memoryDocs = new Map();
let session = null;
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
    return json(res, 200, {content: memoryDocs.get(who) ?? '', updated_at: '2026-11-14T00:00:00Z'});
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

// --- minimal CDP client (same pattern as test/issue20-capture.mjs) ----------
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${tmpdir()}/issue16-chrome-${port}`, 'about:blank'], {stdio: ['ignore', 'pipe', 'pipe']});
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
const waitFor = async (expr, ms = 8000) => {const t0 = Date.now(); while (Date.now() - t0 < ms) {if (await evaluate(`Boolean(${expr})`)) return; await new Promise(r => setTimeout(r, 120));} throw new Error(`waitFor timeout (${ms}ms): ${expr.slice(0, 90)}`);};
const tryWait = (expr, ms = 8000) => waitFor(expr, ms).then(() => true, () => false);
const failures = [];
const expect = (name, cond, info = {}) => {metrics[name] = {...info, assert: cond ? 'pass' : 'FAIL'}; if (!cond) {failures.push(name); log.push(`FAIL ${name}`);} return cond;};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async name => {const {data} = await cdp('Page.captureScreenshot', {format: 'png'}); writeFileSync(join(outDir, name + '.png'), Buffer.from(data, 'base64')); log.push(`shot ${name}`);};
const viewport = (w, h) => cdp('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: 1, mobile: w < 700});

// Seed runs before any page script on every navigation. Bucket naming comes
// from frontend/history.js: 'wander.chat-history.v1' + ('.demo' only when
// WanderTransport.mock, which this harness never enables) + '.' + identity;
// auth.js bucket() = 'u-'+user.id, so demo login resolves to 'u-u-demo'.
const SEED = `(() => {
  const day = 864e5, now = 1763190000000; // fixed epoch keeps runs deterministic
  const mk = (id, daysAgo, title, extra='') => ({id, createdAt: now-daysAgo*day, updatedAt: now-daysAgo*day+36e5,
    title, messages: [{role:'user', text:title+'需求'+extra},{role:'assistant', text:title+'行程已生成。'}],
    planIndex: null, sessionId: null, latestPlan: null, routeNames: [], location: null});
  const guest = [mk('g1',1,'西安城墙骑行'), mk('g2',2,'回民街半日吃逛'), mk('g3',3,'兵马俑华清池一日','·验收标记T3'),
    mk('g4',5,'大雁塔夜游'), mk('g5',7,'碑林书院门'), mk('g6',9,'华山两日')];
  const acct = [mk('a1',1,'账号·大唐芙蓉园'), mk('a2',4,'账号·曲江池'), mk('a3',8,'账号·终南山')];
  try { localStorage.setItem('wander.chat-history.v1.guest', JSON.stringify(guest));
        localStorage.setItem('wander.chat-history.v1.u-u-demo', JSON.stringify(acct)); } catch {}
})()`;

// Observable state probe: per-row computed opacity + translateY + bounding
// rect, container (list/area) opacity + transform + height, expanded flags.
// Bounding rects already include ancestor transforms, so a translating
// container shows up as moving row y even when rows' own transform is none.
const HIST = `(() => {
  const card = document.querySelector('.glass-card');
  const list = document.getElementById('history-list');
  const rows = [...list.querySelectorAll('.history-entry')];
  const tyOf = s => {const m = new DOMMatrixReadOnly(s.transform); return Number.isFinite(m.m42) ? +m.m42.toFixed(1) : 0;};
  const probe = r => {const s = getComputedStyle(r); const b = r.getBoundingClientRect();
    return {o:+s.opacity, ty:tyOf(s), y:+b.y.toFixed(1), h:+b.height.toFixed(1), disp:s.display, vis:s.visibility,
      t:(r.querySelector('.history-title')||{}).textContent||''};};
  const btn = document.getElementById('more-history');
  const area = document.querySelector('.history-area');
  const areaS = area ? getComputedStyle(area) : null;
  const listS = list ? getComputedStyle(list) : null;
  const listB = list ? list.getBoundingClientRect() : null;
  const probed = rows.map(probe);
  const visCount = probed.filter(r => r.h > 1 && r.vis === 'visible' && r.disp !== 'none' && r.o > 0.05).length;
  return {expanded: card ? card.classList.contains('history-expanded') : null,
    aria: btn.getAttribute('aria-expanded'), label: btn.textContent, disabled: btn.disabled,
    msgsHidden: document.getElementById('messages').hidden, msgsKids: document.getElementById('messages').childElementCount,
    rowCount: rows.length, visCount, rows: probed,
    area: areaS ? {o:+areaS.opacity, ty:tyOf(areaS)} : null,
    list: listS ? {o:+listS.opacity, ty:tyOf(listS), h:listB?+listB.height.toFixed(1):0} : null,
    extraKids: [...list.children].filter(c => !c.classList.contains('history-entry') && !c.classList.contains('history-empty')).length,
    focus: document.activeElement && (document.activeElement.id || document.activeElement.tagName)};})()`;

const metrics = {}; const log = [];
const snap = async name => {metrics[name] = await evaluate(HIST);};
// Sample HIST every `step` ms for `ms`. Stamps are real elapsed ms so
// assertion timing is verifiable from metrics.json alone.
const sample = async (ms, step = 50) => {const t0 = Date.now(), out = [];
  while (Date.now() - t0 <= ms) {out.push({t: Date.now() - t0, v: await evaluate(HIST)}); await sleep(step);} return out;};
// Motion signatures extracted from a sample series.
const sig = series => {
  let fade = null, slide = null, grow = null;
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1].v, b = series[i].v;
    // fade: any row (or the list/area container) observed strictly mid-alpha
    const mid = r => r && r.o > 0.05 && r.o < 0.95;
    if (a.rows.some(mid) || b.rows.some(mid) || mid(a.list) || mid(b.list) || mid(a.area) || mid(b.area)) fade = {at: series[i].t, rows: b.rows.map(r => r.o), list: b.list?.o, area: b.area?.o};
    // slide: same-index row moving upward (y decreasing) or container
    // translateY shrinking toward 0, or the list box growing
    for (let k = 0; k < Math.min(a.rows.length, b.rows.length); k++) {
      const dy = b.rows[k].y - a.rows[k].y;
      if (dy < -1.5) {slide = {at: series[i].t, row: k, dy: +dy.toFixed(1)};}
    }
    if (a.list && b.list && b.list.h - a.list.h > 1.5) grow = {at: series[i].t, dh: +(b.list.h - a.list.h).toFixed(1)};
    if (a.list && b.list && Math.abs(b.list.ty - a.list.ty) > 1.5) slide = slide || {at: series[i].t, containerTy: [a.list.ty, b.list.ty]};
  }
  return {fade, slide, grow};
};
const consistent = (v, wantExpanded, wantRows) => {
  if (!v) return false;
  const ok = v.expanded === wantExpanded && v.aria === String(wantExpanded) && v.visCount === wantRows
    && v.msgsHidden === wantExpanded && v.extraKids === 0
    && v.rows.filter(r => r.h > 1 && r.vis === 'visible' && r.disp !== 'none').every(r => r.o === 1 && r.ty === 0);
  return Boolean(ok);
};
const clickMore = () => evaluate(`document.getElementById('more-history').click()`);
let loaded; on('Page.loadEventFired', () => loaded = true);
const goto = async (w, h) => {await viewport(w, h); loaded = false; await cdp('Page.navigate', {url: `http://127.0.0.1:${port}/`});
  await waitFor(`document.readyState==='complete' && document.getElementById('more-history')`, 15000); await sleep(1400);};

mkdirSync(outDir, {recursive: true});
try {
  await cdp('Page.addScriptToEvaluateOnNewDocument', {source: SEED});
  await goto(1440, 900);
  await snap('desktop-collapsed'); await shot('desktop-collapsed');
  const c0 = metrics['desktop-collapsed'];
  expect('seed-initial-collapsed', consistent(c0, false, 2), {rowCount: c0.rowCount, visCount: c0.visCount, expanded: c0.expanded});

  // ---- expand: rows must slide up and fade in ---------------------------
  await clickMore();
  const sExpand = await sample(900);
  metrics['expand-series'] = sExpand;
  const eSig = sig(sExpand);
  const eEnd = sExpand.at(-1).v;
  await shot('desktop-expanded'); await snap('desktop-expanded');
  expect('expand-final-state', consistent(eEnd, true, 6), {rowCount: eEnd.rowCount, visCount: eEnd.visCount, aria: eEnd.aria, label: eEnd.label});
  expect('expand-fade-observed', eSig.fade !== null, eSig.fade || {note: 'no mid-alpha row/container sample'});
  expect('expand-slide-observed', eSig.slide !== null || eSig.grow !== null, {slide: eSig.slide, grow: eSig.grow});

  // ---- collapse: rows fade/slide down and hide only afterwards ----------
  await clickMore();
  const sCollapse = await sample(1000);
  metrics['collapse-series'] = sCollapse;
  const cSig = sig(sCollapse);
  const firstHidden = sCollapse.find(s => s.v.visCount <= 2);
  const cEnd = sCollapse.at(-1).v;
  await shot('desktop-collapsed-after'); await snap('desktop-collapsed-after');
  expect('collapse-final-state', consistent(cEnd, false, 2), {rowCount: cEnd.rowCount, visCount: cEnd.visCount, aria: cEnd.aria});
  // rows must linger (visible >2) past ~80ms — an instant hide fails here
  expect('collapse-lingers-before-hide', firstHidden !== undefined && firstHidden.t > 80, {firstHiddenAt: firstHidden?.t});
  expect('collapse-fade-observed', cSig.fade !== null, cSig.fade || {note: 'no mid-alpha sample during collapse'});
  // mid-flight frame as visual evidence of the fade-out in progress
  const midT = sCollapse.findIndex(s => s.t > 60 && s.v.visCount > 2);
  if (midT >= 0) metrics['collapse-midframe'] = {t: sCollapse[midT].t, rows: sCollapse[midT].v.rows.map(r => ({o: r.o, y: r.y}))};

  // ---- rapid toggle storm: even count -> collapsed ----------------------
  for (let i = 0; i < 10; i++) {await clickMore(); await sleep(60);}
  await sleep(1300);
  await snap('rapid-even-end'); await shot('rapid-even-end');
  const rEven = metrics['rapid-even-end'];
  expect('rapid-even-consistent', consistent(rEven, false, 2), {expanded: rEven.expanded, visCount: rEven.visCount, rowCount: rEven.rowCount, aria: rEven.aria});

  // ---- rapid toggle storm: odd count -> expanded ------------------------
  for (let i = 0; i < 9; i++) {await clickMore(); await sleep(60);}
  await sleep(1300);
  await snap('rapid-odd-end'); await shot('rapid-odd-end');
  const rOdd = metrics['rapid-odd-end'];
  expect('rapid-odd-consistent', consistent(rOdd, true, 6), {expanded: rOdd.expanded, visCount: rOdd.visCount, rowCount: rOdd.rowCount, aria: rOdd.aria});

  // ---- history selection restores the conversation synchronously ---------
  // open() calls collapseNow(): the expanded DOM is torn down and the
  // restored messages are visible in the SAME task — no 400ms exit wait.
  const title = rOdd.rows[2]?.t;
  await evaluate(`document.querySelectorAll('#history-list .history-entry')[2].click()`);
  await snap('select-immediate');
  const si = metrics['select-immediate'];
  expect('select-sync-restore', si.msgsHidden === false && si.msgsKids > 0 && si.expanded === false
    && !(await evaluate(`!!document.querySelector('#history-list .history-exit')`)),
    {msgsKids: si.msgsKids, expanded: si.expanded});
  await waitFor(`document.getElementById('messages').textContent.includes('验收标记T3')`, 6000);
  await sleep(400);
  await snap('after-select'); await shot('after-select');
  const sel = metrics['after-select'];
  expect('select-restores-conversation', sel.msgsHidden === false && sel.msgsKids > 0, {msgsKids: sel.msgsKids});
  expect('select-collapses-clean', consistent(sel, false, 2), {visCount: sel.visCount, rowCount: sel.rowCount});
  expect('select-excludes-active', !sel.rows.some(r => r.t === title), {opened: title, rows: sel.rows.map(r => r.t)});
  expect('select-focus-input', sel.focus === 'message-input', {focus: sel.focus});

  // ---- new chat DURING the collapse exit tears down synchronously --------
  await clickMore(); await sleep(900);            // expanded
  await clickMore(); await sleep(150);            // exit animation in flight
  const midExit = await evaluate(HIST);
  metrics['midexit-inflight'] = midExit;
  await evaluate(`document.getElementById('new-chat').click()`);
  await snap('newchat-midexit-immediate');
  const nmi = metrics['newchat-midexit-immediate'];
  expect('newchat-midexit-sync', nmi.expanded === false && nmi.msgsHidden === false && nmi.visCount === 2
    && !(await evaluate(`!!document.querySelector('#history-list .history-exit')`)) && nmi.focus === 'message-input',
    {inflightRows: midExit.rowCount, visCount: nmi.visCount, focus: nmi.focus});
  await sleep(500);
  await snap('after-new-chat');
  const nc = metrics['after-new-chat'];
  expect('newchat-collapses-clean', consistent(nc, false, 2), {visCount: nc.visCount});

  // ---- identity switch DURING the collapse exit cleans old DOM at once ---
  // WanderHistory.setIdentity is the exact entry auth.js calls after
  // /api/me|login|logout; invoking it mid-exit exercises collapseNow()
  // against live exiting rows.
  await clickMore(); await sleep(900);            // expanded
  await clickMore(); await sleep(150);            // exit in flight
  await evaluate(`window.WanderHistory.setIdentity('u-u-demo')`);
  await snap('identity-midexit-immediate');
  const imi = metrics['identity-midexit-immediate'];
  expect('identity-midexit-teardown', imi.expanded === false && imi.visCount === 2 && imi.msgsHidden === false
    && imi.rows.every(r => r.t.startsWith('账号·'))
    && !(await evaluate(`!!document.querySelector('#history-list .history-exit')`)),
    {visCount: imi.visCount, titles: imi.rows.map(r => r.t)});
  await evaluate(`window.WanderHistory.setIdentity('guest')`);
  await sleep(300);
  await snap('identity-back-guest');
  const ibg = metrics['identity-back-guest'];
  expect('identity-restores-guest', consistent(ibg, false, 2) && ibg.rows.every(r => !r.t.startsWith('账号·')),
    {titles: ibg.rows.map(r => r.t)});

  // ---- identity switch mid-animation: login while expand is in flight ----
  await clickMore(); await sleep(110); // expand animation in flight
  await evaluate(`document.getElementById('auth-open').click()`);
  await waitFor(`!document.getElementById('auth-panel').hidden`);
  await evaluate(`document.getElementById('auth-username-input').value=${JSON.stringify(USER.username)};document.getElementById('auth-password-input').value=${JSON.stringify(USER.password)};document.getElementById('auth-form').requestSubmit()`);
  await waitFor(`!document.getElementById('auth-signed-in').hidden`);
  await sleep(1200);
  await snap('after-login'); await shot('after-login');
  const li = metrics['after-login'];
  expect('login-collapses-and-switches', consistent(li, false, 2) && li.rows.every(r => r.t.startsWith('账号·')),
    {visCount: li.visCount, titles: li.rows.map(r => r.t)});

  // ---- identity switch mid-animation: logout while expand in flight ------
  await clickMore(); await sleep(110);
  await evaluate(`document.getElementById('auth-open').click()`);
  await waitFor(`!document.getElementById('auth-panel').hidden`);
  await evaluate(`document.getElementById('auth-logout').click()`);
  await waitFor(`!document.getElementById('auth-form').hidden`);
  await sleep(1200);
  await evaluate(`document.getElementById('auth-panel').hidden || document.querySelector('#auth-panel .auth-close')?.click() || document.getElementById('auth-open').click()`);
  await sleep(300);
  await snap('after-logout');
  const lo = metrics['after-logout'];
  expect('logout-collapses-and-restores', consistent(lo, false, 2) && lo.rows.every(r => !r.t.startsWith('账号·')),
    {visCount: lo.visCount, titles: lo.rows.map(r => r.t)});

  // ---- narrow viewport ---------------------------------------------------
  await viewport(390, 844); await sleep(600);
  await snap('narrow-collapsed'); await shot('narrow-collapsed');
  await clickMore();
  const sNarrow = await sample(900);
  metrics['narrow-expand-series'] = sNarrow;
  const nSig = sig(sNarrow);
  const nEnd = sNarrow.at(-1).v;
  await shot('narrow-expanded');
  const overflow = nEnd.rows.some(r => r.h > 1 && r.vis === 'visible' && (r.y < -1 || r.y + r.h > 845));
  expect('narrow-expand-final', consistent(nEnd, true, 6) && !overflow, {visCount: nEnd.visCount, overflow});
  expect('narrow-expand-animated', nSig.fade !== null || nSig.slide !== null || nSig.grow !== null, {fade: nSig.fade, slide: nSig.slide, grow: nSig.grow});
  await clickMore(); await sleep(1100);
  await snap('narrow-collapsed-after');
  const ncEnd = metrics['narrow-collapsed-after'];
  expect('narrow-collapse-final', consistent(ncEnd, false, 2), {visCount: ncEnd.visCount});

  // ---- prefers-reduced-motion: lands instantly, zero residue -------------
  await cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  await clickMore(); await sleep(450);
  await snap('rm-expanded');
  const rmE = metrics['rm-expanded'];
  expect('rm-expand-consistent', consistent(rmE, true, 6), {visCount: rmE.visCount});
  await clickMore(); await sleep(450);
  await snap('rm-collapsed'); await shot('rm-collapsed');
  const rmC = metrics['rm-collapsed'];
  expect('rm-collapse-consistent', consistent(rmC, false, 2), {visCount: rmC.visCount});
  for (let i = 0; i < 8; i++) {await clickMore(); await sleep(50);}
  await sleep(600);
  await snap('rm-rapid-end');
  const rmR = metrics['rm-rapid-end'];
  expect('rm-rapid-consistent', consistent(rmR, false, 2), {visCount: rmR.visCount, expanded: rmR.expanded});
  await cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: ''}]});
} catch (e) {
  failures.push('fatal: ' + (e && e.message)); log.push('FATAL ' + (e && e.stack || e));
} finally {
  writeFileSync(join(outDir, 'metrics.json'), JSON.stringify({note: 'sig(): fade=mid-alpha sample, slide=row y decreasing or container ty moving, grow=list height increasing; consistent(): expanded+aria+visCount+msgsHidden+extraKids+all-visible-rows(o===1,ty===0); *-assert pass/FAIL', failures, metrics, log}, null, 2));
  chrome.kill('SIGKILL'); server.close(); ws.close();
}
process.exitCode = failures.length ? 1 : 0;
console.log(`captured -> ${outDir} | assertions failed: ${failures.length}`);
if (failures.length) console.log('FAILED: ' + failures.join(', '));

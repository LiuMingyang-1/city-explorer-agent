#!/usr/bin/env node
// Issue #16 screen recording: same mock+seed harness as capture.mjs, but
// records via CDP Page.startScreencast and assembles frames with ffmpeg
// into a PR-sized mp4 (and a short gif of one expand/collapse cycle).
//
//   node docs/issue-16/record.mjs --root frontend --out docs/issue-16/video
//
// Two clips: desktop 1440x900 (expand -> collapse -> rapid-click storm ->
// select a history entry) and narrow 390x844 (expand -> collapse -> storm).
// Real pacing is preserved: ffconcat durations come from screencast frame
// timestamps, then the video is normalised to fps=30, h264, ~1280px wide.
//
// NOTE: Chrome runs HEADED here, not headless. In headless mode the
// compositor only produces frames on damage, and this feature's WAAPI
// transform/opacity animations are compositor-driven — headless screencast
// silently delivers ~zero frames during the actual animations (measured:
// 4 frames over 6.7s). Headed mode streams real ~60fps frames. A Chrome
// window briefly appears on screen during the run.
import {createServer} from 'node:http';
import {createReadStream, existsSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import {resolve, sep, extname, join} from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';

const argv = process.argv.slice(2); const args = {};
for (let i = 0; i < argv.length; i++) {const a = argv[i].replace(/^--/, ''); const eq = a.indexOf('=');
  if (eq > 0) args[a.slice(0, eq)] = a.slice(eq + 1); else {args[a] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;}}
const root = resolve(args.root || 'frontend');
const outDir = resolve(args.out || 'docs/issue-16/video');
const port = Number(args.port || 5421);
const CHROME = args.chrome || [
  '/Users/lmy/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const FFMPEG = args.ffmpeg || 'ffmpeg';
const USER = {username: 'demo', password: 'demo-pass', id: 'u-demo', display_name: '明轩'};
const mime = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.sse': 'text/event-stream', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2'};

const memoryDocs = new Map(); let session = null;
const json = (res, code, body, headers = {}) => {res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', ...headers}).end(JSON.stringify(body));};
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost'); const path = url.pathname;
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
  if (path === '/api/memory') return json(res, 200, {content: memoryDocs.get(authed ? `u-${authed.id}` : 'guest') ?? '', updated_at: '2026-11-14T00:00:00Z'});
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

const chrome = spawn(CHROME, ['--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1', '--window-position=40,40', '--window-size=1460,960',
  `--user-data-dir=${tmpdir()}/issue16-rec-${port}`, 'about:blank'], {stdio: ['ignore', 'pipe', 'pipe']});
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const viewport = (w, h) => cdp('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: 1, mobile: w < 700});
const clickMore = () => evaluate(`document.getElementById('more-history').click()`);

const SEED = `(() => {
  const day = 864e5, now = 1763190000000;
  const mk = (id, daysAgo, title, extra='') => ({id, createdAt: now-daysAgo*day, updatedAt: now-daysAgo*day+36e5,
    title, messages: [{role:'user', text:title+'需求'+extra},{role:'assistant', text:title+'行程已生成。'}],
    planIndex: null, sessionId: null, latestPlan: null, routeNames: [], location: null});
  const guest = [mk('g1',1,'西安城墙骑行'), mk('g2',2,'回民街半日吃逛'), mk('g3',3,'兵马俑华清池一日','·验收标记T3'),
    mk('g4',5,'大雁塔夜游'), mk('g5',7,'碑林书院门'), mk('g6',9,'华山两日')];
  const acct = [mk('a1',1,'账号·大唐芙蓉园'), mk('a2',4,'账号·曲江池'), mk('a3',8,'账号·终南山')];
  try { localStorage.setItem('wander.chat-history.v1.guest', JSON.stringify(guest));
        localStorage.setItem('wander.chat-history.v1.u-u-demo', JSON.stringify(acct)); } catch {}
})()`;

let frames = []; let recording = false;
on('Page.screencastFrame', p => {
  if (recording) frames.push({data: p.data, ts: p.metadata?.timestamp ?? Date.now() / 1000, wall: Date.now()});
  cdp('Page.screencastFrameAck', {sessionId: p.sessionId}).catch(() => {});
});

// Frames -> ffconcat (durations from real timestamps) -> mp4 + optional gif.
// Timing is honest: each frame displays for exactly the delta to the next
// frame's compositor timestamp. Gaps above MAXGAP are clamped but counted
// and written to <name>.frames.json — with the screencast warmed up and a
// headed compositor, real gaps stay under ~300ms, so clampedGaps>0 means
// the recording itself was sparse, not that encoding cheated.
const MAXGAP = 1.0;
const buildVideo = (name, w, gifSecs = 0) => {
  if (frames.length < 8) {console.log(`skip ${name}: only ${frames.length} frames`); return;}
  const dir = join(outDir, '.frames-' + name); mkdirSync(dir, {recursive: true});
  const t0 = frames[0].ts;
  let clamped = 0, maxDelta = 0;
  let concat = 'ffconcat version 1.0\n';
  frames.forEach((f, i) => {
    const file = join(dir, `f${String(i).padStart(4, '0')}.jpg`); writeFileSync(file, Buffer.from(f.data, 'base64'));
    const next = frames[i + 1];
    const raw = next ? next.ts - f.ts : 0.5;
    if (raw > MAXGAP) clamped++;
    if (next) maxDelta = Math.max(maxDelta, raw);
    const dur = Math.min(Math.max(raw, 1 / 120), MAXGAP);
    concat += `file '${file}'\nduration ${dur.toFixed(4)}\n`;
  });
  concat += `file '${join(dir, `f${String(frames.length - 1).padStart(4, '0')}.jpg`)}'\n`;
  writeFileSync(join(outDir, name + '.frames.json'), JSON.stringify({
    frameCount: frames.length, spanSecs: +(frames.at(-1).ts - t0).toFixed(3),
    maxGapSecs: +maxDelta.toFixed(3), clampedGaps: clamped, clampSecs: MAXGAP,
    wallSpanSecs: +((frames.at(-1).wall - frames[0].wall) / 1000).toFixed(3),
    note: 'ffconcat per-frame durations = real compositor timestamp deltas; fps=30 resamples (duplicates) to CFR — no frames are fabricated beyond duplication',
    ts: frames.map(f => +f.ts.toFixed(4))}, null, 1));
  const list = join(dir, 'list.txt'); writeFileSync(list, concat);
  const mp4 = join(outDir, name + '.mp4');
  execFileSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', `fps=30,scale=${Math.min(w, 1280)}:-2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', '-movflags', '+faststart', mp4],
    {stdio: 'pipe'});
  const secs = ((frames.at(-1).ts - t0)).toFixed(1);
  if (gifSecs > 0) {
    const gif = join(outDir, name + '.gif');
    execFileSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-t', String(gifSecs),
      '-vf', 'fps=12,scale=760:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer',
      '-loop', '0', gif], {stdio: 'pipe'});
  }
  rmSync(dir, {recursive: true, force: true});
  console.log(`video ${mp4} (${frames.length} frames, ${secs}s span, clampedGaps=${clamped})`);
};
const startRec = async () => {frames = []; recording = true;
  await cdp('Page.startScreencast', {format: 'jpeg', quality: 82, everyNthFrame: 1});};
const stopRec = async () => {await sleep(250); recording = false;
  await cdp('Page.stopScreencast').catch(() => {});};
// Warm the screencast/compositor pipeline with one throwaway expand+collapse
// so the recorded clip has continuous frames from the very first action —
// a cold pipeline used to emit one frame then a multi-second gap.
const warmup = async () => {
  await startRec(); await sleep(300);
  await clickMore(); await sleep(700);
  await clickMore(); await sleep(700);
  await stopRec();
};

mkdirSync(outDir, {recursive: true});
try {
  await cdp('Page.addScriptToEvaluateOnNewDocument', {source: SEED});

  // Desktop clip: expand -> collapse -> rapid storm -> select entry.
  await viewport(1440, 900);
  await cdp('Page.navigate', {url: `http://127.0.0.1:${port}/`});
  await waitFor(`document.readyState==='complete' && document.getElementById('more-history')`, 15000);
  await sleep(1400);
  await warmup();
  await startRec();
  await sleep(500);                       // establish collapsed state
  await clickMore(); await sleep(1400);   // expand: slide-up fade-in
  await clickMore(); await sleep(1200);   // collapse: fade-down then hide
  for (let i = 0; i < 10; i++) {await clickMore(); await sleep(70);} // rapid storm
  await sleep(1300);                      // settle, no residue
  await clickMore(); await sleep(900);    // expand again for selection
  await evaluate(`document.querySelectorAll('#history-list .history-entry')[2].click()`);
  await sleep(1600);                      // conversation restored
  await stopRec();
  buildVideo('expand-collapse-desktop', 1440, 4.2);

  // Narrow clip: expand -> collapse -> storm on the 390px drawer card.
  await viewport(390, 844);
  await cdp('Page.navigate', {url: `http://127.0.0.1:${port}/`});
  await waitFor(`document.readyState==='complete' && document.getElementById('more-history')`, 15000);
  await sleep(1400);
  await warmup();
  await startRec();
  await sleep(500);
  await clickMore(); await sleep(1400);
  await clickMore(); await sleep(1100);
  for (let i = 0; i < 8; i++) {await clickMore(); await sleep(70);}
  await sleep(1200);
  await stopRec();
  buildVideo('expand-collapse-narrow', 390, 0);
} finally {
  chrome.kill('SIGKILL'); server.close(); ws.close();
}
console.log(`done -> ${outDir}`);

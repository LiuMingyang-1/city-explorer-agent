// M4 layout-fix verification: greeting/face non-intersection + long-greeting
// handling across viewports. Adapted from docs/mascot-card-preview/qa/qa-m2.mjs.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFileSync, mkdirSync} from 'node:fs';
const run = promisify(execFile);
const BASE = 'http://127.0.0.1:5619';
const OUT = process.env.OUT || '/tmp/layout-fix';
mkdirSync(OUT, {recursive: true});

const chrome = '/Users/lmy/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const port = 9333;
const {spawn} = await import('node:child_process');
const proc = spawn(chrome, ['--remote-debugging-port=' + port, '--headless=new', '--no-first-run', '--user-data-dir=/tmp/cdp-lf-profile', 'about:blank'], {detached: true, stdio: 'ignore'});
proc.unref();
for (let i = 0; i < 30; i++) {try {const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break;} catch {} await new Promise(r => setTimeout(r, 400));}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = e => {const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) {pending.get(m.id)(m); pending.delete(m.id);}};
const cdp = (method, params = {}) => new Promise(res => {const i = ++id; pending.set(i, res); ws.send(JSON.stringify({id: i, method, params}));});
const evaluate = async (expr, awaitP = false) => {const r = await cdp('Runtime.evaluate', {expression: expr, awaitPromise: awaitP, returnByValue: true}); if (r.result?.exceptionDetails) console.log('EVAL ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value;};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async name => {const r = await cdp('Page.captureScreenshot', {format: 'png'}); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));};

const results = [];
const expect = (name, ok, detail) => {results.push({name, ok: !!ok}); if (!ok) console.log('FAIL', name, JSON.stringify(detail).slice(0, 500)); else console.log('pass', name);};

const nav = async (mock, w, h, dpr = 1) => {
  await cdp('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: dpr, mobile: w <= 700});
  await cdp('Page.navigate', {url: `${BASE}/?mock=${mock}`});
  await sleep(1400);
};

const PROBE = `(() => {
  const face = document.querySelector('boop-face.card-mascot');
  const R = el => {const r = el.getBoundingClientRect(); return {left:+r.left.toFixed(1),top:+r.top.toFixed(1),right:+r.right.toFixed(1),bottom:+r.bottom.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1)}};
  const m = face ? R(face) : null;
  const hit = (a,b) => !(a.right<=b.left+.5||b.right<=a.left+.5||a.bottom<=b.top+.5||b.bottom<=a.top+.5);
  const vis = el => el && getComputedStyle(el).display !== 'none';
  const T = {newChat:'#new-chat',weather:'.weather',messages:'#messages',composer:'.composer-area',moreHistory:'#more-history'};
  const col = {};
  for (const [k,s] of Object.entries(T)) {const el=document.querySelector(s); col[k]=vis(el)?{hit:m?hit(m,R(el)):null,rect:R(el)}:'hidden';}
  return {innerW:innerWidth, clientW:document.documentElement.clientWidth, dpr:devicePixelRatio,
    state:window.WanderMascot?.state ?? null, mascot:m, card:R(document.querySelector('.glass-card')),
    faceCount:document.querySelectorAll('boop-face').length,
    hasConv:!!document.querySelector('.glass-card')?.classList.contains('has-conversation'),
    sameNode: window.__m ? window.__m === face : null, col};})()`;

const LINES = `(() => {
  const h1 = document.querySelector('.welcome h1');
  const face = document.querySelector('boop-face.card-mascot');
  if (!h1 || !face || getComputedStyle(h1).display === 'none' || !h1.closest('.welcome').offsetParent) return null;
  const m = face.getBoundingClientRect();
  const rects = [];
  const walk = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT);
  let n; const seen = [];
  while ((n = walk.nextNode())) {const rg = document.createRange(); rg.selectNodeContents(n);
    for (const r of rg.getClientRects()) {const key = r.top.toFixed(0)+'/'+r.left.toFixed(0); if (!seen.includes(key)) {seen.push(key); rects.push({t:n.textContent.slice(0,14),top:+r.top.toFixed(1),bottom:+r.bottom.toFixed(1),left:+r.left.toFixed(1),right:+r.right.toFixed(1)});}}}
  const hit = r => !(r.right<=m.left+.5||m.right<=r.left+.5||r.bottom<=m.top+.5||m.bottom<=r.top+.5);
  const btn = document.getElementById('new-chat').getBoundingClientRect();
  const bhit = r => !(r.right<=btn.left+.5||btn.right<=r.left+.5||r.bottom<=btn.top+.5||btn.bottom<=r.top+.5);
  return {lines:rects, faceHit:rects.filter(hit), btnHit:rects.filter(bhit), mascot:{left:+m.left.toFixed(1),right:+m.right.toFixed(1),top:+m.top.toFixed(1),bottom:+m.bottom.toFixed(1)}};})()`;

const viewportCheck = async (tag, w, h, dpr, wantW) => {
  await nav('comparison', w, h, dpr);
  await evaluate(`window.__m = document.querySelector('boop-face.card-mascot')`);
  const p = await evaluate(PROBE);
  expect(`${tag}.css-px`, p.innerW === w && p.clientW === w, {innerW: p.innerW, clientW: p.clientW});
  expect(`${tag}.welcome-size`, Math.abs(p.w ?? p.mascot?.w - wantW) < 1.5, {w: p.mascot?.w});
  expect(`${tag}.no-collision`, Object.values(p.col).every(v => v === 'hidden' || v.hit === false), p.col);
  const lines = await evaluate(LINES);
  console.log(` ${tag} lines:`, JSON.stringify(lines?.lines), 'face:', JSON.stringify(lines?.mascot));
  expect(`${tag}.text-clear-of-face`, (lines?.faceHit?.length || 0) === 0, lines?.faceHit);
  await shot(`${tag}-welcome`);
  // long greeting: constrained viewports use nowrap+ellipsis (Range rects report
  // unclipped extents, so assert on the greet-line element box + computed style);
  // tall viewports wrap naturally and Range extents must stay inside the card.
  await evaluate(`document.getElementById('greeting').textContent = '好久不见，欢迎回到西安城市漫游规划小助手'`);
  await sleep(150);
  const lg = await evaluate(LINES);
  const gr = await evaluate(`(()=>{const g=document.querySelector('.greet-line');const r=g.getBoundingClientRect();const cs=getComputedStyle(g);const btn=document.getElementById('new-chat').getBoundingClientRect();return {left:+r.left.toFixed(1),right:+r.right.toFixed(1),ws:cs.whiteSpace,ov:cs.overflowX,to:cs.textOverflow,padR:+cs.paddingRight.replace('px',''),btnLeft:+btn.left.toFixed(1),scrollW:g.scrollWidth,clientW:g.clientWidth}})()`);
  console.log(` ${tag} long-greet box:`, JSON.stringify(gr));
  const constrained = (h <= 700 && w > 700) || w <= 700;
  expect(`${tag}.long-greet-clear`, (lg?.faceHit?.length || 0) === 0, lg?.faceHit);
  if (constrained) {
    expect(`${tag}.long-greet-ellipsis`, gr.ws === 'nowrap' && gr.ov === 'hidden' && gr.to === 'ellipsis' && (gr.right - gr.padR) <= gr.btnLeft + 0.5 && gr.scrollW > gr.clientW, gr);
  } else {
    expect(`${tag}.long-greet-wraps-in-card`, lg.lines.every(l => l.right <= p.card.right + 1 && l.right <= gr.btnLeft + 0.5 || l.top > 90), {lines: lg.lines, btnLeft: gr.btnLeft});
    expect(`${tag}.long-greet-not-clipped`, lg.lines.every(l => l.right <= p.card.right + 1), {maxRight: Math.max(...lg.lines.map(l => l.right)), cardRight: p.card.right});
  }
  await shot(`${tag}-long-greeting`);
  await evaluate(`document.getElementById('greeting').textContent = '下午好'`);
  return p;
};

await viewportCheck('v1440', 1440, 900, 1, 85.2);
await viewportCheck('v1440s', 1440, 680, 1, 85.2);   // short wide desktop
await viewportCheck('v1024', 1024, 600, 1, 68.1);
await viewportCheck('v900t', 900, 800, 1, 64);        // tall narrow desktop
await viewportCheck('v800', 800, 480, 1, 64);
await viewportCheck('v320', 320, 568, 2, 60);

// chat transition continuity + reset on 320 (worst case)
await cdp('Emulation.setDeviceMetricsOverride', {width: 320, height: 568, deviceScaleFactor: 2, mobile: true});
await cdp('Page.navigate', {url: `${BASE}/?mock=comparison`});
await sleep(1400);
await evaluate(`window.__m = document.querySelector('boop-face.card-mascot')`);
await evaluate(`window.WANDER_CONFIG = Object.assign({}, window.WANDER_CONFIG, {mockDelay: 800})`);
await evaluate(`(() => {const i = document.getElementById('message-input'); i.value = '帮我规划西安一日游'; i.dispatchEvent(new Event('input', {bubbles: true})); document.getElementById('chat-form').requestSubmit(); return true})()`);
await sleep(2600);
const mid = await evaluate(PROBE);
expect('v320.chat-thinking-same-node', mid.sameNode === true && mid.state === 'searching' || mid.state === 'thinking', {state: mid.state, same: mid.sameNode});
await sleep(6000);
const chat = await evaluate(PROBE);
expect('v320.chat-happy-48', chat.state === 'happy' && Math.abs(chat.mascot.w - 48) < 1.5 && chat.sameNode === true, {state: chat.state, w: chat.mascot?.w, same: chat.sameNode});
expect('v320.chat-no-collision', Object.values(chat.col).every(v => v === 'hidden' || v.hit === false), chat.col);
await shot('v320-chat');
// new chat → welcome reset
await evaluate(`document.getElementById('new-chat').click()`);
await sleep(900);
const back = await evaluate(PROBE);
expect('v320.reset-idle-60', back.state === 'idle' && Math.abs(back.mascot.w - 60) < 1.5 && back.sameNode === true, {state: back.state, w: back.mascot?.w});
const backLines = await evaluate(LINES);
expect('v320.reset-text-clear', (backLines?.faceHit?.length || 0) === 0, backLines?.faceHit);
await shot('v320-reset-welcome');

// reduced motion sanity at 1024
await nav('comparison', 1024, 600, 1);
await cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
const rm = await evaluate(`getComputedStyle(document.querySelector('boop-face.card-mascot')).transitionDuration`);
expect('rm.transition-none', rm === '0s' || rm === '', {rm});
await cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: ''}]});

const fails = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - fails.length}/${results.length} pass ===`);
writeFileSync(`${OUT}/metrics.json`, JSON.stringify({results}, null, 2));
ws.close();
process.exit(fails.length ? 1 : 0);

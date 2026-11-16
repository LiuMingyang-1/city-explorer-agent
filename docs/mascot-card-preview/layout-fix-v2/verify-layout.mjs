// M5 layout-fix-v2 verification: uniform single-line greeting ellipsis.
// Key property: greeting length must not move weather/composer/history
// (all element rects invariant between normal and long greeting), no
// text/face/button intersections, and no element pairs beyond documented
// baseline overlaps of the absolutely-positioned welcome layout.
import {writeFileSync, mkdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
const BASE = 'http://127.0.0.1:5619';
const OUT = process.env.OUT || '/tmp/layout-fix-v2';
mkdirSync(OUT, {recursive: true});

const chrome = '/Users/lmy/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const port = 9335;
const proc = spawn(chrome, ['--remote-debugging-port=' + port, '--headless=new', '--no-first-run', '--user-data-dir=/tmp/cdp-lf2-profile', 'about:blank'], {detached: true, stdio: 'ignore'});
proc.unref();
for (let i = 0; i < 30; i++) {try {const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break;} catch {} await new Promise(r => setTimeout(r, 400));}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = e => {const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) {pending.get(m.id)(m); pending.delete(m.id);}};
const cdp = (method, params = {}) => new Promise(res => {const i = ++id; pending.set(i, res); ws.send(JSON.stringify({id: i, method, params}));});
const evaluate = async expr => {const r = await cdp('Runtime.evaluate', {expression: expr, returnByValue: true}); if (r.result?.exceptionDetails) console.log('EVAL ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value;};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async name => {const r = await cdp('Page.captureScreenshot', {format: 'png'}); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));};

const results = [];
const expect = (name, ok, detail) => {results.push({name, ok: !!ok}); if (!ok) console.log('FAIL', name, JSON.stringify(detail).slice(0, 500)); else console.log('pass', name);};

const nav = async (mock, w, h, dpr = 1) => {
  await cdp('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: dpr, mobile: w <= 700});
  await cdp('Page.navigate', {url: `${BASE}/?mock=${mock}`});
  await sleep(1400);
};

const AUDIT = `(() => {
  const R = el => {const r = el.getBoundingClientRect(); return {left:+r.left.toFixed(1),top:+r.top.toFixed(1),right:+r.right.toFixed(1),bottom:+r.bottom.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1)}};
  const vis = el => el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && +getComputedStyle(el).opacity > 0;
  const hit = (a,b) => !(a.right<=b.left+.5||b.right<=a.left+.5||a.bottom<=b.top+.5||b.bottom<=a.top+.5);
  const card = R(document.querySelector('.glass-card'));
  const face = document.querySelector('boop-face.card-mascot');
  const m = face ? R(face) : null;
  const h1 = document.querySelector('.welcome h1');
  const lines = [];
  if (h1 && vis(h1)) {
    const walk = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT);
    let n; const seen = [];
    while ((n = walk.nextNode())) {const rg = document.createRange(); rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) {const key = r.top.toFixed(0)+'/'+r.left.toFixed(0); if (!seen.includes(key)) {seen.push(key); lines.push({t:n.textContent.slice(0,12),top:+r.top.toFixed(1),bottom:+r.bottom.toFixed(1),left:+r.left.toFixed(1),right:+r.right.toFixed(1)});}}}
  }
  const g = document.querySelector('.greet-line');
  const gr = g ? R(g) : null;
  const gcs = g ? getComputedStyle(g) : null;
  const els = {};
  for (const [k,s] of Object.entries({newChat:'#new-chat',weather:'.weather',locForm:'.location-form',locStatus:'#location-status',composer:'.composer-area',messages:'#messages',history:'.history-area'})) {
    const el = document.querySelector(s); els[k] = vis(el) ? R(el) : null;
  }
  const faceHits = m ? lines.filter(l => hit(l, m)) : [];
  // line texts whose *measured* extent crosses the button AND is on the
  // button's vertical band — combined with ellipsis clipping, the visible
  // text edge is bounded by the greet-line box instead (asserted via box).
  const pairs = [];
  const check = (a, b, ka, kb) => {if (a && b && hit(a, b)) pairs.push(ka + 'x' + kb);};
  check(els.weather, els.composer, 'weather', 'composer');
  check(els.locForm, els.composer, 'locForm', 'composer');
  check(els.locStatus, els.composer, 'locStatus', 'composer');
  check(els.composer, els.history, 'composer', 'history');
  check(els.composer, els.messages, 'composer', 'messages');
  const insideCard = el => el ? (el.left >= card.left - .5 && el.right <= card.right + .5 && el.top >= card.top - .5 && el.bottom <= card.bottom + .5) : null;
  return {card, mascot:m, lines,
    greet: gr ? {...gr, ws:gcs.whiteSpace, to:gcs.textOverflow, padR:+gcs.paddingRight.replace('px',''), scrollW:g.scrollWidth, clientW:g.clientWidth} : null,
    els, faceHits, pairs,
    inside: {composer: insideCard(els.composer), weather: insideCard(els.weather)},
    state: window.WanderMascot?.state};})()`;

const rectEq = (a, b) => a && b && Math.abs(a.top-b.top)<.6 && Math.abs(a.bottom-b.bottom)<.6 && Math.abs(a.left-b.left)<.6 && Math.abs(a.right-b.right)<.6;
// baseline pair overlaps inherent to the absolutely-positioned welcome layout
// (composer is anchored at card 50%), verified against qa/metrics.json pre-fix
// numbers: p800 weather.bottom 255.1 > composer.top 214; p320 composer.bottom
// 383 > messages.top 372.6.
const viewportAudit = async (tag, w, h, dpr, wantW, baselinePairs) => {
  await nav('comparison', w, h, dpr);
  await evaluate(`window.__m = document.querySelector('boop-face.card-mascot')`);
  const a0 = await evaluate(AUDIT);
  expect(`${tag}.css-px`, await evaluate('innerWidth') === w, null);
  expect(`${tag}.size`, Math.abs((a0.mascot?.w ?? 0) - wantW) < 1.5, a0.mascot);
  expect(`${tag}.face-text-clear`, a0.faceHits.length === 0, a0.faceHits);
  expect(`${tag}.pairs-subset-baseline`, a0.pairs.every(p => baselinePairs.includes(p)), {pairs: a0.pairs, baseline: baselinePairs});
  await shot(`${tag}-welcome`);
  // long greeting: nothing may move; visible greeting text is clipped by
  // overflow:hidden at the box's content edge (right - padR), which must
  // precede the new-chat button.
  await evaluate(`document.getElementById('greeting').textContent = '好久不见，欢迎回到西安城市漫游规划小助手'`);
  await sleep(150);
  const a1 = await evaluate(AUDIT);
  const moved = Object.keys(a0.els).filter(k => a0.els[k] && a1.els[k] && !rectEq(a0.els[k], a1.els[k]));
  expect(`${tag}.lg-face-clear`, a1.faceHits.length === 0, a1.faceHits);
  expect(`${tag}.lg-nothing-moves`, moved.length === 0, {moved, before: a0.els.weather, after: a1.els.weather});
  expect(`${tag}.lg-ellipsis`, a1.greet && a1.greet.ws === 'nowrap' && a1.greet.to === 'ellipsis' && a1.greet.scrollW > a1.greet.clientW && (a1.greet.right - a1.greet.padR) <= (a1.els.newChat?.left ?? 0) + .5, a1.greet);
  expect(`${tag}.lg-pairs-subset-baseline`, a1.pairs.every(p => baselinePairs.includes(p)) && a1.inside.composer === true, {pairs: a1.pairs, baseline: baselinePairs, composer: a1.els.composer, card: a1.card});
  await shot(`${tag}-long-greeting`);
  await evaluate(`document.getElementById('greeting').textContent = '下午好'`);
  await sleep(80);
};

await viewportAudit('v900x800', 900, 800, 1, 64, []);   // P2 repro viewport
await viewportAudit('v900x701', 900, 701, 1, 64, []);   // boundary: just above short media
await viewportAudit('v900x700', 900, 700, 1, 64, []);   // boundary: short media edge
await viewportAudit('v1024', 1024, 600, 1, 68.1, []);
await viewportAudit('v800', 800, 480, 1, 64, ['weatherxcomposer', 'locFormxcomposer']);
await viewportAudit('v1440', 1440, 900, 1, 85.2, []);
await viewportAudit('v320', 320, 568, 2, 60, ['composerxmessages']);

// welcome→chat continuity + reset + history on the P2 viewport (900x800)
await cdp('Emulation.setDeviceMetricsOverride', {width: 900, height: 800, deviceScaleFactor: 1, mobile: false});
await cdp('Page.navigate', {url: `${BASE}/?mock=comparison`});
await sleep(1400);
await evaluate(`window.__m = document.querySelector('boop-face.card-mascot')`);
await evaluate(`window.WANDER_CONFIG = Object.assign({}, window.WANDER_CONFIG, {mockDelay: 800})`);
await evaluate(`(() => {const i = document.getElementById('message-input'); i.value = '帮我规划西安一日游'; i.dispatchEvent(new Event('input', {bubbles: true})); document.getElementById('chat-form').requestSubmit(); return true})()`);
await sleep(9000);
let a = await evaluate(AUDIT);
expect('chat.happy-52-same', a.state === 'happy' && Math.abs(a.mascot.w - 52) < 1.5 && (await evaluate(`window.__m === document.querySelector('boop-face.card-mascot')`)) === true, {state: a.state, w: a.mascot.w});
expect('chat.pairs-empty', a.pairs.length === 0, a.pairs);
await shot('chat-900x800');
await evaluate(`document.getElementById('new-chat').click()`);
await sleep(900);
a = await evaluate(AUDIT);
expect('reset.idle-64', a.state === 'idle' && Math.abs(a.mascot.w - 64) < 1.5, {state: a.state, w: a.mascot.w});
expect('reset.face-text-clear', a.faceHits.length === 0, a.faceHits);
await evaluate(`document.querySelector('.history-list .history-item, .history-list [data-session-id], .history-list > *')?.click()`);
await sleep(1200);
const hist = await evaluate(`(()=>{const f=document.querySelector('boop-face.card-mascot');return f?{w:+f.getBoundingClientRect().width.toFixed(1),state:window.WanderMascot.state}:null})()`);
expect('history.52px', hist && Math.abs(hist.w - 52) < 1.5, hist);
await cdp('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
const rm = await evaluate(`getComputedStyle(document.querySelector('boop-face.card-mascot')).transitionDuration`);
expect('rm.transition-none', rm === '0s', {rm});

const fails = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - fails.length}/${results.length} pass ===`);
writeFileSync(`${OUT}/metrics.json`, JSON.stringify({results, note: 'Range.getClientRects reports unclipped text extents; greeting visible bounds are asserted via the greet-line box content edge (right-padR) vs #new-chat.left plus ellipsis computed style.'}, null, 2));
ws.close();
process.exit(fails.length ? 1 : 0);

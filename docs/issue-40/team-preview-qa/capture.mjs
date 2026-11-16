#!/usr/bin/env node
// I40-F2b 预览页浏览器 QA（离线模拟，headless Chromium + CDP）。
//   node docs/issue-40/team-preview-qa/capture.mjs
// 驱动真实 UI（场景步骤器按钮）+ __preview 只读钩子做断言；全部点击手动逐条
// 发事件，无自动剧本。指标如实标注「headless Chromium 测量值」。
import {createServer} from 'node:http';
import {createReadStream, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {stat} from 'node:fs/promises';
import {resolve, sep, extname, join} from 'node:path';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';

const argv = process.argv.slice(2); const args = {};
for (let i = 0; i < argv.length; i++) {const a = argv[i].replace(/^--/, ''); const eq = a.indexOf('=');
  if (eq > 0) args[a.slice(0, eq)] = a.slice(eq + 1); else {args[a] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;}}
const repoRoot = resolve(new URL('../../../', import.meta.url).pathname);
const root = resolve(args.root || join(repoRoot, 'frontend'));
const outDir = resolve(args.out || join(repoRoot, 'docs/issue-40/team-preview-qa'));
const shotsDir = join(outDir, 'shots');
const CHROME = args.chrome || [
  '/Users/lmy/Library/Caches/ms-playwright/chromium-1200/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const mime = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png'};

if (!CHROME) {console.error('no chromium found'); process.exit(2);}
const server = createServer(async (req, res) => {
  const path = new URL(req.url || '/', 'http://localhost').pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') {res.writeHead(405); return res.end();}
  try {
    const file = resolve(root, '.' + decodeURIComponent(path));
    if (!file.startsWith(root + sep) && file !== root) {res.writeHead(404); return res.end();}
    const target = path === '/' ? join(root, 'mascot-team-preview.html') : file;
    if (!(await stat(target)).isFile()) {res.writeHead(404); return res.end();}
    res.writeHead(200, {'Content-Type': (mime[extname(target)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-cache'});
    if (req.method === 'HEAD') res.end(); else createReadStream(target).on('error', () => res.destroy()).pipe(res);
  } catch {res.writeHead(404); res.end();}
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1', `--user-data-dir=${tmpdir()}/i40f2b-chrome-${port}`, 'about:blank'],
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
const evaluate = async expr => (await cdp('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true})).result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (expr, ms = 8000) => {const t0 = Date.now(); while (Date.now() - t0 < ms) {if (await evaluate(`Boolean(${expr})`)) return; await sleep(120);} throw new Error(`waitFor: ${expr.slice(0, 90)}`);};

const metrics = {}; const failures = []; const log = [];
const expect = (name, cond, info = {}) => {metrics[name] = {assert: cond ? 'pass' : 'FAIL', ...info}; if (!cond) failures.push(name);};
const record = (name, value) => {metrics[name] = value;};
const shot = async name => {const {data} = await cdp('Page.captureScreenshot', {format: 'png'}); writeFileSync(join(shotsDir, name + '.png'), Buffer.from(data, 'base64')); log.push(`shot ${name}`);};
// Element-clipped shot: scroll the section into view, capture its page rect.
const shotEl = async (sel, name, pad = 12) => {
  const rect = await evaluate(`(() => {const el = document.querySelector(${JSON.stringify(sel)});
    el.scrollIntoView({block: 'start'}); const r = el.getBoundingClientRect();
    return {x: Math.max(0, r.x + scrollX - ${pad}), y: Math.max(0, r.y + scrollY - ${pad}),
      width: Math.min(document.scrollingElement.scrollWidth - Math.max(0, r.x + scrollX - ${pad}), r.width + ${2 * pad}),
      height: r.height + ${2 * pad}};})()`);
  const {data} = await cdp('Page.captureScreenshot', {format: 'png', clip: {...rect, scale: 1}});
  writeFileSync(join(shotsDir, name + '.png'), Buffer.from(data, 'base64')); log.push(`shot ${name}`);
};
const scrollLogEnd = () => evaluate(`(() => {const l = document.getElementById('event-log'); l.scrollTop = l.scrollHeight;})()`);
const viewport = (w, h) => cdp('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: 1, mobile: w < 700});

// helpers driving the real page
const click = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.click()`);
const clickStep = () => click('#btn-next-step');
const selectScenario = async name => {
  await evaluate(`[...document.querySelectorAll('#scenario-list button')].find(b => b.textContent.includes(${JSON.stringify(name)}))?.click()`);
  await sleep(60);
};
const runSteps = async n => {for (let i = 0; i < n; i++) {await clickStep(); await sleep(90);}};
const runAllSteps = async () => {for (let i = 0; i < 30; i++) {if (await evaluate(`document.getElementById('btn-next-step').disabled`)) break; await clickStep(); await sleep(90);}};
const snap = () => evaluate(`window.__preview?.snapshot()`);
const stripFaces = () => evaluate(`document.querySelectorAll('#team-strip boop-face').length`);
const cloneNodes = () => evaluate(`document.querySelectorAll('#team-strip .mascot-team-clone, #team-strip [class*="clone"]').length`);
const cloneInfo = () => evaluate(`[...document.querySelectorAll('#team-strip .mascot-team-clone, #team-strip [class*="clone"]')].map(el => {
  const face = el.querySelector('boop-face');
  const crown = face?.shadowRoot?.querySelector('#wander-hat [data-tone="crown"]')?.getAttribute('fill') || null;
  const titleEl = el.querySelector('.mascot-team-title, [class*="title"]');
  const badgeEl = el.querySelector('.mascot-team-badge, [class*="badge"]');
  return {crown, title: titleEl?.textContent ?? null, titleHasChildren: titleEl ? titleEl.children.length > 0 : null,
    badge: badgeEl?.textContent ?? null, badgeHasChildren: badgeEl ? badgeEl.children.length > 0 : null};})`);
const overflowText = () => evaluate(`document.querySelector('#team-strip .mascot-team-overflow, #team-strip [class*="overflow"]')?.textContent ?? null`);
const mainState = () => evaluate(`window.__preview?.mascotState()`);
const fps = async (ms = 2000) => evaluate(`new Promise(res => {let n = 0; const t0 = performance.now();
  const tick = () => {n++; if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick); else res(+(n / ((performance.now() - t0) / 1000)).toFixed(1));};
  requestAnimationFrame(tick);})`);
const heap = () => evaluate(`performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(2) : null`);

mkdirSync(shotsDir, {recursive: true});
let loaded; on('Page.loadEventFired', () => loaded = true);
try {
  await viewport(1180, 860);
  loaded = false;
  await cdp('Page.navigate', {url: `http://127.0.0.1:${port}/mascot-team-preview.html`});
  await waitFor(`document.readyState==='complete'`, 15000);
  await waitFor(`document.querySelector('#main-face') && document.querySelector('#main-face').shadowRoot`, 15000);
  await sleep(900);

  const moduleReady = await evaluate(`Boolean(window.__preview)`);
  record('module-ready', moduleReady);
  if (!moduleReady) {
    log.push('mascot-team.js 未就位：仅验证页面框架');
    expect('frame-error-notice-shown', await evaluate(`!document.getElementById('load-error').hidden`));
    expect('frame-main-face-mounted', await evaluate(`document.querySelector('#main-face').shadowRoot.querySelector('#wander-hat') !== null`));
    expect('frame-scenarios-listed', await evaluate(`document.querySelectorAll('#scenario-list button').length`) >= 8,
      {count: await evaluate(`document.querySelectorAll('#scenario-list button').length`)});
    await shot('00-frame-module-absent');
    await viewport(320, 700); await sleep(500);
    expect('frame-320-no-horizontal-scroll', await evaluate(`document.scrollingElement.scrollWidth <= 321`),
      {scrollWidth: await evaluate(`document.scrollingElement.scrollWidth`)});
    await shot('00-frame-320');
  } else {
    // ——— A. 三分身组合 + 槽位帽色 + 独立实例 ———
    await selectScenario('3 分身'); await runSteps(4); await sleep(400);
    expect('team-3-visible-faces', (await stripFaces()) === 3, {faces: await stripFaces()});
    const info3 = await cloneInfo();
    record('team-3-clone-info', info3);
    expect('team-3-hat-palettes', info3.map(i => i.crown).join() === ['#cfb88c', '#ba8e77', '#82916f'].join(),
      {crowns: info3.map(i => i.crown)});
    expect('team-3-distinct-shadow-roots', await evaluate(`(() => {const f=[...document.querySelectorAll('#team-strip boop-face')];
      return f.length === 3 && new Set(f.map(x => x.shadowRoot)).size === 3 && f.every(x => x.shadowRoot.querySelector('#wander-hat'));})()`));
    expect('team-3-titles-textcontent', info3.every(i => i.title && i.titleHasChildren === false), {titles: info3.map(i => i.title)});
    expect('team-3-badges-textcontent', info3.every(i => i.badge && i.badgeHasChildren === false), {badges: info3.map(i => i.badge)});
    const s3 = await snap();
    expect('team-3-snapshot', s3.clones.length === 3 && s3.phase !== 'idle', {phase: s3.phase, beat: s3.beat, round: s3.round});
    await shotEl('.stage', '01-combo-3');
    // 主脸相位在 spawn 期间仍是 thinking
    expect('team-3-mainface-thinking', (await mainState()) === 'thinking', {state: await mainState()});
    // 同一实例：tool_call 脉冲不得重建分身 DOM
    await evaluate(`window.__qaFace0 = document.querySelector('#team-strip boop-face')`);
    await runSteps(1); await sleep(350); // tool_call（盖章 sub-c）
    expect('clone-instance-stable-after-tool', await evaluate(
      `window.__qaFace0 && window.__qaFace0 === document.querySelector('#team-strip boop-face') && document.querySelectorAll('#team-strip boop-face').length === 3`));

    // ——— B. stage 不回收 pending ———
    await selectScenario('1 分身'); await runSteps(6); await sleep(300); // begin→spawn→tool→routing→validating→exploring(重复)
    const sB = await snap();
    expect('stage-repeat-keeps-pending', sB.clones.some(c => c.id === 'sub-a' || c.title), {clones: sB.clones, phase: sB.phase});
    expect('stage-validating-mainface', (await mainState()) === 'validating', {state: await mainState()});
    await shotEl('.stage', '02-stage-repeat-pending-alive');
    await runAllSteps(); await sleep(300);

    // ——— C. 1 分身组合截图（新一轮） ———
    await selectScenario('1 分身'); await runSteps(3); await sleep(400); await shotEl('.stage', '03-combo-1');
    await runAllSteps(); await sleep(300);
    await selectScenario('2 分身'); await runSteps(3); await sleep(400);
    expect('team-2-visible-faces', (await stripFaces()) === 2, {faces: await stripFaces()});
    await shotEl('.stage', '04-combo-2');
    await runAllSteps(); await sleep(300);

    // ——— D. 溢出 >3：3 可见 + +N，done 补位 ———
    await selectScenario('溢出'); await runSteps(6); await sleep(400); // begin + 5 spawn
    expect('overflow-3-visible', (await stripFaces()) === 3, {faces: await stripFaces()});
    const sOv = await snap();
    expect('overflow-waiting-count', sOv.overflow === 2, {overflow: sOv.overflow, text: await overflowText()});
    await shotEl('.stage', '05-overflow-5');
    await runSteps(2); await sleep(500); // 2 个 done → 等待池补位
    const sOv2 = await snap();
    expect('overflow-backfill', sOv2.clones.length === 3, {clones: sOv2.clones.map(c => c.id), overflow: sOv2.overflow});
    await shotEl('.stage', '06-overflow-backfill');
    await runAllSteps(); await sleep(300);

    // ——— E. 部分失败，其余继续 ———
    await selectScenario('部分失败'); await runSteps(5); await sleep(400); // begin+3spawn+done(B,failed)
    const sPf = await snap();
    expect('partial-fail-others-alive', sPf.clones.length === 2 || (await stripFaces()) >= 2,
      {clones: sPf.clones.map(c => `${c.id}:${c.status}`)});
    expect('partial-fail-mainface-not-confused', (await mainState()) !== 'confused', {state: await mainState()});
    await shotEl('.stage', '07-partial-fail');
    await runAllSteps(); await sleep(300);

    // ——— F. 墓碑：done 先于 spawn ———
    await selectScenario('墓碑'); await runSteps(3); await sleep(400); // begin→done(ghost)→spawn(ghost)迟到
    const sTb = await snap();
    const ghost = sTb.clones.find(c => c.id === 'sub-ghost');
    record('tombstone-ghost-clone', ghost ?? null);
    expect('tombstone-not-revived', (!ghost || /done|finish|tomb/i.test(String(ghost.status))) && sTb.finished >= 1,
      {ghost, finished: sTb.finished});
    await runSteps(1); await sleep(300); // spawn A 正常
    await shotEl('.stage', '08-tombstone');
    await runAllSteps(); await sleep(300);

    // ——— G. 嵌套聚合 ———
    await selectScenario('嵌套'); await runSteps(3); await sleep(300); // begin→spawn A→嵌套 spawn
    const sNt = await snap();
    expect('nested-aggregated-not-toplevel', sNt.nested >= 1 && sNt.clones.length === 1,
      {nested: sNt.nested, clones: sNt.clones.map(c => c.id)});
    await runAllSteps(); await sleep(300);
    await shotEl('.stage', '09-nested-done');

    // ——— H. 跨轮迟到：token 隔离 ———
    await selectScenario('跨轮'); await runSteps(2); await sleep(250);
    const r1 = await evaluate(`window.__preview.round()`);
    await runSteps(1); await sleep(250); // 新 begin → round2
    const r2 = await evaluate(`window.__preview.round()`);
    expect('round-token-increments', r2 !== r1 && r2 != null, {r1, r2});
    const beforeStale = await snap();
    await runSteps(1); await sleep(300); // stale spawn 注入
    const afterStale = await snap();
    expect('stale-event-rejected', JSON.stringify(afterStale.clones) === JSON.stringify(beforeStale.clones)
      && afterStale.round === r2, {before: beforeStale.clones.length, after: afterStale.clones.length});
    // 显式探针：旧 token / 无 token 调用
    const staleProbe = await evaluate(`window.__preview.applyRaw({stage:'routing',message:'probe',plan_ids:[]}, window.__preview.stale())`);
    expect('stale-probe-returns-null', staleProbe === null, {ret: staleProbe});
    const noTokApply = await evaluate(`window.__preview.applyNoToken({stage:'routing',message:'probe',plan_ids:[]})`);
    const noTokSettle = await evaluate(`window.__preview.settleNoToken('answer')`);
    const noTokCancel = await evaluate(`window.__preview.cancelNoToken()`);
    record('no-token-probes', {apply: noTokApply, settle: noTokSettle, cancel: noTokCancel});
    expect('no-token-strictly-rejected',
      [noTokApply, noTokSettle, noTokCancel].every(r => r.threw || r.res === null),
      {apply: noTokApply, settle: noTokSettle, cancel: noTokCancel});
    await scrollLogEnd(); await shotEl('.log-panel', '10-stale-rejected');
    await runAllSteps(); await sleep(300);

    // ——— I. 取消重试：清场 + 实例回收 ———
    await selectScenario('用户取消'); await runSteps(4); await sleep(300); // begin+2spawn+cancel
    expect('cancel-clears-clones', (await stripFaces()) === 0, {faces: await stripFaces()});
    expect('cancel-mainface-idle', (await mainState()) === 'idle', {state: await mainState()});
    expect('cancel-only-main-face-left', await evaluate(`document.querySelectorAll('boop-face').length`) === 1);
    await shotEl('.stage', '11-cancel-reset');
    await runAllSteps(); await sleep(300);

    // ——— J. 断连 ———
    await selectScenario('断连'); await runAllSteps(); await sleep(300);
    expect('disconnect-mainface-confused', (await mainState()) === 'confused', {state: await mainState()});
    await shotEl('.stage', '12-disconnect-confused');

    // ——— K. clarification ———
    await selectScenario('追问'); await runAllSteps(); await sleep(300);
    expect('clarify-mainface-asking', (await mainState()) === 'asking', {state: await mainState()});
    await shotEl('.stage', '13-clarify-asking');

    // ——— K2. 零分身直通 ———
    await selectScenario('零分身'); await runAllSteps(); await sleep(300);
    const sZ = await snap();
    expect('zero-settled-no-clones', sZ.phase === 'done' && sZ.clones.length === 0, {phase: sZ.phase});
    expect('zero-mainface-happy', (await mainState()) === 'happy', {state: await mainState()});
    await shotEl('.stage', '13b-zero-direct');

    // ——— L. 乱序 done ———
    await selectScenario('乱序'); await runAllSteps(); await sleep(300);
    const sOo = await snap();
    expect('ooo-all-settled', sOo.phase === 'done' && sOo.clones.length === 0, {phase: sOo.phase});
    await shotEl('.stage', '14-ooo-done');

    // ——— M. reduced-motion 开关覆盖全部实例 ———
    await evaluate(`document.getElementById('rm-toggle').click()`);
    await selectScenario('3 分身'); await runSteps(4); await sleep(300);
    const rmAttrs = await evaluate(`[...document.querySelectorAll('boop-face')].map(f => f.getAttribute('motion'))`);
    expect('rm-all-instances-reduce', rmAttrs.every(v => v === 'reduce') && rmAttrs.length === 4, {attrs: rmAttrs});
    const sRm = await snap();
    expect('rm-clones-still-spawn', sRm.clones.length === 3, {clones: sRm.clones.length});
    await shotEl('.stage', '15-rm-3clones');
    await evaluate(`document.getElementById('rm-toggle').click()`); // 还原
    await selectScenario('用户取消'); await runSteps(4); await sleep(200);

    // ——— N. 性能（headless 实测值，非真机宣称） ———
    await selectScenario('3 分身'); await runSteps(4); await sleep(500);
    const heap4 = await heap(); const fps4 = await fps(2000);
    await selectScenario('用户取消'); await runSteps(4); await sleep(400);
    const heap1 = await heap(); const fps1 = await fps(2000);
    record('perf-headless', {
      note: 'headless Chromium 测量值（force-device-scale-factor=1），不能冒称真笔记本性能',
      faces4: {fps: fps4, usedJSHeapMB: heap4}, faces1: {fps: fps1, usedJSHeapMB: heap1}});
    // rAF/实例回归：取消后页面只剩主脸
    expect('clear-instance-regression', await evaluate(`document.querySelectorAll('boop-face').length`) === 1);

    // ——— O. 320 CSS px 布局（layout viewport，不混 DPR） ———
    await viewport(320, 700); await sleep(400);
    await selectScenario('3 分身'); await runSteps(4); await sleep(400);
    expect('320-no-horizontal-scroll', await evaluate(`document.scrollingElement.scrollWidth <= 321`),
      {scrollWidth: await evaluate(`document.scrollingElement.scrollWidth`), layoutViewport: await evaluate(`innerWidth`)});
    const titleClip = await evaluate(`[...document.querySelectorAll('#team-strip .mascot-team-title, #team-strip [class*="title"]')].map(e => ({sw: e.scrollWidth, cw: e.clientWidth}))`);
    record('320-title-metrics', titleClip);
    await evaluate('scrollTo(0,0)'); await sleep(150); await shotEl('.stage', '16-320-3clones');
    await evaluate(`document.getElementById('rm-toggle').click()`); await sleep(200);
    await evaluate('scrollTo(0,0)'); await sleep(150); await shotEl('.stage', '17-320-rm');
    await evaluate(`document.getElementById('rm-toggle').click()`);

    // ——— P. 日志诚实性：wire JSON 无 round 键 ———
    await viewport(1180, 860); await sleep(300);
    const logHasRoundKey = await evaluate(`[...document.querySelectorAll('#event-log .wire-json')].some(el => {try {const o = JSON.parse(el.firstChild?.textContent || el.textContent); return o && typeof o === 'object' && 'round' in o;} catch {return false;}})`);
    expect('log-wire-no-round-key', logHasRoundKey === false);
    await scrollLogEnd(); await shotEl('.log-panel', '18-log');

    // ——— Q. destroy() 永闭合（最后执行） ———
    await evaluate(`window.__preview.team.destroy()`);
    await sleep(200);
    expect('destroy-empties-strip', (await stripFaces()) === 0);
    const postDestroy = await evaluate(`(() => {const t = window.__preview.team;
      const r = t.applyEvent({type:'subagent_spawned',subagent_id:'sub-x',plan_id:'A',parent_run_id:'run-root-01',title:'x',task_summary:'x',message:'x'}, t.snapshot().round);
      return {ret: r, faces: document.querySelectorAll('#team-strip boop-face').length};})()`);
    expect('destroy-is-permanent', postDestroy.faces === 0, {ret: postDestroy.ret, faces: postDestroy.faces});
  }
} catch (err) {
  failures.push(`harness:${err.message}`);
  log.push(`harness error: ${err.stack || err}`);
} finally {
  writeFileSync(join(outDir, 'results.json'), JSON.stringify({at: new Date().toISOString(), metrics, failures, log}, null, 2));
  console.log(`asserts: ${Object.keys(metrics).filter(k => metrics[k]?.assert === 'pass').length} pass / ${failures.length} fail`);
  if (failures.length) console.log('FAIL:', failures.join(', '));
  chrome.kill(); server.close();
}

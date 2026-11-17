/**
 * 卡片 facade（I41-C）接线回归：round 严格 token、typed 帧有序缓冲至 team
 * 就绪后一次回放（不重复 fan 地图）、每真实帧 fan WanderCandidates 一次、
 * ready 后 sync 回填真实 snapshot、settle/cancel/reset 双向收敛、地图锚点
 * 事件只切卡片脸显隐、主脸表情仍只由真实 stage/settle 驱动。
 * vm 上下文没有 importModuleDynamically：动态 import 必然失败，boot() 覆盖
 * 全降级路径；bootMounted 以假 createWanderMascot + 真 mascot-team.js 注入。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setup, Element } from './frontend-fixture.ts';

const mascotSource = readFileSync(new URL('../frontend/mascot-card.js', import.meta.url), 'utf8');
const teamSource = readFileSync(new URL('../frontend/mascot-team.js', import.meta.url), 'utf8');
const mascotErrors: unknown[][] = [];
const VALID_STATES = ['idle', 'thinking', 'searching', 'validating', 'happy', 'asking', 'confused'];
const mountableSource = mascotSource
  .replace(`import('./wander-mascot.js')`, 'window.__fakeMascotModule')
  .replace(`import('./mascot-team.js')`, 'window.__fakeTeamModule');

function boot(opts: Parameters<typeof setup>[0] = {}) {
  const h = setup({ api: true, ...opts });
  h.context.console = { ...console, error: (...args: unknown[]) => mascotErrors.push(args) };
  h.run(mascotSource);
  return h;
}
function bootMounted(opts: Parameters<typeof setup>[0] = {}, { teamDelay = false } = {}) {
  const h = setup({ api: true, ...opts });
  h.context.console = { ...console, error: (...args: unknown[]) => mascotErrors.push(args) };
  h.run(teamSource.replace(/^export /gm, '') + ';window.__teamModule={createMascotTeam};');
  h.run(`window.__fakeMascotModule = Promise.resolve({ createWanderMascot: face => {
    face.__states = [];
    return { get state() { return face.__states.at(-1) || 'idle'; },
      setState(next) { if (!${JSON.stringify(VALID_STATES)}.includes(next)) throw new Error('bad state: ' + next); face.__states.push(next); },
      setPalette() {}, setHat() {} };
  } })`);
  h.run(teamDelay
    ? 'window.__fakeTeamModule = new Promise(resolve => window.__resolveTeam = resolve)'
    : 'window.__fakeTeamModule = Promise.resolve(window.__teamModule)');
  h.run(mountableSource);
  h.run("window.__avatarSlot=document.createElement('span');document.querySelector('.glass-card').append(window.__avatarSlot);window.WanderMascot.attach(window.__avatarSlot);");
  return h;
}

type Harness = ReturnType<typeof boot>;
const card = (h: Harness) => h.$('card');
const mascot = (h: Harness) => h.run('window.WanderMascot.state');
const mountedFace = (h: Harness) => h.run('window.__avatarSlot').children.find((c: Element) => c.className.split(' ').includes('message-mascot'));
const sse = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check: () => boolean, message: string) {
  for (let i = 0; i < 100 && !check(); i++) await tick();
  assert.ok(check(), message);
}
const findCls = (root: Element, cls: string): Element[] => {
  const walk = (e: Element): Element[] => [e, ...e.children.flatMap(walk)];
  return walk(root).filter(e => e.className.split(' ').includes(cls));
};
const cloneEls = (h: Harness) => findCls(card(h), 'mascot-team-clone');

const spawn = (id: string, o: Record<string, unknown> = {}) =>
  ({ type: 'subagent_spawned', subagent_id: id, plan_id: null, parent_run_id: 'r0', title: `任务${id}`, task_summary: 's', message: 'm', ...o });
const done = (id: string, status = 'completed', o: Record<string, unknown> = {}) =>
  ({ type: 'subagent_done', subagent_id: id, status, title: `任务${id}`, message: 'm', ...o });
const tool = (sid: string, o: Record<string, unknown> = {}) =>
  ({ type: 'tool_call', tool_call_id: 't1', name: 'estimate_travel', status: 'completed', message: 'm', subagent_id: sid, ...o });
const apply = (h: Harness, evt: object, round: number | string = 'window.__round') =>
  h.run(`window.WanderMascot.applyEvent(${JSON.stringify(evt)},${round})`);

function fakeMap(h: Harness) {
  h.run(`window.__mapCalls = []; window.__lastCtx = null; window.__lastSettle = null;
  window.WanderCandidates = {
    begin(r) { window.__mapCalls.push(['begin', r]); },
    applyEvent(e, r, c) { window.__mapCalls.push(['event', (e && e.type) || 'stage', r]); if (c) window.__lastCtx = c; },
    sync(r, c) { window.__mapCalls.push(['sync', r]); window.__lastCtx = c; },
    settle(res, r) { window.__mapCalls.push(['settle', (res && res.kind) || null, r]); window.__lastSettle = res; },
    cancel(r) { window.__mapCalls.push(['cancel', r]); },
    dispose() {}, snapshot() { return {}; }
  };`);
}
const mapCalls = (h: Harness) => JSON.parse(h.run('JSON.stringify(window.__mapCalls)')) as unknown[][];
function gateTransport(h: Harness) {
  h.run(`window.__reqs = [];
  window.WanderTransport.request = (body, opts) => new Promise((resolve, reject) => {
    window.__reqs.push({ body, opts, resolve, reject });
  });`);
}

test('round 严格：begin 发单调 token、缺 token 抛 TypeError、stale/未来轮全 noop', () => {
  const h = boot(); // 无模块：facade 仍完整可用
  assert.equal(h.run('window.WanderMascot.begin().round'), 1);
  assert.equal(h.run('window.WanderMascot.begin().round'), 2, 'round 单调递增');
  assert.throws(() => h.run('window.WanderMascot.applyEvent({stage:"routing"})'), /round token/);
  assert.throws(() => h.run('window.WanderMascot.settle({kind:"answer"})'), /round token/);
  assert.throws(() => h.run('window.WanderMascot.cancel()'), /round token/);
  assert.equal(h.run('window.WanderMascot.applyEvent({stage:"routing"},1)'), null, '旧轮 noop');
  assert.equal(h.run('window.WanderMascot.applyEvent({stage:"routing"},99)'), null, '未来轮 noop');
  assert.equal(mascot(h), 'thinking', 'stale 帧不动表情');
  assert.equal(h.run('window.WanderMascot.cancel(1)'), null, '旧轮 cancel noop');
  assert.equal(h.run('window.WanderMascot.cancel(2).mainFace'), 'idle');
});

test('sendMessage 全接线：deliver 闭包 round → 事件 → result 收敛到 settle', async () => {
  const h = bootMounted();
  fakeMap(h); gateTransport(h);
  const pending = h.run('window.sendMessage("看展")');
  await until(() => h.run('window.__reqs.length') === 1, '请求已发出');
  assert.deepEqual(mapCalls(h), [['begin', 1]], '第一轮地图 begin(round=1)');
  h.run(`window.__reqs[0].opts.onProgress(${JSON.stringify(spawn('a'))})`);
  await until(() => cloneEls(h).length === 1, '分身经真实事件落位');
  assert.equal(card(h).hidden, false, '有内容时 strip 显示');
  assert.equal(cloneEls(h)[0]!.attrs.get('data-subagent-id'), 'a');
  h.run(`window.__reqs[0].resolve({kind:'answer',session_id:'s1',text:'去碑林。'})`);
  await pending;
  assert.equal(mascot(h), 'happy');
  const calls = mapCalls(h);
  assert.equal(calls[0]![0], 'begin');
  assert.equal(calls.at(-1)![0], 'settle');
  assert.equal(calls.filter(c => c[0] === 'event').length, 1, '每真实帧 fan 地图恰好一次');
  assert.equal(h.run('window.__lastSettle.kind'), 'answer', 'settle 收完整 result');
  assert.equal(cloneEls(h).length, 0, 'settle 后清场');
  assert.equal(card(h).hidden, true, '空 strip 零占位');
});

test('team 就绪前 typed 帧有序缓冲回放：spawn/done 不丢、不重复 fan 地图', async () => {
  const h = bootMounted({}, { teamDelay: true });
  fakeMap(h);
  const r = h.run('window.__round = window.WanderMascot.begin().round');
  apply(h, spawn('a')); apply(h, spawn('b'));
  apply(h, tool('a', { name: 'search_events', result_count: 7 }));
  apply(h, { stage: 'searching_events' });
  apply(h, done('b'));
  assert.equal(mascot(h), 'searching', '缓冲期 stage 仍实时驱动主脸');
  assert.equal(cloneEls(h).length, 0, 'team 未就绪不建分身 DOM');
  h.run('window.__resolveTeam(window.__teamModule)');
  await until(() => cloneEls(h).length === 1, 'team 就绪后有序回放');
  assert.equal(cloneEls(h)[0]!.attrs.get('data-subagent-id'), 'a', 'a 存活补位');
  assert.equal(findCls(card(h), 'mascot-team-note')[0]?.textContent, '已检索 7', '真实 result_count 回放');
  assert.equal(mapCalls(h).filter(c => c[0] === 'event').length, 5, '缓冲帧 fan 地图仅一次');
  assert.equal(mapCalls(h).some(c => c[0] === 'sync' && c[1] === r), true, 'ready 后 sync 回填');
  assert.equal(h.run('window.__lastCtx.clones.length'), 1);
  assert.equal(h.run('window.__lastCtx.clones[0].id'), 'a');
  assert.equal(h.run('window.__lastCtx.clones[0].palette'), 'sand', 'ctx 用真实 snapshot 帽色');
});

test('settle 先于 team 就绪：加载完成不复活旧分身，终态正常呈现', async () => {
  const h = bootMounted({}, { teamDelay: true });
  fakeMap(h);
  const r = h.run('window.WanderMascot.begin().round');
  apply(h, spawn('a'), r);
  h.run(`window.WanderMascot.settle(${JSON.stringify({ kind: 'answer', text: 't' })},${r})`);
  assert.equal(mascot(h), 'happy');
  h.run('window.__resolveTeam(window.__teamModule)');
  for (let i = 0; i < 15; i++) await tick();
  assert.equal(cloneEls(h).length, 0, '已 settle 轮不建分身');
  assert.equal(card(h).hidden, true);
  assert.equal(mapCalls(h).some(c => c[0] === 'sync'), false, '已终结轮不 sync');
  assert.equal(h.run('window.WanderMascot.begin().round'), r + 1, '后续轮 begin 正常');
  apply(h, spawn('z'), r + 1);
  await until(() => cloneEls(h).length === 1, '新轮 team 正常 begin');
});

test('cancel→idle 与 error→confused 区分；wander:reset 收敛两侧', async () => {
  const h = bootMounted();
  fakeMap(h);
  await until(() => Boolean(mountedFace(h)), '模块就绪');
  const r = h.run('window.WanderMascot.begin().round');
  apply(h, spawn('a'), r);
  h.run('window.dispatchEvent(new Event("wander:reset"))');
  assert.equal(mascot(h), 'idle', 'reset 走取消路径呈 idle');
  assert.equal(cloneEls(h).length, 0);
  assert.deepEqual(mapCalls(h).at(-1), ['cancel', r]);
  const r2 = h.run('window.WanderMascot.begin().round');
  apply(h, spawn('b'), r2);
  h.run('window.WanderMascot.settle({kind:"error"},' + r2 + ')');
  assert.equal(mascot(h), 'confused', 'error 终态呈困惑');
  assert.deepEqual(mapCalls(h).at(-1), ['settle', 'error', r2]);
});

test('地图锚点事件只切卡片脸显隐：当前 round 生效、保留徽标/title', async () => {
  const h = bootMounted();
  await until(() => Boolean(mountedFace(h)), '模块就绪');
  const r = h.run('window.WanderMascot.begin().round');
  apply(h, spawn('a'), r);
  const el = () => cloneEls(h)[0]!;
  assert.equal(el().attrs.get('data-subagent-id'), 'a');
  assert.equal(el().attrs.get('data-anchored'), 'false');
  const fire = (detail: string) => h.run(`window.dispatchEvent(Object.assign(new Event('wander:candidate-anchor'), { detail: ${detail} }));`);
  fire(JSON.stringify({ round: r, subagent_id: 'a', anchored: true }));
  assert.equal(el().attrs.get('data-anchored'), 'true', '已落位：卡片脸隐藏（CSS 层）');
  assert.ok(findCls(el(), 'mascot-team-badge').length && findCls(el(), 'mascot-team-title').length, '徽标/title 保留');
  fire(JSON.stringify({ round: r + 99, subagent_id: 'a', anchored: false }));
  assert.equal(el().attrs.get('data-anchored'), 'true', 'stale round 锚点事件忽略');
  fire(JSON.stringify({ round: r, subagent_id: 'ghost', anchored: true }));
  fire(JSON.stringify({ round: r, subagent_id: 'a', anchored: false }));
  assert.equal(el().attrs.get('data-anchored'), 'false', '离屏/取消恢复卡片脸');
});

test('真实 SSE 阶段驱动表情序列；未知帧保持当前表情', async () => {
  const h = boot();
  h.run(`window.__seen = [];
    const drive = window.WanderMascot.applyEvent.bind(window.WanderMascot);
    window.WanderMascot.applyEvent = (e, r) => { const out = drive(e, r); window.__seen.push(window.WanderMascot.state); return out; };`);
  h.context.fetch = async () => sse(
    'event: meta\ndata: {"session_id":"s1"}\n\n' +
    'event: progress\ndata: {"stage":"searching_events"}\n\n' +
    'event: progress\ndata: {"stage":"exploring_plans"}\n\n' +
    'event: progress\ndata: {"stage":"routing"}\n\n' +
    'event: progress\ndata: {"stage":"validating_schedule"}\n\n' +
    'event: progress\ndata: {"stage":"future_probe","type":"unknown"}\n\n' +
    'event: result\ndata: {"kind":"answer","session_id":"s1","text":"去碑林博物馆。"}\n\n');
  const pending = h.run('window.sendMessage("明天想去看看展")');
  assert.equal(mascot(h), 'thinking', '请求开始立即 thinking');
  await pending;
  assert.equal(h.run('JSON.stringify(window.__seen)'), JSON.stringify(['searching', 'thinking', 'thinking', 'validating', 'validating']),
    '未知 future_probe 帧不得重置 validating');
  assert.equal(mascot(h), 'happy', '有效 answer 收尾转开心');
});

test('clarification 转询问；真实失败转困惑；重试回思考；新聊天复位待机', async () => {
  const h = boot();
  h.context.fetch = async () => sse('event: result\ndata: {"kind":"clarification","session_id":"s1","question":"住钟楼还是大雁塔附近？"}\n\n');
  await h.run('window.sendMessage("帮我安排住宿")');
  assert.equal(mascot(h), 'asking');

  h.context.fetch = async () => sse('event: error\ndata: {"error":{"message":"本次未能生成可用方案","retryable":true}}\n\n');
  await h.run('window.sendMessage("再帮我看看")');
  assert.equal(mascot(h), 'confused', '真实失败转困惑');

  h.context.fetch = async () => sse('event: result\ndata: {"kind":"answer","session_id":"s1","text":"这次可以了"}\n\n');
  const retry = findCls(h.$('messages'), 'retry-button')[0]!;
  retry.click();
  assert.equal(mascot(h), 'thinking', '重试重新进入 thinking');
  await until(() => mascot(h) === 'happy', '重试成功应转开心');

  h.$('new-chat').click(); // → clearConversation → wander:reset → cancel(round)
  assert.equal(mascot(h), 'idle', '新聊天复位待机');
  assert.equal(h.state.messages.length, 0);
});

test('代际隔离：旧请求的迟到结果、进度与旧 round token 均不得写回', async () => {
  const h = boot();
  const stale = h.run('window.sendMessage("看展")');
  assert.equal(mascot(h), 'thinking');
  h.$('new-chat').click();
  assert.equal(mascot(h), 'idle');
  h.requests[0]!.finish({ kind: 'answer', session_id: 's_old', text: '迟到的旧回复' });
  await stale;
  assert.equal(mascot(h), 'idle', '旧代结果不得覆盖新会话待机');
  assert.equal(h.run('state.sessionId'), null, '旧代 session_id 不得复活');
  assert.equal(h.run('window.WanderMascot.applyEvent({stage:"routing"},1)'), null, '旧 round token 已失效');

  const fresh = h.run('window.sendMessage("换个地方")');
  assert.equal(mascot(h), 'thinking');
  h.requests[1]!.finish({ kind: 'answer', session_id: 's_new', text: '新回复' });
  await fresh;
  assert.equal(mascot(h), 'happy');
  assert.equal(h.run('state.sessionId'), 's_new');
});

test('历史切换复位待机后恢复对话保持小尺寸语义', async () => {
  const h = boot({ entries: [{ id: 'past1', createdAt: 1, updatedAt: 2, title: '旧规划',
    messages: [{ role: 'user', text: '旧问题' }, { role: 'assistant', text: '旧答复' }], sessionId: 's_past' }] as never });
  const pending = h.run('window.sendMessage("看展")');
  h.$('history-list').children[0]!.click();
  h.requests[0]!.finish({ kind: 'answer', session_id: 's_stale', text: '迟到的回复' });
  await pending;
  assert.equal(mascot(h), 'idle', '历史切换复位待机且旧请求被丢弃');
  assert.ok(h.state.messages.length >= 2, '旧会话消息已恢复');
});

test('挂载成功前后：继承键/非法值不驱动状态、不写非法 pending、不移除形象', async () => {
  const h = bootMounted();
  const errorsBefore = mascotErrors.length;
  const r = h.run('window.WanderMascot.begin().round');
  assert.equal(mascot(h), 'thinking');
  for (const key of ['toString', '__proto__', 'constructor']) apply(h, { stage: key }, r);
  h.run(`window.WanderMascot.applyEvent({stage:'hasOwnProperty'},${r})`);
  assert.equal(mascot(h), 'thinking', '继承键与未知 stage 不得写表情');
  await until(() => Boolean(mountedFace(h)), '等待挂载完成');
  const face = mountedFace(h)!;
  assert.deepEqual([...(face as never as { __states: string[] }).__states], ['thinking'],
    '只有合法 pending 回放到形象');
  apply(h, { stage: 'searching_events' }, r);
  assert.deepEqual([...(face as never as { __states: string[] }).__states], ['thinking', 'searching']);
  h.run(`window.WanderMascot.settle({kind:'weird_kind'},${r})`);
  assert.equal(mascot(h), 'confused', '未知 settle kind 归一为 error 终态');
  assert.ok(mountedFace(h), '形象不得因非法值被移除');
  assert.equal(mascotErrors.length, errorsBefore, '非法输入不得触发降级日志');
});

test('挂载成功：begin/进度在 import 未就绪前进入 pending，挂载后回放一次', async () => {
  const h = bootMounted();
  const r = h.run('window.WanderMascot.begin().round');
  apply(h, { stage: 'validating_schedule' }, r);
  await until(() => (mountedFace(h) as never as { __states?: string[] })?.__states?.length === 1, '等待挂载与回放');
  assert.deepEqual([...(mountedFace(h) as never as { __states: string[] }).__states], ['validating'],
    '挂载前合法 pending 应回放一次');
  assert.equal(mascot(h), 'validating');
});

test('形象挂载失败降级：对话与文字进度照常，facade 与地图 fanout 仍可驱动', async () => {
  const h = boot();
  await tick();
  assert.equal(mascotErrors.length > 0, true, '挂载失败应记录错误');
  fakeMap(h);
  h.context.fetch = async () => sse(
    'event: progress\ndata: {"stage":"searching_events"}\n\n' +
    'event: result\ndata: {"kind":"answer","session_id":"s1","text":"去碑林。"}\n\n');
  await h.run('window.sendMessage("明天去哪")');
  assert.equal(mascot(h), 'happy');
  assert.equal(h.state.messages.at(-1)!.text, '去碑林。', '无形象时文字回复照常');
  assert.deepEqual(mapCalls(h).map(c => c[0]), ['begin', 'event', 'settle'], '降级时地图 fanout 照常');
});

test('缓冲有界：非关键帧按需淘汰，spawn 生命周期帧回放保留', async () => {
  const h = bootMounted({}, { teamDelay: true });
  const r = h.run('window.WanderMascot.begin().round');
  apply(h, spawn('a'), r);
  for (let i = 0; i < 500; i++) apply(h, tool('a', { name: 'estimate_travel' }), r);
  apply(h, { stage: 'routing' }, r);
  assert.equal(mascot(h), 'thinking', '海量缓冲后主脸仍正常');
  h.run('window.__resolveTeam(window.__teamModule)');
  await until(() => cloneEls(h).length === 1, 'spawn 不被非关键淘汰');
  h.run(`window.WanderMascot.settle(${JSON.stringify({ kind: 'answer' })},${r})`);
  assert.equal(mascot(h), 'happy');
});

test('I41-R1：>400 全生命周期帧溢出→本轮 team 展示禁用，不回放残缺历史', async () => {
  const h = bootMounted({}, { teamDelay: true });
  fakeMap(h);
  const r = h.run('window.WanderMascot.begin().round');
  for (let i = 0; i < 199; i++) { apply(h, spawn(`s${i}`), r); apply(h, done(`s${i}`), r); }
  apply(h, spawn('a'), r); apply(h, spawn('b'), r);           // 恰好打满 400 全生命周期帧
  apply(h, done('a'), r); apply(h, done('b'), r);            // 402 帧：无安全淘汰位 → 降级
  assert.equal(mascot(h), 'thinking');
  h.run('window.__resolveTeam(window.__teamModule)');
  for (let i = 0; i < 15; i++) await tick();
  assert.equal(cloneEls(h).length, 0, '残缺回放不得伪造 working 分身');
  assert.equal(card(h).hidden, true, '降级轮 strip 不出现');
  assert.equal(mapCalls(h).filter(c => c[0] === 'event').length, 402, '真实帧仍恰一次 fan 地图');
  assert.equal(mapCalls(h).some(c => c[0] === 'sync'), false, '降级轮不 sync');
  h.run(`window.WanderMascot.settle(${JSON.stringify({ kind: 'answer' })},${r})`);
  assert.equal(mascot(h), 'happy', '主脸终态照常');
  const r2 = h.run('window.WanderMascot.begin().round');
  apply(h, spawn('z'), r2);
  await until(() => cloneEls(h).length === 1, '下一轮 team 展示恢复');
});

test('message avatars: only the newest slot mounts after a delayed import', async () => {
  const h = bootMounted();
  const old = h.run('window.__avatarSlot');
  h.run(`window.__newSlot=document.createElement('span');window.WanderMascot.attach(window.__newSlot);`);
  await until(() => h.run('window.__newSlot.children.some(c=>c.className==="message-mascot")'), 'latest slot mounts');
  assert.equal(old.children.some((c: Element) => c.className === 'message-mascot'), false);
  h.run('window.WanderMascot.freezeAll()');
  assert.equal(h.run('window.__newSlot.children.some(c=>c.className==="message-mascot")'), false);
});

test('message avatars: historical replay before import stays entirely static', async () => {
  const h = bootMounted();
  h.run('window.WanderMascot.freezeAll()');
  await tick(); await tick();
  assert.equal(mountedFace(h), undefined, 'late module must not revive frozen history');
});

test('message avatars: reset before import cannot revive an old conversation', async () => {
  const h = bootMounted();
  h.run('window.dispatchEvent(new Event("wander:reset"))');
  await tick(); await tick();
  assert.equal(mountedFace(h), undefined);
  h.run('window.WanderMascot.attach(window.__avatarSlot)');
  assert.ok(mountedFace(h), 'a new assistant message can mount normally');
});

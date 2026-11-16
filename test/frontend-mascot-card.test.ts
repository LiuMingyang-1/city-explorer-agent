/**
 * 卡片主形象（M1）生命周期回归：表情只跟随真实请求信号。
 * - 请求开始 thinking；searching_events→searching、exploring_plans/routing→thinking、
 *   validating_schedule→validating；answer/plans→happy、clarification→asking、真实失败→confused。
 * - 未知 progress 阶段不得重置当前表情（面向未来新协议帧的前向兼容）。
 * - 代际隔离：新聊天/历史切换后，旧请求的迟到结果与进度不得写回表情。
 * - 降级：形象模块加载失败时 WanderMascot 仍是安全门面，对话与文字进度照常。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setup, Element } from './frontend-fixture.ts';

const mascotSource = readFileSync(new URL('../frontend/mascot-card.js', import.meta.url), 'utf8');
const mascotErrors: unknown[][] = [];

// vm 上下文没有 importModuleDynamically：动态 import 必然失败，刚好覆盖降级路径。
// console.error 被收集，用于断言降级真实发生而不是静默通过。
function boot(opts: Parameters<typeof setup>[0] = {}) {
  const h = setup({ api: true, ...opts });
  h.context.console = { ...console, error: (...args: unknown[]) => mascotErrors.push(args) };
  h.run(mascotSource);
  return h;
}

const VALID_STATES = ['idle', 'thinking', 'searching', 'validating', 'happy', 'asking', 'confused'];
// 成功挂载路径：把 import('./wander-mascot.js') 替换为测试注入的假模块，
// 其余挂载逻辑（元素创建、append、控制器绑定、pending 回放、catch 移除）原样运行。
const mountableSource = mascotSource.replace(`import('./wander-mascot.js')`, 'window.__fakeMascotModule');
function bootMounted(opts: Parameters<typeof setup>[0] = {}) {
  const h = setup({ api: true, ...opts });
  h.context.console = { ...console, error: (...args: unknown[]) => mascotErrors.push(args) };
  h.run(`window.__fakeMascotModule = Promise.resolve({ createWanderMascot: face => {
    face.__states = [];
    return { get state() { return face.__states.at(-1) || 'idle'; },
      setState(next) { if (!${JSON.stringify(VALID_STATES)}.includes(next)) throw new Error('bad state: ' + next); face.__states.push(next); },
      setPalette() {}, setHat() {} };
  } })`);
  h.run(mountableSource);
  return h;
}
const mountedFace = (h: ReturnType<typeof boot>) =>
  h.$('card').children.find(c => String(c.className).split(' ').includes('card-mascot'));
const mascot = (h: ReturnType<typeof boot>) => h.run('window.WanderMascot.state');
const sse = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check: () => boolean, message: string) {
  for (let i = 0; i < 100 && !check(); i++) await tick();
  assert.ok(check(), message);
}
function find(root: Element, cls: string): Element[] {
  const walk = (e: Element): Element[] => [e, ...e.children.flatMap(walk)];
  return walk(root).filter(e => e.className.split(' ').includes(cls));
}

test('真实 SSE 阶段驱动表情序列；未知阶段保持当前表情', async () => {
  const h = boot();
  h.run(`window.__seen = [];
    const drive = window.WanderMascot.progress.bind(window.WanderMascot);
    window.WanderMascot.progress = stage => { drive(stage); window.__seen.push(window.WanderMascot.state); };`);
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
  const retry = find(h.$('messages'), 'retry-button')[0]!;
  retry.click();
  assert.equal(mascot(h), 'thinking', '重试重新进入 thinking');
  await until(() => mascot(h) === 'happy', '重试成功应转开心');

  h.$('new-chat').click();
  assert.equal(mascot(h), 'idle', '新聊天复位待机');
  assert.equal(h.state.messages.length, 0);
});

test('代际隔离：旧请求的迟到结果、进度与错误不得写回新会话表情', async () => {
  const h = boot();
  const stale = h.run('window.sendMessage("看展")');
  assert.equal(mascot(h), 'thinking');
  h.$('new-chat').click();
  assert.equal(mascot(h), 'idle');
  // 旧请求晚到一个完整的 happy 流，表情必须留在 idle。
  h.requests[0]!.finish({ kind: 'answer', session_id: 's_old', text: '迟到的旧回复' });
  await stale;
  assert.equal(mascot(h), 'idle', '旧代结果不得覆盖新会话待机');
  assert.equal(h.run('state.sessionId'), null, '旧代 session_id 不得复活');

  // 新代请求进行中，旧代残余仍不能写；新代自己推进。
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
  h.$('history-list').children[0]!.click(); // 打开旧历史 → clearConversation → reset
  h.requests[0]!.finish({ kind: 'answer', session_id: 's_stale', text: '迟到的回复' });
  await pending;
  assert.equal(mascot(h), 'idle', '历史切换复位待机且旧请求被丢弃');
  assert.ok(h.state.messages.length >= 2, '旧会话消息已恢复');
});

test('挂载成功前后：toString/__proto__/constructor 等继承键不驱动状态、不移除形象', async () => {
  const h = bootMounted();
  const errorsBefore = mascotErrors.length;
  // 挂载完成前（动态 import 仍在途）注入继承键与非法值：不得进入 pending，
  // 否则回放到真 controller 会抛错并把刚挂载的形象移除。
  h.run(`window.WanderMascot.progress('toString');window.WanderMascot.progress('__proto__');
    window.WanderMascot.progress('constructor');window.WanderMascot.finish('hasOwnProperty');
    window.WanderMascot.finish('__proto__');window.WanderMascot.progress('future_probe');`);
  assert.equal(mascot(h), 'idle', '继承键与未知值不得写入 pending');
  await until(() => Boolean(mountedFace(h)), '等待挂载完成');
  const face = mountedFace(h)!;
  assert.equal((face as never as { __states: string[] }).__states.length, 0, '非法 pending 不应回放到形象');
  // 挂载成功后合法驱动，再注入同样值：保持既有状态且不移除元素。
  h.run(`window.WanderMascot.progress('searching_events')`);
  assert.deepEqual([...(face as never as { __states: string[] }).__states], ['searching']);
  h.run(`window.WanderMascot.progress('toString');window.WanderMascot.progress('__proto__');
    window.WanderMascot.progress('constructor');window.WanderMascot.finish('toString');
    window.WanderMascot.finish('valueOf');window.WanderMascot.finish('weird_kind');`);
  assert.equal(mascot(h), 'searching', '挂载后未知/继承值保持既有状态');
  assert.deepEqual([...(face as never as { __states: string[] }).__states], ['searching'],
    '非法值不得转发到 controller');
  assert.ok(mountedFace(h), '形象不得因非法值被移除');
  assert.equal(mascotErrors.length, errorsBefore, '非法输入不得触发降级日志');
});

test('挂载成功：pending 合法状态在挂载后回放', async () => {
  const h = bootMounted();
  h.run(`window.WanderMascot.progress('validating_schedule')`); // import 未就绪前进入 pending
  await until(() => (mountedFace(h) as never as { __states?: string[] })?.__states?.length === 1, '等待挂载与回放');
  assert.deepEqual([...(mountedFace(h) as never as { __states: string[] }).__states], ['validating'],
    '挂载前合法 pending 应回放一次');
  assert.equal(mascot(h), 'validating');
});

test('形象挂载失败降级：对话与文字进度照常，门面仍可驱动', async () => {
  const h = boot();
  await tick(); // 让动态 import 拒绝与 catch 落定
  assert.equal(mascotErrors.length > 0, true, '挂载失败应记录一次错误');
  h.context.fetch = async () => sse(
    'event: progress\ndata: {"stage":"searching_events"}\n\n' +
    'event: result\ndata: {"kind":"answer","session_id":"s1","text":"去碑林。"}\n\n');
  await h.run('window.sendMessage("明天去哪")');
  assert.equal(mascot(h), 'happy');
  assert.equal(h.state.messages.at(-1)!.text, '去碑林。', '无形象时文字回复照常');
});

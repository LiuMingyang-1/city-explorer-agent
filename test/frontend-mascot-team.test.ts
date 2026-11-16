/**
 * I40-F2 编排层 frontend/mascot-team.js 单测。
 * vm 上下文 + 轻量 fake DOM（frontend-fixture Element）+ 手动触发的假定时器，无新依赖。
 * 断言直接驱动真实模块：round token 严格性、0/1/2/3/5 分身与 +N 溢出补位、
 * 父 stage 绝不回收 pending、tool_call 结束事件语义、未知盖章→孤儿聚合转正、
 * 嵌套异源 parent_run_id、done-before-spawn 墓碑与幂等、settle/cancel 轮次终结、
 * 旧 round 迟到帧隔离、destroy 永闭合、label 注入安全、非法 stage 继承键拒绝、
 * reduced-motion 即时静态与 ≤400ms 装饰退场。
 * 注意：vm 产物的原型与 Node 侧不同，对象一律按字段断言或经 JSON 归一。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { Element } from './frontend-fixture.ts';

const source = readFileSync(new URL('../frontend/mascot-team.js', import.meta.url), 'utf8');

interface Team {
  begin(): { round: number; mainFace: string } | null;
  applyEvent(evt: unknown, round?: number): { mainFace?: string } | null;
  settle(kind: string, round?: number): { mainFace?: string } | null;
  cancel(round?: number): { mainFace?: string } | null;
  setAnchored(id: string, anchored: boolean, round?: number): { anchored: boolean } | null;
  destroy(): void;
  snapshot(): {
    round: number | null; phase: string; beat: string | null;
    clones: { id: string; title: string; letter: string; palette: string; status: string; activity: string; anchored: boolean }[];
    overflow: number; nested: number; active: number; pending: number; finished: number; destroyed: boolean;
  };
}
function boot({ reduced = true, badMascot = false } = {}) {
  const timers: { cb: () => void; cancelled: boolean }[] = [];
  const context = vm.createContext({
    document: { createElement: () => new Element() },
    matchMedia: () => ({ matches: reduced }),
    setTimeout: (cb: () => void) => { const t = { cb, cancelled: false }; timers.push(t); return t; },
    clearTimeout: (t: { cancelled: boolean }) => { t.cancelled = true; },
  });
  vm.runInContext(source.replace(/^export /gm, '') + '\nglobalThis.createMascotTeam = createMascotTeam;', context);
  const calls: { palette: string; pointerFollow: boolean; states: string[] }[] = [];
  const container = new Element();
  const team = (vm.runInContext('createMascotTeam', context) as (c: Element, o: object) => Team)(container, {
    createMascot: (_face: Element, o: { palette: string; pointerFollow: boolean }) => {
      const rec = { palette: o.palette, pointerFollow: o.pointerFollow, states: [] as string[] };
      calls.push(rec);
      if (badMascot) return { setState() { throw new Error('broken face'); }, setPalette() {}, setHat() {} };
      return { setState(s: string) { rec.states.push(s); }, setPalette() {}, setHat() {} };
    },
    reduced: () => reduced,
  });
  // 同步跑出全部在途装饰拍（enter/exit/pulse 定时器）
  const flush = () => {
    for (let guard = 0; timers.length && guard < 50; guard++)
      for (const t of timers.splice(0)) if (!t.cancelled) t.cb();
  };
  return { team, container, calls, flush, timers };
}

const spawn = (id: string, o: Record<string, unknown> = {}) =>
  ({ type: 'subagent_spawned', subagent_id: id, plan_id: null, parent_run_id: 'r0', title: `任务${id}`, task_summary: 's', message: 'm', ...o });
const done = (id: string, status = 'completed', o: Record<string, unknown> = {}) =>
  ({ type: 'subagent_done', subagent_id: id, status, title: `任务${id}`, message: 'm', ...o });
const tool = (sid: string | null, o: Record<string, unknown> = {}) =>
  ({ type: 'tool_call', tool_call_id: 't1', name: 'estimate_travel', status: 'completed', message: 'm', ...(sid ? { subagent_id: sid } : {}), ...o });
const findCls = (root: Element, cls: string): Element[] => {
  const walk = (e: Element): Element[] => [e, ...e.children.flatMap(walk)];
  return walk(root).filter(e => e.className.split(' ').includes(cls));
};
const clones = (c: Element) => findCls(c, 'mascot-team-clone');

test('begin 发放 round、主脸建议 thinking；缺 token 抛错、错 token 全 noop', () => {
  const { team, container } = boot();
  assert.equal(team.snapshot().phase, 'idle');
  assert.equal(team.snapshot().round, null);
  assert.throws(() => team.applyEvent({ stage: 'routing' }), /round token/);
  assert.throws(() => team.settle('plans'), /round token/);
  assert.throws(() => team.cancel(), /round token/);
  assert.equal(team.applyEvent({ stage: 'routing' }, 7), null, '无当前轮时任何 token 均 stale');
  const first = team.begin()!;
  assert.equal(first.round, 1);
  assert.equal(first.mainFace, 'thinking');
  assert.equal(team.snapshot().phase, 'thinking');
  assert.equal(container.classList.contains('mascot-team'), true, '容器挂稳定类名');
  assert.equal(team.applyEvent(spawn('s1'), 99), null, '错 token 零副作用');
  assert.equal(team.snapshot().pending, 0);
  assert.equal(team.applyEvent(spawn('s1'), first.round) !== null, true, '本轮 token 受理');
  assert.equal(team.snapshot().pending, 1);
});

test('0/1/2/3/5：可见槽位封顶 3、+N 溢出真实计数、done 释放槽位按序补位且帽色稳定', () => {
  const zero = boot();
  const r0 = zero.team.begin()!.round;
  zero.team.applyEvent({ stage: 'searching_events' }, r0);
  assert.equal(zero.team.snapshot().pending, 0);
  assert.equal(clones(zero.container).length, 0, '无 delegate 零分身合法');

  const { team, container, calls, flush } = boot();
  const { round } = team.begin()!;
  team.applyEvent(spawn('x'), round);
  assert.equal(team.snapshot().active, 1);
  team.applyEvent(spawn('y'), round);
  assert.equal(team.snapshot().active, 2);
  for (const id of ['a', 'b', 'c']) team.applyEvent(spawn(id), round);
  let snap = team.snapshot();
  assert.equal(snap.active, 3);
  assert.equal(snap.pending, 5);
  assert.equal(snap.overflow, 2);
  assert.equal(clones(container).length, 3);
  assert.equal(findCls(container, 'mascot-team-overflow')[0]?.textContent, '+2');
  assert.equal(calls.every(c => c.pointerFollow === false), true);
  // 等待池中的分身收到自身 done：真实计数下降，自始至终不建 DOM 不建 controller
  team.applyEvent(done('b', 'cancelled'), round);
  assert.equal(team.snapshot().overflow, 1);
  assert.equal(clones(container).length, 3);
  assert.equal(calls.length, 3, '等待池分身不实例化形象');
  // 可见分身完成 → 槽位释放 → 等待池按 spawn 序补位到该槽位
  team.applyEvent(done('x', 'completed'), round);
  snap = team.snapshot();
  assert.equal(snap.pending, 3);
  assert.equal(JSON.stringify(snap.clones.map(c => c.id)), '["c","y","a"]', '补位分身 c 进 slot 0');
  assert.equal(snap.clones[0]!.palette, 'sand', '补位分身复用释放槽位的帽色');
  assert.equal(snap.overflow, 0);
  assert.equal(findCls(container, 'mascot-team-overflow').length, 0, '等待池清空后 +N 徽标移除');
  team.applyEvent(done('y'), round);
  team.applyEvent(done('a'), round);
  team.applyEvent(done('c'), round);
  snap = team.snapshot();
  assert.equal(snap.beat, 'merging', '存活归零为 merging 节拍');
  assert.equal(snap.phase, 'thinking');
  assert.equal(snap.pending, 0);
  flush();
  assert.equal(clones(container).length, 0);
});

test('槽位帽色按位置轮换稳定：sand/clay/moss', () => {
  const { team, calls } = boot();
  const { round } = team.begin()!;
  team.applyEvent(spawn('a'), round);
  team.applyEvent(spawn('b'), round);
  team.applyEvent(spawn('c'), round);
  assert.equal(JSON.stringify(calls.map(c => c.palette)), '["sand","clay","moss"]');
  team.applyEvent(done('a'), round);
  team.applyEvent(spawn('d'), round);
  assert.equal(calls.at(-1)!.palette, 'sand', '补位分身拿槽位 0 的 sand');
});

test('父 stage 绝不回收 pending：exploring_plans 重复、routing、validating 后分身仍存活', () => {
  const { team } = boot();
  const { round } = team.begin()!;
  team.applyEvent(spawn('a'), round);
  team.applyEvent(spawn('b'), round);
  assert.equal(team.applyEvent({ stage: 'exploring_plans' }, round)?.mainFace, 'thinking');
  assert.equal(team.applyEvent({ stage: 'exploring_plans' }, round)?.mainFace, 'thinking', '同 stage 可重复');
  assert.equal(team.applyEvent({ stage: 'routing' }, round)?.mainFace, 'thinking');
  assert.equal(team.applyEvent({ stage: 'validating_schedule' }, round)?.mainFace, 'validating');
  let snap = team.snapshot();
  assert.equal(snap.phase, 'validating', '父相位可为 validating');
  assert.equal(snap.pending, 2, 'stage 无权回收 pending 分身');
  assert.equal(snap.clones.length, 2);
  assert.equal(snap.beat, 'dispatching', '不得伪造 merging');
  team.applyEvent(done('a'), round);                     // validating 期间同 id done 才清理
  snap = team.snapshot();
  assert.equal(snap.pending, 1);
  assert.equal(snap.phase, 'validating', '仍有 pending 时 validating 驻留');
});

test('tool_call 是结束事件：盖章 search_events 给徽标脉冲+真实 result_count，不举镜不降级', () => {
  const { team, container, flush } = boot({ reduced: false });
  const { round } = team.begin()!;
  team.applyEvent(spawn('a'), round);
  flush();
  const el = () => clones(container)[0]!;
  team.applyEvent(tool('a', { name: 'search_events', result_count: 7 }), round);
  assert.equal(el().attrs.get('data-activity'), 'searched');
  assert.equal(findCls(el(), 'mascot-team-note')[0]?.textContent, '已检索 7');
  assert.equal(el().attrs.get('data-status'), 'working', '结束事件不切 searching 姿态');
  team.applyEvent(tool('a', { name: 'estimate_travel' }), round);
  assert.equal(el().attrs.get('data-activity'), 'tool', '多工具活动不降级');
  team.applyEvent(tool('a', { status: 'error' }), round);
  assert.equal(el().attrs.get('data-activity'), 'error');
  assert.equal(findCls(el(), 'mascot-team-note')[0]?.textContent, '调用出错');
  assert.equal(team.snapshot().pending, 1, '单工具错误不清分身');
  const parent = team.applyEvent(tool(null), round);
  assert.equal(parent !== null && parent.mainFace === undefined, true, '无盖章 tool_call 是父侧事件');
});

test('未知盖章 tool_call 计孤儿聚合不建分身，其 spawned 到达后转正为顶层且徽标同步移除', () => {
  const { team, container } = boot();
  const { round } = team.begin()!;
  team.applyEvent(spawn('a'), round);
  team.applyEvent(tool('ghost'), round);
  assert.equal(team.snapshot().nested, 1);
  assert.equal(clones(container).length, 1, '未知 id 不得建分身');
  assert.equal(findCls(container, 'mascot-team-nested')[0]?.textContent, '⧉1');
  team.applyEvent(spawn('ghost'), round);
  const snap = team.snapshot();
  assert.equal(snap.nested, 0);
  assert.equal(findCls(container, 'mascot-team-nested').length, 0, '转正后 DOM 聚合徽标必须消失');
  assert.equal(snap.pending, 2);
  assert.equal(clones(container).length, 2, '孤儿 spawn 同源转正为顶层分身');
});

test('orphan 与 nested 并存不重复计数：转正后真嵌套仍按真实 id 保留', () => {
  const { team, container } = boot();
  const { round } = team.begin()!;
  team.applyEvent(spawn('a', { parent_run_id: 'r0' }), round);
  team.applyEvent(tool('g'), round);                              // orphan
  team.applyEvent(spawn('n', { parent_run_id: 'child1' }), round); // 真嵌套
  assert.equal(team.snapshot().nested, 2, 'orphan+nested 分别计数');
  assert.equal(findCls(container, 'mascot-team-nested')[0]?.textContent, '⧉2');
  team.applyEvent(spawn('g'), round);                             // orphan 转正
  assert.equal(team.snapshot().nested, 1, '仅剩真嵌套');
  assert.equal(findCls(container, 'mascot-team-nested')[0]?.textContent, '⧉1');
  assert.equal(team.snapshot().pending, 2);
  team.applyEvent(done('n'), round);
  assert.equal(team.snapshot().nested, 0);
  assert.equal(findCls(container, 'mascot-team-nested').length, 0);
});

test('嵌套：异源 parent_run_id 计聚合、不建顶层分身、不覆盖根 run', () => {
  const { team, container } = boot();
  const { round } = team.begin()!;
  team.applyEvent(spawn('a', { parent_run_id: 'r0' }), round);   // 首个 spawned 的 parent_run_id 为根
  team.applyEvent(spawn('n1', { parent_run_id: 'childrun1' }), round);
  let snap = team.snapshot();
  assert.equal(snap.nested, 1);
  assert.equal(snap.pending, 1);
  assert.equal(snap.active, 1);
  team.applyEvent(spawn('b'), round);                           // 同源仍顶层
  assert.equal(team.snapshot().pending, 2);
  team.applyEvent(tool('n1'), round);                           // 嵌套活动：聚合计数不变不重复
  assert.equal(team.snapshot().nested, 1);
  team.applyEvent(done('n1'), round);                           // 嵌套 done：计数下降、墓碑记录
  snap = team.snapshot();
  assert.equal(snap.nested, 0);
  assert.equal(snap.finished, 1);
  assert.equal(snap.pending, 2);
  assert.equal(clones(container).length, 2);
});

test('done-before-spawn 记墓碑、迟到 spawn 不复活；重复 spawn/done 幂等', () => {
  const { team, container } = boot();
  const { round } = team.begin()!;
  team.applyEvent(done('x', 'failed'), round);
  assert.equal(team.snapshot().finished, 1);
  team.applyEvent(spawn('x'), round);
  assert.equal(team.snapshot().pending, 0);
  assert.equal(clones(container).length, 0, '墓碑 id 的迟到 spawn 不得复活分身');
  team.applyEvent(done('x', 'completed'), round);
  assert.equal(team.snapshot().finished, 1, '重复 done 幂等');
  team.applyEvent(spawn('a'), round);
  team.applyEvent(spawn('a'), round);
  assert.equal(team.snapshot().pending, 1, '重复 spawn 幂等');
  team.applyEvent(done('a'), round);
  team.applyEvent(done('a'), round);
  assert.equal(team.snapshot().finished, 2, 'x+a 两块墓碑');
});

test('settle/cancel 终结本轮：主脸映射齐全、pending 按轮次关闭移除且不记 done', () => {
  const { team, container } = boot();
  const first = team.begin()!;
  team.applyEvent(spawn('a'), first.round);
  team.applyEvent(spawn('b'), first.round);
  assert.equal(team.settle('itinerary', first.round)?.mainFace, 'happy');
  const snap = team.snapshot();
  assert.equal(snap.phase, 'done');
  assert.equal(snap.pending, 0);
  assert.equal(snap.finished, 0, '轮次关闭不得伪造 done 墓碑');
  assert.equal(clones(container).length, 0, '容器清场');
  assert.equal(team.applyEvent(spawn('c'), first.round), null, '已终结轮次的事件 noop');
  for (const [kind, face] of [['clarification', 'asking'], ['answer', 'happy'], ['plans', 'happy'], ['error', 'confused']] as const)
    assert.equal(team.settle(kind, team.begin()!.round)?.mainFace, face);
  const r = team.begin()!.round;
  team.applyEvent(spawn('z'), r);
  assert.equal(team.cancel(r)?.mainFace, 'idle');
  assert.equal(team.snapshot().phase, 'idle');
  assert.equal(clones(container).length, 0);
  assert.throws(() => team.settle('weird_kind', team.begin()!.round), /unknown kind/, '非法 kind 抛错');
});

test('旧 round 的迟到进度/结果/取消全部 noop，不污染新轮', () => {
  const { team, container } = boot();
  const r1 = team.begin()!.round;
  team.applyEvent(spawn('a'), r1);
  const r2 = team.begin()!.round;
  assert.notEqual(r1, r2);
  assert.equal(team.applyEvent(spawn('stale'), r1), null);
  assert.equal(team.applyEvent(done('a'), r1), null);
  assert.equal(team.settle('plans', r1), null);
  assert.equal(team.cancel(r1), null);
  const snap = team.snapshot();
  assert.equal(snap.round, r2);
  assert.equal(snap.pending, 0);
  assert.equal(snap.finished, 0, '新轮墓碑清空');
  assert.equal(clones(container).length, 0, '旧轮分身不得复现');
  team.applyEvent(spawn('fresh'), r2);
  assert.equal(team.snapshot().pending, 1, '新轮自身事件照常');
});

test('destroy 永闭合：清容器、全部调用 noop、snapshot 仍可读且幂等', () => {
  const { team, container } = boot();
  const r = team.begin()!.round;
  team.applyEvent(spawn('a'), r);
  team.destroy();
  assert.equal(container.children.length, 0, '移除容器内全部节点');
  assert.equal(team.snapshot().destroyed, true);
  assert.equal(team.snapshot().clones.length, 0);
  assert.equal(team.applyEvent(spawn('b'), r), null);
  assert.equal(team.settle('answer', r), null);
  assert.equal(team.cancel(r), null);
  assert.equal(team.begin(), null, 'destroy 后不得再 begin');
  team.destroy();
});

test('label 注入安全：title/plan_id 仅 textContent；非法 stage 继承键拒绝、未来帧兼容', () => {
  const { team, container } = boot();
  const { round } = team.begin()!;
  const evil = '<img src=x onerror=alert(1)>';
  team.applyEvent(spawn('a', { title: evil, plan_id: '<b>' }), round);
  const el = clones(container)[0]!;
  assert.equal(findCls(el, 'mascot-team-title')[0]?.textContent, evil, 'title 原样 textContent');
  assert.equal(findCls(el, 'mascot-team-badge')[0]?.textContent, '<b');
  assert.equal(el.innerHTML, '', '不得使用 innerHTML');
  assert.equal(String(el.attrs.get('aria-label')).includes('分身·'), true);
  for (const key of ['toString', '__proto__', 'hasOwnProperty', 'constructor'])
    assert.equal(team.applyEvent({ stage: key }, round)?.mainFace, undefined, `继承键 ${key} 拒绝`);
  assert.equal(team.snapshot().phase, 'exploring', '继承键不得推进相位');
  assert.equal(team.applyEvent({ type: 'future_probe' }, round)?.mainFace, undefined, '未知 type 前向兼容');
});

test('done 终结脸真实到达分身 controller：completed→happy、failed→confused、cancelled→idle', () => {
  const { team, calls } = boot({ reduced: false });
  const { round } = team.begin()!;
  team.applyEvent(spawn('a'), round);
  team.applyEvent(spawn('b'), round);
  team.applyEvent(spawn('c'), round);
  assert.equal(JSON.stringify(calls.map(c => c.states)), '[["thinking"],["thinking"],["thinking"]]', '入场呈工作姿态');
  team.applyEvent(done('a', 'completed'), round);
  team.applyEvent(done('b', 'failed'), round);
  team.applyEvent(done('c', 'cancelled'), round);
  assert.equal(JSON.stringify(calls[0]!.states), '["thinking","happy"]');
  assert.equal(JSON.stringify(calls[1]!.states), '["thinking","confused"]');
  assert.equal(JSON.stringify(calls[2]!.states), '["thinking","idle"]');
});

test('终结脸在 reduced 路径同样下发；controller 抛错不拖垮编排', () => {
  const good = boot();
  const rg = good.team.begin()!.round;
  good.team.applyEvent(spawn('a'), rg);
  good.team.applyEvent(done('a', 'failed'), rg);
  assert.equal(JSON.stringify(good.calls[0]!.states), '["thinking","confused"]', 'reduced 立即移除前仍收到终结脸');

  const bad = boot({ badMascot: true });
  const rb = bad.team.begin()!.round;
  bad.team.applyEvent(spawn('a'), rb);                             // setState('thinking') 抛错
  assert.equal(clones(bad.container).length, 1, '坏脸分身仍建 DOM');
  bad.team.applyEvent(done('a'), rb);                              // setState('happy') 再抛
  assert.equal(clones(bad.container).length, 0, '坏脸不阻塞退场');
  assert.equal(bad.team.snapshot().phase, 'thinking');
});

test('settle/cancel 清理全部在途 enter/exit/pulse 定时器', () => {
  const { team, container, timers } = boot({ reduced: false });
  const { round } = team.begin()!;
  team.applyEvent(spawn('a'), round);                              // enterTimer 在途
  team.applyEvent(done('a'), round);                               // exitTimer 在途
  team.applyEvent(spawn('b'), round);
  team.applyEvent(tool('b', { name: 'search_events', result_count: 2 }), round); // pulseTimer 在途
  assert.equal(timers.filter(t => !t.cancelled).length > 0, true);
  team.settle('answer', round);
  assert.equal(clones(container).length, 0);
  assert.equal(timers.filter(t => !t.cancelled).length, 0, '轮次终结清空全部装饰定时器');
});

test('reduced-motion：入场即静态、退场即移除，face 带 motion=reduce', () => {
  const { team, container } = boot({ reduced: true });
  const { round } = team.begin()!;
  team.applyEvent(spawn('a'), round);
  const el = clones(container)[0]!;
  assert.equal(el.attrs.get('data-status'), 'working', 'reduced 无 entering 节拍');
  assert.equal(el.children[0]!.attrs.get('motion'), 'reduce');
  team.applyEvent(done('a'), round);
  assert.equal(clones(container).length, 0, 'reduced 退场立即移除');
});

test('在途退场为真实补位让路：DOM 可见脸恒 ≤maxVisible', () => {
  const { team, container, flush } = boot({ reduced: false });
  const { round } = team.begin()!;
  for (const id of ['a', 'b', 'c', 'd']) team.applyEvent(spawn(id), round);
  flush();
  assert.equal(clones(container).length, 3);
  assert.equal(team.snapshot().overflow, 1);
  team.applyEvent(done('a', 'completed'), round);          // 槽位 0 释放 → d 立即补位
  assert.equal(team.snapshot().overflow, 0);
  assert.equal(team.snapshot().active, 3);
  assert.equal(clones(container).length, 3, 'a 的在途退场装饰立即让位，不得出现第 4 张脸');
  assert.equal(clones(container).some(el => el.attrs.get('data-status') === 'completed'), false);
  team.applyEvent(done('b', 'completed'), round);          // 无等待者：退场拍正常播放
  assert.equal(clones(container).length, 3, '无补位需求时退出装饰保留至定时结束');
  flush();
  assert.equal(clones(container).length, 2);
});

test('非 reduced：入退场为装饰拍——墓碑先行、DOM 拍后移除、settle 连同在途退场一并拆除', () => {
  const { team, container, flush } = boot({ reduced: false });
  const { round } = team.begin()!;
  team.applyEvent(spawn('a'), round);
  assert.equal(clones(container)[0]!.attrs.get('data-status'), 'entering');
  flush();
  assert.equal(clones(container)[0]!.attrs.get('data-status'), 'working');
  team.applyEvent(done('a'), round);
  const snap = team.snapshot();
  assert.equal(snap.finished, 1, '业务墓碑先行');
  assert.equal(snap.clones.length, 0, '业务态已退场');
  assert.equal(snap.beat, 'merging');
  assert.equal(clones(container)[0]!.attrs.get('data-status'), 'completed', 'DOM 仍呈现退出姿态');
  team.applyEvent(spawn('b'), round);                        // 在途退场 + 新分身
  team.settle('answer', round);                              // 轮次终结：立即全量拆除
  assert.equal(clones(container).length, 0, '在途退场元素也须移除');
  flush();
  assert.equal(clones(container).length, 0);
});

test('setAnchored：严格 token、只切显示不动 pending；等待池补位继承锚点', () => {
  const { team, container } = boot();
  const { round } = team.begin()!;
  assert.throws(() => team.setAnchored('a', true), /round token/);
  assert.equal(team.setAnchored('a', true, round + 9), null, 'stale token noop');
  assert.equal(team.setAnchored('ghost', true, round), null, '未知 id noop');
  team.applyEvent(spawn('a'), round);
  const el = clones(container)[0]!;
  assert.equal(el.attrs.get('data-subagent-id'), 'a', '挂载元素标真实归属 id');
  assert.equal(el.attrs.get('data-anchored'), 'false');
  assert.equal(team.setAnchored('a', true, round)?.anchored, true);
  assert.equal(el.attrs.get('data-anchored'), 'true');
  assert.equal(team.snapshot().pending, 1, 'pending 簿记不变');
  assert.equal(team.snapshot().clones[0]!.anchored, true);
  assert.equal(team.setAnchored('a', false, round)?.anchored, false);
  assert.equal(el.attrs.get('data-anchored'), 'false', '离屏/取消恢复卡片脸');

  // 等待池分身：无 DOM 也可先记锚点，补位挂载时带出
  for (const id of ['b', 'c', 'd', 'e']) team.applyEvent(spawn(id), round);
  assert.equal(team.snapshot().overflow, 2, 'd/e 在等待池');
  team.setAnchored('e', true, round);
  team.applyEvent(done('b'), round);                          // d 先补位
  team.applyEvent(done('c'), round);                          // e 补位
  const eEl = clones(container).find(x => x.attrs.get('data-subagent-id') === 'e')!;
  assert.equal(eEl.attrs.get('data-anchored'), 'true', '补位分身继承锚点显隐');

  // done 与轮次终结不受锚点影响；终结轮 token 失效
  team.applyEvent(done('a'), round);
  assert.equal(team.snapshot().pending, 2);
  team.settle('answer', round);
  assert.equal(team.setAnchored('e', false, round), null, '已终结轮 noop');
});

test('data-anchored CSS：实例 scope 隐藏脸但保留徽标/title', () => {
  const css = readFileSync(new URL('../frontend/mascot-team.css', import.meta.url), 'utf8');
  assert.ok(/\.mascot-team \.mascot-team-clone\[data-anchored="true"\] boop-face\s*\{[^}]*visibility:\s*hidden/.test(css),
    'anchored 规则 scope 在 .mascot-team 内且只隐藏脸');
});

test('snapshot 形态：round/phase/beat/clones/overflow/nested/active/pending/finished', () => {
  const { team } = boot();
  const { round } = team.begin()!;
  team.applyEvent(spawn('a', { plan_id: 'A' }), round);
  team.applyEvent(spawn('n', { parent_run_id: 'other' }), round);
  const snap = team.snapshot();
  assert.equal(snap.round, round);
  assert.equal(snap.phase, 'exploring');
  assert.equal(snap.beat, 'dispatching');
  assert.equal(JSON.stringify(Object.keys(snap.clones[0]!)), '["id","title","letter","palette","status","activity","anchored"]');
  assert.equal(snap.clones[0]!.anchored, false);
  assert.equal(snap.clones[0]!.letter, 'A');
  assert.equal(snap.clones[0]!.status, 'working');
  assert.equal(snap.nested, 1);
});

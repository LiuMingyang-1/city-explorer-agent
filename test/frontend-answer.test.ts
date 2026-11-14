/**
 * Issue #19 前端回归（C3）：已有行程卡片时收到 {kind:"answer",text}，
 * 只追加一条普通 assistant 消息——不新增行程卡片、不改 state.latestPlan/
 * activePlanId、不触发地图重绘（WanderPlans.append 不得被调用）；
 * 新会话再打开本地历史，行程卡片与回答文本同时恢复；随后"换成室内的"
 * 正常出新卡片。行为断言为主，不走真实网络（fetch/SSE 桩见注释）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setup, Element } from './frontend-fixture.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL('../docs/mocks/day0/' + name + '.json', import.meta.url), 'utf8'));

function nodes(root: Element): Element[] {
  return [root, ...root.children.flatMap(nodes)];
}
function find(root: Element, cls: string): Element[] {
  return nodes(root).filter((e) => e.className.split(' ').includes(cls));
}

const answer = (text: string) => ({ kind: 'answer', session_id: 'sess_mock_001', text });

test('问答响应只加聊天记录：无新卡片、latestPlan/选中方案/地图全部不动', async () => {
  const h = setup({ api: true });
  const first = h.run('window.sendMessage("周六下午想看展")');
  h.requests[0]!.finish(fixture('response-single'));
  await first;
  assert.equal(find(h.$('messages'), 'plan-preview').length, 1);
  const planBefore = h.run('JSON.stringify(state.latestPlan)');
  const activeBefore = h.run('state.activePlanId');
  // 观察卡片装配入口：answer 不得再进 WanderPlans.append（即无新卡片/地图重绘）。
  h.run(`window.__appends = 0; const orig = window.WanderPlans.append;
    window.WanderPlans.append = (d, o) => { window.__appends++; return orig(d, o); };`);

  const second = h.run('window.sendMessage("明天天气怎么样")');
  h.requests[1]!.finish(answer('明天多云转阴，18–24℃，基本不影响出行。'));
  await second;

  assert.equal(h.run('window.__appends'), 0, 'answer 不得触发卡片装配/地图重绘');
  assert.equal(find(h.$('messages'), 'plan-preview').length, 1, '不得新增行程卡片');
  assert.equal(h.run('JSON.stringify(state.latestPlan)'), planBefore, 'latestPlan 不变');
  assert.equal(h.run('state.activePlanId'), activeBefore, '选中方案不变');
  const last = h.state.messages.at(-1)!;
  assert.equal(last.role, 'assistant');
  assert.equal(last.text, '明天多云转阴，18–24℃，基本不影响出行。');
  // 普通回答绝不能报成"方案格式暂不支持"。
  assert.ok(
    !h.state.messages.some((m) => m.text.includes('方案格式暂不支持')),
    'answer 不应被当成不支持的方案格式',
  );
  assert.equal(h.run('state.sessionId'), 'sess_mock_001');
  // 请求体照常带 session_id（续用同一对话）。
  assert.equal(h.requests[1]!.body.session_id, 'sess_mock_001');
});

test('SSE 通道同样支持 answer：result 帧只追加聊天记录', async () => {
  const h = setup({ api: true });
  const first = h.run('window.sendMessage("想看展")');
  h.requests[0]!.finish(fixture('response-single'));
  await first;
  h.context.fetch = async () =>
    new Response(
      'event: meta\ndata: {"session_id":"sess_mock_001"}\n\n' +
        'event: result\ndata: {"kind":"answer","session_id":"sess_mock_001","text":"第二站免费但需预约。"}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  await h.run('window.sendMessage("第二站需要预约吗")');
  assert.equal(find(h.$('messages'), 'plan-preview').length, 1);
  assert.equal(h.state.messages.at(-1)!.text, '第二站免费但需预约。');
});

test('本地历史重开：行程卡片与问答记录同时恢复', async () => {
  const h = setup({ api: true });
  const first = h.run('window.sendMessage("周六下午想看展")');
  h.requests[0]!.finish(fixture('response-single'));
  await first;
  const second = h.run('window.sendMessage("下雨会影响吗")');
  h.requests[1]!.finish(answer('会有小雨，两站都在室内，影响不大。'));
  await second;

  // 模拟刷新/重开：新会话后从历史恢复该条记录。
  h.$('new-chat').click();
  assert.equal(h.state.messages.length, 0);
  h.$('history-list').children[0]!.click();

  assert.equal(find(h.$('messages'), 'plan-preview').length, 1, '行程卡片应恢复');
  assert.ok(
    h.state.messages.some((m) => m.role === 'assistant' && m.text === '会有小雨，两站都在室内，影响不大。'),
    '回答文本应随历史恢复',
  );
  assert.equal(h.run('state.activePlanId'), 'plan_mock_b', '选中方案应恢复');
  assert.equal(h.run('state.sessionId'), 'sess_mock_001');
});

test('answer 之后"换成室内的"：修改轮正常出新卡片', async () => {
  const h = setup({ api: true });
  const first = h.run('window.sendMessage("想看展")');
  h.requests[0]!.finish(fixture('response-single'));
  await first;
  const second = h.run('window.sendMessage("下雨会影响吗")');
  h.requests[1]!.finish(answer('影响不大。'));
  await second;
  const third = h.run('window.sendMessage("那帮我换成室内的")');
  const updated = fixture('response-single');
  updated.plans = [
    { ...updated.plans[0], plan_id: 'plan_mock_indoor', title: 'Mock 室内线' },
  ];
  updated.active_plan = 'plan_mock_indoor';
  h.requests[2]!.finish(updated);
  await third;
  assert.equal(find(h.$('messages'), 'plan-preview').length, 2, '修改轮应新增一张卡片');
  assert.equal(h.run('state.activePlanId'), 'plan_mock_indoor');
});

test('演示 mock 通道：?mock=answer 直接渲染普通回答、不出卡片', async () => {
  const h = setup({ api: true, mock: 'answer' });
  const pending = h.run('window.sendMessage("明天天气怎么样")');
  // mock 模式经 mockRequest 走 fetch('/data/mock-answer.json')：喂真实演示文件。
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.url, '/data/mock-answer.json');
  const mockAnswer = JSON.parse(
    readFileSync(new URL('../frontend/data/mock-answer.json', import.meta.url), 'utf8'),
  );
  h.requests[0]!.finish(mockAnswer);
  await pending;
  assert.equal(find(h.$('messages'), 'plan-preview').length, 0, '演示 answer 不得出卡片');
  const last = h.state.messages.at(-1)!;
  assert.equal(last.role, 'assistant');
  assert.equal(last.text, mockAnswer.text);
  assert.equal(h.run('state.latestPlan'), null);
});

/**
 * Reviewer P2 定向回归：原卡片在消息 index 0、共 62 条消息、末条 answer
 * 逐字复述方案 summary；capture 的 60 条窗口把卡片截掉后，open 不得把
 * 这条 answer 吞掉或在其位置重放行卡片。
 * 陷阱：卡片消息与 answer 文本相同，按文本匹配会误认末条为卡片。
 */
test('卡片被 60 条窗口截掉后重开：逐字复述 summary 的 answer 不被吞也不被替换成卡片', async () => {
  const h = setup({ api: true });
  const plan = fixture('response-single');
  h.run(`(() => {
    window.WanderPlans.append(${JSON.stringify(plan)}, { drawMap: false });
    const planText = window.WanderPlans.summary(state.latestPlan);
    for (let i = 0; i < 60; i++) state.messages.push({ role: i % 2 ? 'assistant' : 'user', text: 'msg-' + i });
    state.messages.push({ role: 'assistant', text: planText });
  })()`);
  const planText = h.run('window.WanderPlans.summary(state.latestPlan)');
  assert.equal(h.state.messages.length, 62, '卡片 index0 + 61 条后续消息');

  h.run('window.WanderHistory.capture()');
  const entry = h.stored()[0]!;
  assert.equal(entry.messages.length, 60, '快照只保留末尾 60 条（卡片已截出窗口）');
  h.run(`window.WanderHistory.open(${JSON.stringify(entry.id)})`);

  // 末条必须是逐字复述 summary 的那条普通回答——不能被换成行程卡片。
  assert.equal(h.state.messages.length, 60);
  const last = h.state.messages.at(-1)!;
  assert.equal(last.role, 'assistant');
  assert.equal(last.text, planText, '末条 answer 必须作为普通消息恢复');
  assert.equal(
    find(h.$('messages'), 'plan-preview').length,
    0,
    '卡片已截出窗口：不得在 answer 位置重放行程卡片',
  );
  assert.equal(h.run('state.planMessageIndex'), null, '无卡片就不应有卡片索引');
  // 方案状态本身仍恢复（地图/滑块继续可用），只是消息流里没有卡片占位。
  assert.ok(h.run('state.latestPlan') !== null);
  assert.equal(h.run('state.activePlanId'), 'plan_mock_b');
});

/** 旧版本写入的快照没有 planIndex 字段：仍按文本回退恢复卡片。 */
test('旧快照缺 planIndex：按文本回退恢复卡片，answer 消息不受影响', async () => {
  const plan = fixture('response-single');
  // 先走一遍真实 capture 产出入库快照，再剥掉 planIndex 模拟旧版本数据。
  const src = setup({ api: true });
  src.run(`(() => {
    window.WanderPlans.append(${JSON.stringify(plan)}, { drawMap: false });
    state.messages.push({ role: 'user', text: '要预约吗' });
    state.messages.push({ role: 'assistant', text: '不用，凭身份证入场即可。' });
    window.WanderHistory.capture();
  })()`);
  const legacy = src.stored()[0] as Record<string, unknown>;
  delete legacy.planIndex;

  const h = setup({ api: true, entries: [legacy as never] });
  h.run(`window.WanderHistory.open(${JSON.stringify(legacy.id)})`);
  assert.equal(
    find(h.$('messages'), 'plan-preview').length,
    1,
    '旧快照应经文本回退恢复出一张卡片',
  );
  const last = h.state.messages.at(-1)!;
  assert.equal(last.role, 'assistant');
  assert.equal(last.text, '不用，凭身份证入场即可。');
  assert.equal(h.run('state.activePlanId'), 'plan_mock_b');
});

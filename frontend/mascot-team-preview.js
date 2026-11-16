'use strict';
// 分身排练场驱动器（I40-F2b）。
// 诚实性约定：所有业务事件都来自手动点击；SIM_* 构造器只造 #39 契约字段；
// round token 是 createMascotTeam 的本地调用参数，绝不写进 wire JSON。

const $ = sel => document.querySelector(sel);
const els = {
  mainFace: $('#main-face'), phase: $('#phase-chip'), beat: $('#beat-chip'), face: $('#face-chip'),
  roundCur: $('#round-current'), roundStale: $('#round-stale'),
  strip: $('#team-strip'),
  snapPending: $('#snap-pending'), snapWaiting: $('#snap-waiting'), snapNested: $('#snap-nested'), snapClones: $('#snap-clones'),
  log: $('#event-log'), rm: $('#rm-toggle'), loadError: $('#load-error'),
  doneId: $('#done-id'), doneIds: $('#done-ids'), doneStatus: $('#done-status'),
  spawnId: $('#spawn-id'), spawnPlan: $('#spawn-plan'), spawnTitle: $('#spawn-title'), spawnParent: $('#spawn-parent'),
  toolSub: $('#tool-sub'), toolName: $('#tool-name'), toolCount: $('#tool-count'),
  scenarioList: $('#scenario-list'), stepList: $('#step-list'), nextStep: $('#btn-next-step'),
  resetScenario: $('#btn-reset-scenario'), scenarioStatus: $('#scenario-status'),
};

/* ——— SIM_* wire 构造器：只用 docs/issue-40/mascot-states.md §1 的真实字段 ——— */
const SIM = {
  stage: (stage, message, plan_ids = []) => ({ stage, message, plan_ids }),
  spawn: ({ id, plan_id = null, parent_run_id, title, task_summary = '', message = '' }) => ({
    type: 'subagent_spawned', subagent_id: id, plan_id, parent_run_id,
    title, task_summary, message: message || `已派出分身处理「${title}」`,
  }),
  done: ({ id, plan_id = null, status, kind = null, stops_count = null, title = '', summary = '', child_run_id = null, child_run_status = 'completed', message = '' }) => {
    const evt = {
      type: 'subagent_done', subagent_id: id, plan_id, status,
      stops_count, title, summary, child_run_id, child_run_status,
      message: message || `分身 ${id} ${status}`,
    };
    if (kind) evt.kind = kind;
    return evt;
  },
  tool: ({ call_id, name, args_summary, result_count = null, status = 'completed', duration_ms = null, subagent_id = undefined, message = '' }) => {
    const evt = {
      type: 'tool_call', tool_call_id: call_id, name, args_summary,
      result_count, status, message: message || `${name} 调用结束`,
    };
    if (duration_ms != null) evt.duration_ms = duration_ms;
    if (subagent_id !== undefined) evt.subagent_id = subagent_id;
    return evt;
  },
};

const PRESET_SPAWNS = [
  { letter: 'A', title: '湖东咖啡与老书店散步', summary: '沿湖东步道串两家独立咖啡与一家旧书店，步行优先' },
  { letter: 'B', title: '老城巷子与美术馆半日', summary: '老城片区巷子串联，收尾一间美术馆，避开人流' },
  { letter: 'C', title: '滨江日落骑行线', summary: '滨江绿道骑行，卡日落时段，含两处观景停靠' },
];
const EXTRA_SPAWNS = [
  { letter: 'D', title: '亲子雨天室内备选', summary: '雨天备案：室内馆与手作体验，步行换乘最短' },
  { letter: 'E', title: '深夜食堂收尾方案', summary: '晚饭收尾：三条深夜食堂小街对比' },
];
const RUN_ROOT = 'run-root-01';

let team = null;
let mascot = null;
let round = null;        // 当前 round token（begin() 发放，本地捕获）
let staleRound = null;   // 上一个 round，专供「跨轮迟到」注入
let manualSeq = 0;
let toolSeq = 0;

/* ——— 渲染 ——— */
const short = v => (v == null ? '—' : String(v));
function logEntry(kind, wire, token, result) {
  const li = document.createElement('li');
  if (kind !== 'evt') li.classList.add(kind);
  const k = document.createElement('span'); k.className = 'kind'; k.textContent = kind === 'evt' ? 'event' : kind;
  const tag = document.createElement('span'); tag.className = 'rtag'; tag.textContent = token == null ? 'no-tok' : `r:${token}`;
  const body = document.createElement('div'); body.className = 'wire-json';
  body.textContent = JSON.stringify(wire);
  const ret = document.createElement('span'); ret.className = 'ret';
  if (result === null) { ret.classList.add('null'); ret.textContent = '→ null（token 不符 / 忽略，零副作用）'; }
  else if (result === undefined) ret.textContent = '→ void';
  else ret.textContent = `→ ${JSON.stringify(result)}`;
  body.append(ret);
  li.append(k, tag, body);
  els.log.append(li);
  li.scrollIntoView({ block: 'nearest' });
}

function applyMainFace(res) {
  if (res && res.mainFace && mascot) {
    try { mascot.setState(res.mainFace); } catch (err) { console.error('mainFace setState', err); }
    els.face.textContent = `表情 ${res.mainFace}`;
  }
}

function refresh() {
  if (!team) return;
  const s = team.snapshot();
  els.phase.textContent = `相位 ${s.phase}`;
  els.roundCur.textContent = `round ${short(s.round)}`;
  if (s.beat) { els.beat.hidden = false; els.beat.textContent = `节拍 ${s.beat}`; }
  const clones = Array.isArray(s.clones) ? s.clones : [];
  els.snapPending.textContent = `存活 ${clones.length}`;
  els.snapWaiting.textContent = `等待 +${s.overflow ?? 0}`;
  els.snapNested.textContent = `嵌套 ${s.nested ?? 0}`;
  els.snapClones.textContent = clones.length
    ? clones.map(c => `[${c.letter ?? '?'}] ${c.title ?? c.id} · ${c.status} · ${c.palette}`).join('　|　')
    : '无可见分身';
  // done 目标建议列表 = 当前快照里的分身 id
  els.doneIds.textContent = '';
  for (const c of clones) {
    const opt = document.createElement('option');
    opt.value = c.id;
    els.doneIds.append(opt);
  }
  applyMotionPref();
}

function applyMotionPref() {
  const mode = els.rm.checked ? 'reduce' : 'auto';
  for (const face of document.querySelectorAll('boop-face')) face.setAttribute('motion', mode);
}

/* ——— 控制面（全部显式带 token） ——— */
function doBegin() {
  const res = team.begin();
  staleRound = round;
  round = res.round;
  if (staleRound != null) { els.roundStale.hidden = false; els.roundStale.textContent = `stale ${staleRound}`; }
  logEntry('ctl', { call: 'begin()' }, round, res);
  applyMainFace(res);
  refresh();
}
function doSettle(kind, token = round) {
  const res = team.settle(kind, token);
  logEntry('ctl', { call: `settle('${kind}')` }, token, res);
  applyMainFace(res);
  refresh();
}
function doCancel(token = round) {
  const res = team.cancel(token);
  logEntry('ctl', { call: 'cancel()' }, token, res);
  applyMainFace(res);
  refresh();
}
function send(evt, token = round) {
  const res = team.applyEvent(evt, token);
  logEntry(token !== round ? 'stale' : 'evt', evt, token, res);
  applyMainFace(res);
  refresh();
}

/* ——— 控制台按钮 ——— */
function wireConsole() {
  $('#btn-begin').addEventListener('click', doBegin);
  $('#btn-cancel').addEventListener('click', () => doCancel());
  for (const b of document.querySelectorAll('[data-settle]')) b.addEventListener('click', () => doSettle(b.dataset.settle));
  for (const b of document.querySelectorAll('[data-stage]')) b.addEventListener('click', () =>
    send(SIM.stage(b.dataset.stage, `父轮进入 ${b.dataset.stage}`, [])));

  const usedPreset = new Map();
  for (const b of document.querySelectorAll('[data-preset]')) b.addEventListener('click', () => {
    const p = PRESET_SPAWNS[Number(b.dataset.preset)];
    const n = (usedPreset.get(p.letter) ?? 0) + 1;
    usedPreset.set(p.letter, n);
    send(SIM.spawn({
      id: n === 1 ? `sub-${p.letter.toLowerCase()}` : `sub-${p.letter.toLowerCase()}-${n}`,
      plan_id: p.letter, parent_run_id: RUN_ROOT, title: p.title,
      task_summary: p.summary, message: `派发第 ${n} 个「${p.title}」分身`,
    }));
  });
  $('#btn-spawn-custom').addEventListener('click', () => {
    const id = els.spawnId.value.trim() || `sub-m${++manualSeq}`;
    send(SIM.spawn({
      id, plan_id: els.spawnPlan.value.trim() || null,
      parent_run_id: els.spawnParent.value.trim() || RUN_ROOT,
      title: els.spawnTitle.value.trim() || `自定义分身 ${id}`,
      task_summary: '手动构造的派发任务', message: `手动 spawn ${id}`,
    }));
  });
  $('#btn-done').addEventListener('click', () => {
    const id = els.doneId.value.trim();
    if (!id) return;
    const status = els.doneStatus.value;
    send(SIM.done({
      id, status, plan_id: null,
      kind: status === 'completed' ? 'itinerary' : null,
      stops_count: status === 'completed' ? 4 : null,
      title: `分身 ${id}`, child_run_id: `run-${id}`,
      summary: status === 'completed' ? '4 站行程草稿已回传' : status === 'failed' ? '工具连续失败，放弃该方向' : '父轮取消派发',
    }));
  });
  const fireTool = overrides => {
    toolSeq += 1;
    const sub = els.toolSub.value.trim();
    send(SIM.tool({
      call_id: `call-${toolSeq}`, name: els.toolName.value.trim() || 'search_events',
      args_summary: 'type=exhibition date=weekend near=31.23,121.47 radiusKm=4',
      result_count: Number(els.toolCount.value) || 0,
      duration_ms: 640, subagent_id: sub || undefined,
      ...overrides,
    }));
  };
  $('#btn-tool').addEventListener('click', () => fireTool({}));
  $('#btn-tool-error').addEventListener('click', () => fireTool({ status: 'error', result_count: null, message: '工具执行失败' }));
  $('#btn-tool-orphan').addEventListener('click', () => fireTool({ subagent_id: 'sub-orphan-9', message: '未知归属的盖章调用' }));
  $('#btn-tool-plain').addEventListener('click', () => fireTool({ subagent_id: undefined }));

  els.rm.addEventListener('change', applyMotionPref);
}

/* ——— 场景步骤器：每步手动点击，只发一个真实形状的事件 ——— */
const S = SIM;
const scn = {
  begin: label => ({ label: label ?? '发送请求 · begin()', run: () => doBegin() }),
  evt: (label, make) => ({ label, wire: make, run: () => send(make()) }),
  stale: (label, make) => ({ label, wire: make, run: () => send(make(), staleRound) }),
  settle: kind => ({ label: `结果 settle('${kind}')`, run: () => doSettle(kind) }),
  settleStale: kind => ({ label: `迟到 settle('${kind}')·旧round`, run: () => doSettle(kind, staleRound) }),
  cancel: () => ({ label: '用户取消 · cancel()', run: () => doCancel() }),
};
const spawnStep = (p, extra = {}) => scn.evt(
  `subagent_spawned · ${p.letter}「${p.title}」`,
  () => S.spawn({ id: `sub-${p.letter.toLowerCase()}`, plan_id: p.letter, parent_run_id: RUN_ROOT, title: p.title, task_summary: p.summary, ...extra }));
const doneStep = (id, status, extra = {}) => scn.evt(
  `subagent_done · ${id} ${status}`,
  () => S.done({ id, status, title: `分身 ${id}`, child_run_id: `run-${id}`, ...extra }));
let scnToolSeq = 0;
const toolStep = (id, name, extra = {}) => {
  const n = ++scnToolSeq; // 确定性 call_id：步骤预览 JSON 与实发一致
  return scn.evt(
    `tool_call · ${name}${id ? `（盖章 ${id}）` : ''}`,
    () => S.tool({ call_id: `call-s${n}`, name, args_summary: 'type=cafe date=Saturday near=31.23,121.47 radiusKm=3', result_count: 6, duration_ms: 540, subagent_id: id, ...extra }));
};

const SCENARIOS = [
  { id: 'zero', name: '零分身 · 单方案直通', steps: [
    scn.begin(),
    scn.evt('stage searching_events', () => S.stage('searching_events', '正在检索本周末市集与展览', [])),
    scn.evt('stage exploring_plans', () => S.stage('exploring_plans', '正在整理候选方向', [])),
    scn.evt('stage routing', () => S.stage('routing', '正在串联路线', ['A'])),
    scn.evt('stage validating_schedule', () => S.stage('validating_schedule', '正在校验时间与开放窗口', ['A'])),
    scn.settle('itinerary'),
  ]},
  { id: 'one', name: '1 分身 · stage 不回收 pending', steps: [
    scn.begin(),
    scn.evt('stage exploring_plans', () => S.stage('exploring_plans', '拆分三个方向，派出探索分身', [])),
    spawnStep(PRESET_SPAWNS[0]),
    toolStep('sub-a', 'search_events'),
    scn.evt('stage routing（A 仍 pending，不得回收）', () => S.stage('routing', '父侧开始粗排，分身仍未回传', ['A'])),
    scn.evt('stage validating_schedule（仍 pending）', () => S.stage('validating_schedule', '父侧校验中，分身继续工作', ['A'])),
    scn.evt('stage exploring_plans（重复到达仍不回收）', () => S.stage('exploring_plans', '又一波派发节奏，A 还活着', [])),
    doneStep('sub-a', 'completed', { kind: 'itinerary', stops_count: 5, summary: '湖东线 5 站草稿回传', plan_id: 'A' }),
    scn.settle('plans'),
  ]},
  { id: 'two', name: '2 分身', steps: [
    scn.begin(),
    spawnStep(PRESET_SPAWNS[0]),
    spawnStep(PRESET_SPAWNS[1]),
    toolStep('sub-b', 'search_events'),
    doneStep('sub-a', 'completed', { kind: 'itinerary', stops_count: 4, plan_id: 'A' }),
    doneStep('sub-b', 'completed', { kind: 'itinerary', stops_count: 6, plan_id: 'B' }),
    scn.settle('itinerary'),
  ]},
  { id: 'three', name: '3 分身 · 满槽位', steps: [
    scn.begin(),
    spawnStep(PRESET_SPAWNS[0]),
    spawnStep(PRESET_SPAWNS[1]),
    spawnStep(PRESET_SPAWNS[2]),
    toolStep('sub-c', 'web_search', { name: 'web_search', args_summary: '滨江绿道 日落 骑行', result_count: 3 }),
    doneStep('sub-a', 'completed', { kind: 'itinerary', stops_count: 4, plan_id: 'A' }),
    doneStep('sub-b', 'completed', { kind: 'itinerary', stops_count: 5, plan_id: 'B' }),
    doneStep('sub-c', 'completed', { kind: 'itinerary', stops_count: 3, plan_id: 'C' }),
    scn.settle('plans'),
  ]},
  { id: 'overflow', name: '溢出 >3 · 等待池补位', steps: [
    scn.begin(),
    spawnStep(PRESET_SPAWNS[0]),
    spawnStep(PRESET_SPAWNS[1]),
    spawnStep(PRESET_SPAWNS[2]),
    spawnStep(EXTRA_SPAWNS[0]),
    spawnStep(EXTRA_SPAWNS[1]),
    doneStep('sub-a', 'completed', { kind: 'itinerary', stops_count: 4, plan_id: 'A' }),
    doneStep('sub-b', 'completed', { kind: 'itinerary', stops_count: 6, plan_id: 'B' }),
    toolStep('sub-d', 'search_events'),
    doneStep('sub-c', 'completed', { kind: 'itinerary', stops_count: 3, plan_id: 'C' }),
    doneStep('sub-d', 'completed', { kind: 'itinerary', stops_count: 2, plan_id: 'D' }),
    doneStep('sub-e', 'cancelled', { summary: '父轮收紧，取消该方向', plan_id: 'E' }),
    scn.settle('itinerary'),
  ]},
  { id: 'partial', name: '部分失败 · 其余继续', steps: [
    scn.begin(),
    spawnStep(PRESET_SPAWNS[0]),
    spawnStep(PRESET_SPAWNS[1]),
    spawnStep(PRESET_SPAWNS[2]),
    doneStep('sub-b', 'failed', { summary: '检索源连续超时，该方向放弃', plan_id: 'B' }),
    toolStep('sub-a', 'search_events'),
    doneStep('sub-a', 'completed', { kind: 'itinerary', stops_count: 4, plan_id: 'A' }),
    scn.evt('stage validating_schedule（C 仍 pending）', () => S.stage('validating_schedule', '校验中，C 继续跑', ['A', 'C'])),
    doneStep('sub-c', 'completed', { kind: 'itinerary', stops_count: 3, plan_id: 'C' }),
    scn.settle('itinerary'),
  ]},
  { id: 'ooo', name: '乱序 done', steps: [
    scn.begin(),
    spawnStep(PRESET_SPAWNS[0]),
    spawnStep(PRESET_SPAWNS[1]),
    spawnStep(PRESET_SPAWNS[2]),
    doneStep('sub-c', 'completed', { kind: 'itinerary', stops_count: 3, plan_id: 'C' }),
    doneStep('sub-a', 'completed', { kind: 'itinerary', stops_count: 4, plan_id: 'A' }),
    doneStep('sub-b', 'completed', { kind: 'itinerary', stops_count: 5, plan_id: 'B' }),
    scn.settle('answer'),
  ]},
  { id: 'tombstone', name: 'done 先到 · 迟到 spawn 落墓碑', steps: [
    scn.begin(),
    doneStep('sub-ghost', 'completed', { kind: 'itinerary', stops_count: 3, title: '雨天花市候补线', summary: 'done 先于 spawn 到达' }),
    scn.evt('subagent_spawned · sub-ghost 迟到（应成 finished 墓碑）', () => S.spawn({ id: 'sub-ghost', plan_id: 'G', parent_run_id: RUN_ROOT, title: '雨天花市候补线', task_summary: '迟到的派发帧', message: '迟到的 spawn' })),
    spawnStep(PRESET_SPAWNS[0]),
    doneStep('sub-a', 'completed', { kind: 'itinerary', stops_count: 4, plan_id: 'A' }),
    scn.settle('itinerary'),
  ]},
  { id: 'nested', name: '嵌套派发 · 聚合计数', steps: [
    scn.begin(),
    spawnStep(PRESET_SPAWNS[0], { parent_run_id: RUN_ROOT }),
    scn.evt('subagent_spawned · 嵌套（parent=run-child-77）', () => S.spawn({ id: 'sub-nest-1', plan_id: null, parent_run_id: 'run-child-77', title: '子分身再拆的巷深挖潜', task_summary: 'A 会话内部再派发的深层分身', message: '嵌套派发' })),
    toolStep('sub-nest-1', 'search_events', { args_summary: 'type=alley date=Sunday radiusKm=2', result_count: 9 }),
    doneStep('sub-nest-1', 'completed', { kind: 'itinerary', stops_count: 2, summary: '深层分身回传，计入聚合' }),
    toolStep('sub-a', 'estimate_travel', { args_summary: 'legs=4 mode=walk', result_count: null }),
    doneStep('sub-a', 'completed', { kind: 'itinerary', stops_count: 5, plan_id: 'A' }),
    scn.settle('itinerary'),
  ]},
  { id: 'stale', name: '跨轮迟到 · token 隔离', steps: [
    scn.begin('发送请求 · begin()（round 1）'),
    spawnStep(PRESET_SPAWNS[0]),
    scn.begin('重试 = 新请求 · begin()（round 2，旧 token 失效）'),
    scn.stale('旧 round 迟到 spawn · 应返回 null 零副作用', () => S.spawn({ id: 'sub-late', plan_id: 'Z', parent_run_id: RUN_ROOT, title: '上一轮迟到的分身', task_summary: '迟到帧', message: '迟到 spawn' })),
    scn.settleStale('answer'),
    spawnStep(PRESET_SPAWNS[1]),
    doneStep('sub-b', 'completed', { kind: 'itinerary', stops_count: 5, plan_id: 'B' }),
    scn.settle('answer'),
  ]},
  { id: 'cancel', name: '用户取消 · 清场重试', steps: [
    scn.begin(),
    spawnStep(PRESET_SPAWNS[0]),
    spawnStep(PRESET_SPAWNS[1]),
    scn.cancel(),
    scn.begin('重新请求 · begin()'),
    scn.evt('stage searching_events', () => S.stage('searching_events', '重新检索', [])),
    scn.settle('answer'),
  ]},
  { id: 'disconnect', name: '断连失败 · confused', steps: [
    scn.begin(),
    spawnStep(PRESET_SPAWNS[0]),
    toolStep('sub-a', 'search_events'),
    scn.settle('error'),
  ]},
  { id: 'clarify', name: '追问 clarification · asking', steps: [
    scn.begin(),
    spawnStep(PRESET_SPAWNS[0]),
    doneStep('sub-a', 'completed', { kind: 'clarification', summary: '想热闹市集还是安静巷子？半天还是全天？', plan_id: 'A' }),
    scn.settle('clarification'),
  ]},
];

let activeScenario = null;
let cursor = 0;

function renderScenarioList() {
  els.scenarioList.textContent = '';
  SCENARIOS.forEach((sc, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-selected', String(sc === activeScenario));
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = String(i + 1).padStart(2, '0');
    b.append(tag, document.createTextNode(sc.name));
    b.addEventListener('click', () => selectScenario(sc));
    els.scenarioList.append(b);
  });
}
function selectScenario(sc) {
  activeScenario = sc; cursor = 0;
  renderScenarioList(); renderSteps();
  els.scenarioStatus.textContent = `「${sc.name}」就绪 — 点「下一步」逐条发事件`;
}
function renderSteps() {
  els.stepList.textContent = '';
  if (!activeScenario) { els.nextStep.disabled = true; return; }
  activeScenario.steps.forEach((st, i) => {
    const li = document.createElement('li');
    li.textContent = st.label;
    if (i < cursor) li.className = 'done';
    else if (i === cursor) li.className = 'current';
    if (st.wire) {
      const w = document.createElement('span'); w.className = 'wire';
      try { w.textContent = JSON.stringify(st.wire()); } catch { w.textContent = '…'; }
      li.append(w);
    }
    els.stepList.append(li);
  });
  els.nextStep.disabled = !team || cursor >= activeScenario.steps.length;
  if (cursor >= activeScenario.steps.length) els.scenarioStatus.textContent = `「${activeScenario.name}」已完成 ${cursor} 步`;
}
function wireScenarios() {
  els.nextStep.addEventListener('click', () => {
    if (!activeScenario || cursor >= activeScenario.steps.length) return;
    const st = activeScenario.steps[cursor];
    try { st.run(); } catch (err) { logEntry('ctl', { error: String(err) }, round, null); console.error(err); }
    cursor += 1;
    renderSteps();
    if (cursor < activeScenario.steps.length) els.scenarioStatus.textContent = `「${activeScenario.name}」第 ${cursor}/${activeScenario.steps.length} 步已发`;
  });
  els.resetScenario.addEventListener('click', () => { cursor = 0; renderSteps(); if (activeScenario) els.scenarioStatus.textContent = `「${activeScenario.name}」已重置（round 不变，建议先 begin 新一轮）`; });
  renderScenarioList(); renderSteps();
}

/* ——— 启动 ——— */
function setControlsEnabled(on) {
  for (const b of document.querySelectorAll('.console button, #btn-next-step')) b.disabled = !on;
}

try {
  const { createWanderMascot } = await import('./wander-mascot.js');
  mascot = createWanderMascot(els.mainFace, { palette: 'moss', pointerFollow: true });
  try {
    const { createMascotTeam } = await import('./mascot-team.js');
    team = createMascotTeam(els.strip, {
      createMascot: (face, opts) => createWanderMascot(face, opts),
      maxVisible: 3,
      palettes: ['sand', 'clay', 'moss'],
      cloneSize: 56,
      reduced: () => els.rm.checked || matchMedia('(prefers-reduced-motion: reduce)').matches,
    });
    wireConsole();
    wireScenarios();
    refresh();
    // QA 钩子：只读快照 + 经同一调用路径的原始注入（token 必填校验用）
    window.__preview = {
      team, snapshot: () => team.snapshot(),
      round: () => round, stale: () => staleRound,
      applyRaw: (evt, token) => team.applyEvent(evt, token),
      applyNoToken: evt => { try { return { res: team.applyEvent(evt) }; } catch (e) { return { threw: String(e) }; } },
      settleNoToken: kind => { try { return { res: team.settle(kind) }; } catch (e) { return { threw: String(e) }; } },
      cancelNoToken: () => { try { return { res: team.cancel() }; } catch (e) { return { threw: String(e) }; } },
      mascotState: () => mascot.state,
    };
  } catch (err) {
    console.error('mascot-team.js 未就位:', err);
    els.loadError.hidden = false;
    wireScenarios(); // 剧本列表仍可查看
    setControlsEnabled(false);
  }
} catch (err) {
  console.error('wander-mascot.js 加载失败:', err);
  els.loadError.hidden = false;
  els.loadError.textContent = '小伙伴没加载出来（wander-mascot.js），请检查静态资源。';
}

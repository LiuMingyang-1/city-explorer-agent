/**
 * I39-3：tool_call 真实发射的端到端验证（src/agent/session.ts subscribe 块）。
 * 全部离线：faux 模型 → 真实工具链/真实 SQLite → tool_execution_end →
 * toolCallEvent → ProgressSink；覆盖主会话完成/错误、轮间不串事件、
 * sink 抛错不拖垮本轮、子会话事件盖章 subagent_id 透父 sink（真实
 * dispatch 透传缝，stage 不透传）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getCurrentTools } from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createExplorerAgent } from "../src/agent/explorer-agent.ts";
import type {
  PlannerProcessEvent,
  SubagentDoneEvent,
  SubagentSpawnedEvent,
  ToolCallEvent,
} from "../src/agent/progress.ts";
import { PlannerSession, createPersistentPlanner } from "../src/agent/session.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";
import {
  BASE,
  CONFIG,
  DAY1,
  afternoonPlan,
  answerEnvelope,
  exhibition,
  isDistillRequest,
  isSummaryRequest,
  makeRepo,
  makeSession,
} from "./e2e-fixture.ts";

const USER = "u-tool-progress";

const toolCalls = (events: PlannerProcessEvent[]): ToolCallEvent[] =>
  events.filter((e): e is ToolCallEvent => e.type === "tool_call");

/** 每条帧的 message 都必须非空单行（旧前端逐帧覆盖硬约定）。 */
function assertMessages(events: PlannerProcessEvent[]): void {
  assert.ok(events.length > 0);
  for (const e of events) {
    assert.equal(typeof e.message, "string");
    assert.ok(e.message.length > 0 && !e.message.includes("\n"));
  }
}

test("主会话：tool_execution_end 发 tool_call 完成帧（入参摘要/真实命中数/耗时）", async (t) => {
  const { session, repo, faux } = await makeSession(t, []);
  const ev = await exhibition(repo);
  const expected = (await repo.search({ date: DAY1, category: "展览" })).length;
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("search_events", { date: DAY1, category: "展览" }, { id: "tc_main" })],
      { stopReason: "toolUse" },
    ),
    afternoonPlan(ev),
  ]);
  const events: PlannerProcessEvent[] = [];
  const turn = await session.prompt("看展", { onProgress: (e) => events.push(e) });
  assert.equal(turn.kind, "itinerary");

  const calls = toolCalls(events);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.tool_call_id, "tc_main");
  assert.equal(call.name, "search_events");
  assert.equal(call.status, "completed");
  // 命中数取真实 details.count，与直接查库一致。
  assert.equal(call.result_count, expected);
  assert.match(call.args_summary, /date=2026-11-14/);
  assert.match(call.args_summary, /类别=展览/);
  // 真实跑过的工具有单调时钟耗时；父会话原生事件不带 subagent_id。
  assert.equal(typeof call.duration_ms, "number");
  assert.equal(call.subagent_id, undefined);
  // candidates：structuredContent.events 的真实命中（GCJ-02），
  // 与直接查库同序同值，event_id 即 EventView.event_id。
  const searched = await repo.search({ date: DAY1, category: "展览" });
  assert.deepEqual(
    call.candidates,
    searched.slice(0, 16).map((e) => ({
      event_id: e.id,
      latitude: e.latitude,
      longitude: e.longitude,
    })),
  );
  // 时序：searching stage（start 推导）→ tool_call（end）→ validating stage。
  const idx = events.indexOf(call);
  const stages = events.map((e, i) => ({ i, stage: (e as { stage?: string }).stage }));
  assert.ok(stages.some((s) => s.i < idx && s.stage === "searching_events"));
  assert.ok(stages.some((s) => s.i > idx && s.stage === "validating_schedule"));
  assertMessages(events);
});

test("主会话：工具 isError → tool_call 错误帧（result_count 恒 null）", async (t) => {
  const repo = await makeRepo(t);
  const faux = createFauxCore({});
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("web_search", { query: "陕历博 预约" }, { id: "tc_web" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(answerEnvelope("无法联网核实")),
  ]);
  const streamFn: StreamFn = (m, c, o) => faux.streamSimple(m, c, o);
  const agent = await createExplorerAgent({
    config: CONFIG,
    repository: repo,
    streamFn,
    currentDate: BASE,
    // 挂载 web_search 但 config 无 webSearchKey：execute 如实回未配置 isError，
    // fetch 桩永不被触达。
    webSearchFetch: (() =>
      Promise.reject(new Error("不该发起联网请求"))) as unknown as typeof fetch,
  });
  const session = new PlannerSession({ agent, repository: repo });
  const events: PlannerProcessEvent[] = [];
  const turn = await session.prompt("查一下", { onProgress: (e) => events.push(e) });
  assert.equal(turn.kind, "answer");

  const calls = toolCalls(events);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.tool_call_id, "tc_web");
  assert.equal(call.name, "web_search");
  assert.equal(call.status, "error");
  assert.equal(call.result_count, null);
  assert.equal(call.args_summary, "query=陕历博 预约");
  assert.equal(typeof call.duration_ms, "number");
  // error 帧恒无 candidates；非 search_events 工具也不带。
  assert.equal("candidates" in call, false);
  assertMessages(events);
});

test("轮间隔离：两轮各自挂接 sink，tool_call 不串、不重发", async (t) => {
  const { session, repo, faux } = await makeSession(t, []);
  const ev = await exhibition(repo);
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("search_events", { date: DAY1 }, { id: "tc_r1" })],
      { stopReason: "toolUse" },
    ),
    afternoonPlan(ev),
  ]);
  const events1: PlannerProcessEvent[] = [];
  assert.equal(
    (await session.prompt("第一轮", { onProgress: (e) => events1.push(e) })).kind,
    "itinerary",
  );

  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("search_events", { date: DAY1, keyword: "市集" }, { id: "tc_r2" })],
      { stopReason: "toolUse" },
    ),
    afternoonPlan(ev),
  ]);
  const events2: PlannerProcessEvent[] = [];
  assert.equal(
    (await session.prompt("第二轮", { onProgress: (e) => events2.push(e) })).kind,
    "itinerary",
  );

  const calls1 = toolCalls(events1);
  const calls2 = toolCalls(events2);
  assert.deepEqual(calls1.map((c) => c.tool_call_id), ["tc_r1"]);
  assert.deepEqual(calls2.map((c) => c.tool_call_id), ["tc_r2"]);
  // 第二轮的 pending/进度状态全新：不重复上报首轮事件。
  assert.ok(!events2.some((e) => events1.includes(e)));
});

test("sink 抛错被吞掉：tool_call 观察者异常不拖垮本轮", async (t) => {
  const { session, repo, faux } = await makeSession(t, []);
  const ev = await exhibition(repo);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("search_events", { date: DAY1 })], {
      stopReason: "toolUse",
    }),
    afternoonPlan(ev),
  ]);
  let threw = 0;
  const turn = await session.prompt("看展", {
    onProgress: (e) => {
      if (e.type === "tool_call") {
        threw += 1;
        throw new Error("observer bug");
      }
    },
  });
  assert.equal(turn.kind, "itinerary");
  assert.equal(threw, 1);
  // 业务面工具链记录不受观察异常影响。
  assert.equal(session.toolCalls.length, 1);
  assert.equal(session.toolCalls[0].toolName, "search_events");
});

test("子会话：内部 tool_call 盖章 subagent_id 透父 sink；stage 不透传", async (t: TestContext) => {
  const repository = await makeRepo(t);
  const sessions = createSqliteSessionRepository(":memory:");
  t.after(() => sessions.close());
  const ev = await exhibition(repository);

  const childCore = createFauxCore({});
  childCore.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("search_events", { date: DAY1, category: "展览" }, { id: "tc_child" })],
      { stopReason: "toolUse" },
    ),
    afternoonPlan(ev),
  ]);
  const parentCore = createFauxCore({});
  parentCore.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "delegate_task",
          { task: "2026-11-14 下午看展方向探路", title: "方案甲" },
          { id: "tc_delegate" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    afternoonPlan(ev),
  ]);
  const canned = (text: string) => {
    const core = createFauxCore({});
    core.setResponses([fauxAssistantMessage(text)]);
    return core;
  };
  const distillCore = canned("UNCHANGED");
  const summaryCore = canned("## 摘要\n- 已确认约束与行程要点已保留");
  // 按请求实际可用工具分流：挂 delegate_task 的是父 Agent，否则是 child。
  const streamFn: StreamFn = (model, context, options) => {
    if (isDistillRequest(context)) return distillCore.streamSimple(model, context, options);
    if (isSummaryRequest(context)) return summaryCore.streamSimple(model, context, options);
    const tools = getCurrentTools(context.messages).map((tool) => tool.name);
    return (tools.includes("delegate_task") ? parentCore : childCore).streamSimple(
      model,
      context,
      options,
    );
  };

  const planner = await createPersistentPlanner({
    config: CONFIG,
    repository,
    sessions,
    userId: USER,
    streamFn,
    currentDate: BASE,
  });
  t.after(() => planner.close());

  const events: PlannerProcessEvent[] = [];
  const turn = await planner.prompt("派一个看展子任务", {
    onProgress: (e) => events.push(e),
  });
  assert.equal(turn.kind, "itinerary");

  const child = (await sessions.listSessions(USER)).find((s) => s.kind === "child");
  assert.ok(child, "应创建 child 会话");

  // 子会话内部事件：恰一条盖章 tool_call（search_events 真实命中数）。
  const stamped = toolCalls(events).filter((c) => c.subagent_id !== undefined);
  assert.deepEqual(stamped.map((c) => c.tool_call_id), ["tc_child"]);
  assert.equal(stamped[0].subagent_id, child.sessionId);
  assert.equal(stamped[0].name, "search_events");
  assert.equal(stamped[0].status, "completed");
  assert.equal(
    stamped[0].result_count,
    (await repository.search({ date: DAY1, category: "展览" })).length,
  );
  // 盖章帧同时携带真实候选坐标：分身据此落位，坐标与子查询真实结果一致。
  const childSearched = await repository.search({ date: DAY1, category: "展览" });
  assert.deepEqual(
    stamped[0].candidates,
    childSearched.slice(0, 16).map((e) => ({
      event_id: e.id,
      latitude: e.latitude,
      longitude: e.longitude,
    })),
  );

  // 父会话自身 delegate_task 帧：无盖章；result_count 按真实
  // itinerary.stops[] 推导（child 行程 1 站）。
  const own = toolCalls(events).filter((c) => c.subagent_id === undefined);
  assert.deepEqual(own.map((c) => c.tool_call_id), ["tc_delegate"]);
  assert.equal(own[0].status, "completed");
  assert.equal(own[0].result_count, 1);

  // stage 属本轮私有叙事不透传：父流中没有任何盖章 stage 帧；
  // 盖章事件全是实体级（tool_call/subagent_*）。
  assert.ok(
    events.every(
      (e) => e.subagent_id === undefined || (e.type !== undefined && e.type !== "stage"),
    ),
  );
  assertMessages(events);
});

/** 首条 user 消息文本：content 可为 string 或 block 数组。 */
function firstUserText(context: {
  messages: Array<{ role?: string; content?: unknown }>;
}): string {
  const first = context.messages.find((m) => m.role === "user");
  const content = first?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b !== null && typeof b === "object" ? ((b as { text?: unknown }).text ?? "") : "",
    )
    .filter((s): s is string => typeof s === "string")
    .join(" ");
}

test("两层派发：孙会话实体 ID 不被外层盖章覆盖，spawned/done 与 DB 一一对应", async (t: TestContext) => {
  const repository = await makeRepo(t);
  const sessions = createSqliteSessionRepository(":memory:");
  t.after(() => sessions.close());
  const ev = await exhibition(repository);

  // 孙（depth=2，无 delegate_task）：一次真实检索后出行程。
  const grandCore = createFauxCore({});
  grandCore.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "search_events",
          { date: DAY1, category: "市集" },
          { id: "tc_grand_search" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    afternoonPlan(ev),
  ]);
  // 子（depth=1，仍挂 delegate_task）：先自身检索，再派孙，最后出行程。
  const childCore = createFauxCore({});
  childCore.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "search_events",
          { date: DAY1, category: "展览" },
          { id: "tc_child_search" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        fauxToolCall(
          "delegate_task",
          { task: "孙任务：市集深挖", title: "孙方案" },
          { id: "tc_child_delegate" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    afternoonPlan(ev),
  ]);
  // 父（depth=0）：派子 → 行程。
  const parentCore = createFauxCore({});
  parentCore.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "delegate_task",
          { task: "子任务：看展探路", title: "方案A" },
          { id: "tc_parent_delegate" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    afternoonPlan(ev),
  ]);
  const canned = (text: string) => {
    const core = createFauxCore({});
    core.setResponses([fauxAssistantMessage(text)]);
    return core;
  };
  const distillCore = canned("UNCHANGED");
  const summaryCore = canned("## 摘要\n- 已确认约束与行程要点已保留");
  // 分流：无 delegate_task 的是孙；父子都挂 delegate_task，按首条 user
  // 文本区分（父 = 原始提问，子 = 派发 task 文本）。
  const streamFn: StreamFn = (model, context, options) => {
    if (isDistillRequest(context)) return distillCore.streamSimple(model, context, options);
    if (isSummaryRequest(context)) return summaryCore.streamSimple(model, context, options);
    const tools = getCurrentTools(context.messages).map((tool) => tool.name);
    if (!tools.includes("delegate_task")) {
      return grandCore.streamSimple(model, context, options);
    }
    return (firstUserText(context).includes("看展探路") ? childCore : parentCore).streamSimple(
      model,
      context,
      options,
    );
  };

  const planner = await createPersistentPlanner({
    config: CONFIG,
    repository,
    sessions,
    userId: USER,
    streamFn,
    currentDate: BASE,
    maxSubagentDepth: 2,
  });
  t.after(() => planner.close());

  const events: PlannerProcessEvent[] = [];
  const turn = await planner.prompt("派看展子任务", {
    onProgress: (e) => events.push(e),
  });
  assert.equal(turn.kind, "itinerary");

  // DB 真实两级 child：parent_session_id 各异、ID 各不相同。
  const kids = (await sessions.listSessions(USER)).filter((s) => s.kind === "child");
  assert.equal(kids.length, 2);
  const child = kids.find((s) => s.parentSessionId === planner.sessionId);
  assert.ok(child, "缺第一层 child 会话");
  const grand = kids.find((s) => s.parentSessionId === child.sessionId);
  assert.ok(grand, "缺孙会话（parent 应为 child）");
  assert.notEqual(child.sessionId, grand.sessionId);

  // spawned/done：与 DB 真实 ID 一一对应且严格 1:1 配对。
  const spawned = events.filter(
    (e): e is SubagentSpawnedEvent => e.type === "subagent_spawned",
  );
  const done = events.filter((e): e is SubagentDoneEvent => e.type === "subagent_done");
  assert.deepEqual(
    spawned.map((s) => s.subagent_id).sort(),
    [child.sessionId, grand.sessionId].sort(),
  );
  assert.deepEqual(
    done.map((d) => d.subagent_id).sort(),
    [child.sessionId, grand.sessionId].sort(),
  );
  for (const s of spawned) {
    const d = done.find((x) => x.subagent_id === s.subagent_id);
    assert.ok(d, `缺 ${s.subagent_id} 的 done`);
    assert.equal(d.status, "completed");
    assert.equal(d.title, s.title);
  }
  // 孙的 spawned 挂在子 run 下（parent_run_id 与子的不同）。
  const grandSpawn = spawned.find((s) => s.subagent_id === grand.sessionId);
  const childSpawn = spawned.find((s) => s.subagent_id === child.sessionId);
  assert.notEqual(grandSpawn?.parent_run_id, childSpawn?.parent_run_id);

  // 工具归属：孙会话事件保留孙 ID——外层转发不得改写成子 ID。
  const byId = new Map(toolCalls(events).map((c) => [c.tool_call_id, c]));
  assert.equal(byId.get("tc_child_search")?.subagent_id, child.sessionId);
  assert.equal(byId.get("tc_grand_search")?.subagent_id, grand.sessionId);
  assert.equal(byId.get("tc_child_delegate")?.subagent_id, child.sessionId);
  assert.equal(byId.get("tc_parent_delegate")?.subagent_id, undefined);
  // 命中数按真实 details 推导：子的展览检索、孙的市集检索。
  assert.equal(
    byId.get("tc_child_search")?.result_count,
    (await repository.search({ date: DAY1, category: "展览" })).length,
  );
  assert.equal(
    byId.get("tc_grand_search")?.result_count,
    (await repository.search({ date: DAY1, category: "市集" })).length,
  );
  // 盖章值只能来自真实会话树；无盖章 stage 帧。
  assert.ok(
    toolCalls(events).every(
      (c) =>
        c.subagent_id === undefined ||
        c.subagent_id === child.sessionId ||
        c.subagent_id === grand.sessionId,
    ),
  );
  assert.ok(
    events.every(
      (e) => e.subagent_id === undefined || (e.type !== undefined && e.type !== "stage"),
    ),
  );
  assertMessages(events);
});

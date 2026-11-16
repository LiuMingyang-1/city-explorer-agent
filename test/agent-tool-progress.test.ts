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
import type { PlannerProcessEvent, ToolCallEvent } from "../src/agent/progress.ts";
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

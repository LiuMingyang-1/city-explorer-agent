/**
 * POST /api/chat/stream 全链路 E2E：真实 HTTP → createChatHandler →
 * createChatService → createPersistentPlanner → 真实活动/会话 SQLite，
 * 模型走 faux（含工具调用脚本）。验证进度从 Agent 工具事件与校验时机
 * 推导：search_events→searching_events、delegate_task→exploring_plans、
 * 校验→validating_schedule，以及 error 事件与断连 abort。
 * 整栈装配与库接线见 web-e2e-fixture.ts。
 */
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getCurrentTools } from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { DELEGATE_TASK_TOOL } from "../src/agent/delegate.ts";
import { createPersistentPlanner } from "../src/agent/session.ts";
import { SEARCH_EVENTS_TOOL } from "../src/agent/tools.ts";
import {
  DAY1,
  envelope,
  isDistillRequest,
  isSummaryRequest,
  stopsAt,
} from "./e2e-fixture.ts";
import { slowStream, until } from "./persistent-fixture.ts";
import {
  call,
  cookieUserId,
  getHistory,
  openWeb,
  seededEventsPath,
  tempDir,
  untilAsync,
  withCookie,
} from "./web-e2e-fixture.ts";

interface SseFrame {
  event: string;
  data: unknown;
}

function parseSse(body: string): { frames: SseFrame[]; comments: number } {
  const frames: SseFrame[] = [];
  let comments = 0;
  for (const block of body.split("\n\n")) {
    if (block.trim() === "") continue;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) comments += 1;
      else if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
    }
    if (dataLines.length > 0) {
      frames.push({ event, data: JSON.parse(dataLines.join("\n")) });
    }
  }
  return { frames, comments };
}

const postStream = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  call(base, "/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });

/** progress 帧中只取 stage 事件（type 省略/为 "stage"）；契约 §4.1。 */
const stageOf = (frames: SseFrame[]) =>
  frames
    .filter((f) => f.event === "progress")
    .map((f) => f.data as {
      type?: string;
      stage: string;
      message: string;
      plan_ids: string[];
    })
    .filter((d) => d.type === undefined || d.type === "stage");

/** progress 帧全部载荷（stage + issue#39 细粒度事件），按到达序。 */
const eventsOf = (frames: SseFrame[]) =>
  frames.filter((f) => f.event === "progress").map((f) => f.data as Record<string, unknown>);

test("stream 全链路：meta → searching_events → validating_schedule → result", async (t) => {
  const dir = tempDir(t);
  const stack = await openWeb(t, {
    eventsPath: seededEventsPath(dir),
    sessionsPath: join(dir, "sessions.db"),
  });
  const ev = (await stack.repository.search({ date: DAY1, category: "展览" }))[0];
  stack.faux.setResponses([
    fauxAssistantMessage([fauxToolCall(SEARCH_EVENTS_TOOL, { date: DAY1, category: "展览" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      envelope(
        { date: DAY1, summary: "下午看展", stops: [stopsAt(ev.id)("13:00", "14:00")] },
        { date: DAY1, availableStart: "13:00", availableEnd: "18:00" },
      ),
    ),
  ]);

  const first = await getHistory(stack.base);
  const uid = cookieUserId(first) as string;
  const reply = await postStream(stack.base, { message: "周六下午去看展" }, withCookie(uid));
  assert.equal(reply.status, 200);
  assert.match(reply.headers["content-type"] ?? "", /^text\/event-stream/);
  assert.equal(reply.headers["cache-control"], "no-store");

  const { frames } = parseSse(reply.body);
  // 检索与校验 stage 之间新插入 tool_call 实体帧（#39 契约）：帧名仍全为 progress。
  assert.deepEqual(
    frames.map((f) => f.event),
    ["meta", "progress", "progress", "progress", "result"],
  );
  const meta = frames[0].data as { session_id: string };
  assert.ok(meta.session_id.length > 0);
  const progress = stageOf(frames);
  assert.deepEqual(progress[0], {
    stage: "searching_events",
    message: "正在检索活动",
    plan_ids: [],
  });
  assert.deepEqual(progress[1], {
    stage: "validating_schedule",
    message: "正在校验路线时间",
    plan_ids: [],
  });
  // result 原样就是 /api/chat 的 ChatResult。
  const result = frames.at(-1)!.data as {
    kind: string;
    session_id: string;
    plans: { itinerary: { stops: { event_id: string }[] } }[];
    events: { event_id: string }[];
  };
  assert.equal(result.kind, "plans");
  assert.equal(result.session_id, meta.session_id);
  assert.equal(result.plans[0].itinerary.stops[0].event_id, ev.id);
  assert.equal(result.events[0].event_id, ev.id);
});

test("stream 派发链路：delegate_task → exploring_plans 标号 A/B，校验后 result", async (t) => {
  const dir = tempDir(t);
  const eventsPath = seededEventsPath(dir);
  const sessionsPath = join(dir, "sessions.db");

  // 父子请求分流：父 Agent 挂 delegate_task；child 按首条 user 消息（task 文本）分流。
  const TASK_A = "看展方向";
  const TASK_B = "市集方向";
  const parentCore = createFauxCore({});
  const childACore = createFauxCore({});
  const childBCore = createFauxCore({});
  const streamFn: StreamFn = (model, context, options) => {
    if (isDistillRequest(context)) {
      const core = createFauxCore({});
      core.setResponses([fauxAssistantMessage("UNCHANGED")]);
      return core.streamSimple(model, context, options);
    }
    if (isSummaryRequest(context)) {
      const core = createFauxCore({});
      core.setResponses([fauxAssistantMessage("## 摘要\n- 已确认约束与行程要点已保留")]);
      return core.streamSimple(model, context, options);
    }
    const tools = getCurrentTools(context.messages).map((tool) => tool.name);
    if (tools.includes(DELEGATE_TASK_TOOL)) return parentCore.streamSimple(model, context, options);
    return (firstUserText(context).includes("市集") ? childBCore : childACore).streamSimple(
      model,
      context,
      options,
    );
  };

  const stack = await openWeb(t, { eventsPath, sessionsPath, streamFn });
  const evA = (await stack.repository.search({ date: DAY1, category: "展览" }))[0];
  const evB = (await stack.repository.search({ date: DAY1, category: "市集" }))[0];
  const childEnvelope = (evId: string, arrive: string, leave: string) =>
    fauxAssistantMessage(
      envelope(
        {
          date: DAY1,
          summary: "子任务候选",
          stops: [stopsAt(evId)(arrive, leave)],
        },
        { date: DAY1, availableStart: "12:00", availableEnd: "21:00" },
      ),
    );
  childACore.setResponses([childEnvelope(evA.id, "13:00", "14:00")]);
  childBCore.setResponses([childEnvelope(evB.id, "15:00", "16:00")]);
  parentCore.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(DELEGATE_TASK_TOOL, { task: `2026-11-14 ${TASK_A}`, title: "方案A" }),
        fauxToolCall(DELEGATE_TASK_TOOL, { task: `2026-11-14 ${TASK_B}`, title: "方案B" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      envelope(
        {
          date: DAY1,
          summary: "看展加市集",
          stops: [stopsAt(evA.id)("13:00", "14:00"), stopsAt(evB.id)("15:00", "16:00")],
        },
        { date: DAY1, availableStart: "13:00", availableEnd: "18:00" },
      ),
    ),
  ]);

  const first = await getHistory(stack.base);
  const uid = cookieUserId(first) as string;
  const reply = await postStream(
    stack.base,
    { message: "下午看展，傍晚逛市集" },
    withCookie(uid),
  );
  assert.equal(reply.status, 200);
  const { frames } = parseSse(reply.body);
  assert.equal(frames[0].event, "meta");
  assert.equal(frames.at(-1)?.event, "result");
  const progress = stageOf(frames);
  // 两个并行 delegate_task 按派发序标号 A、B；随后校验带上全部方案。
  assert.deepEqual(
    progress.map((p) => `${p.stage}:${p.plan_ids.join(",")}`),
    ["exploring_plans:A", "exploring_plans:A,B", "validating_schedule:A,B"],
  );
  assert.equal(progress[0].message, "正在探路方案 A");
  assert.equal(progress[1].message, "正在并行探路方案 A 与方案 B");
});

test("stream 澄清轮：meta → result，无 progress", async (t) => {
  const dir = tempDir(t);
  const stack = await openWeb(t, {
    eventsPath: seededEventsPath(dir),
    sessionsPath: join(dir, "sessions.db"),
  });
  stack.faux.setResponses([fauxAssistantMessage('{"type":"clarify","question":"哪天去？"}')]);

  const first = await getHistory(stack.base);
  const uid = cookieUserId(first) as string;
  const reply = await postStream(stack.base, { message: "想出去玩" }, withCookie(uid));
  assert.equal(reply.status, 200);
  const { frames } = parseSse(reply.body);
  assert.deepEqual(
    frames.map((f) => f.event),
    ["meta", "result"],
  );
  const result = frames[1].data as { kind: string; question: string };
  assert.equal(result.kind, "clarification");
  assert.equal(result.question, "哪天去？");
});

test("stream 错误路径：会话不存在 → error 事件 not_found（无 meta）", async (t) => {
  const dir = tempDir(t);
  const stack = await openWeb(t, {
    eventsPath: seededEventsPath(dir),
    sessionsPath: join(dir, "sessions.db"),
  });
  const first = await getHistory(stack.base);
  const uid = cookieUserId(first) as string;
  const reply = await postStream(
    stack.base,
    { message: "hi", session_id: "sess_gone" },
    withCookie(uid),
  );
  assert.equal(reply.status, 200);
  const { frames } = parseSse(reply.body);
  assert.deepEqual(
    frames.map((f) => f.event),
    ["error"],
  );
  assert.deepEqual(frames[0].data, {
    error: { code: "not_found", message: "session not found", retryable: false },
  });
  assert.equal(stack.faux.state.callCount, 0); // 未触达模型
});

test("stream 断连：在途 run 收尾 cancelled、租约释放，与 /api/chat 同语义", async (t) => {
  const dir = tempDir(t);
  const slow = createFauxCore({ tokensPerSecond: 25 });
  const stack = await openWeb(t, {
    eventsPath: seededEventsPath(dir),
    sessionsPath: join(dir, "sessions.db"),
    streamFn: slowStream(slow),
  });
  slow.setResponses([
    fauxAssistantMessage("x".repeat(3_000)),
    fauxAssistantMessage('{"type":"clarify","question":"断连后继续"}'),
  ]);

  const first = await getHistory(stack.base);
  const uid = cookieUserId(first) as string;
  const req = httpRequest(stack.base + "/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...withCookie(uid) },
  });
  req.on("error", () => {}); // 客户端侧 ECONNRESET 是预期
  req.end(JSON.stringify({ message: "取消我" }));
  await until(() => slow.state.callCount > 0, "model call started");
  req.destroy();

  await untilAsync(async () => (await stack.sessions.listSessions(uid)).length === 1,
    "conversation row created");
  const sid = (await stack.sessions.listSessions(uid))[0].sessionId;
  await untilAsync(async () => {
    const run = (await stack.sessions.listRunsBySession(uid, sid)).at(-1);
    const sess = await stack.sessions.getSession(uid, sid);
    return run?.status === "cancelled" && sess?.leaseOwner === null;
  }, "aborted run settled as cancelled and lease released");
});

// ---- issue #39 过程事件契约（I39-4 验收用例） ----

interface SpawnedFrame {
  type: string;
  subagent_id: string;
  plan_id: string | null;
  parent_run_id: string;
  title: string;
  task_summary: string;
  message: string;
}
interface DoneFrame {
  type: string;
  subagent_id: string;
  plan_id: string | null;
  status: string;
  kind?: string;
  stops_count: number | null;
  title: string;
  summary: string;
  child_run_id: string | null;
  child_run_status: string | null;
  message: string;
}
interface ToolCallFrame {
  type: string;
  tool_call_id: string;
  name: string;
  args_summary: string;
  result_count: number | null;
  status: string;
  duration_ms?: number;
  subagent_id?: string;
  message: string;
}

/** 提取首条 user 消息文本：pi-agent prompt(text) 恒产出 parts 数组
 *  [{type:"text",text}]，纯字符串形态仅兜底。 */
function firstUserText(context: { messages: unknown }): string {
  const firstUser = (
    context.messages as Array<{ role?: string; content?: unknown }>
  ).find((m) => m.role === "user");
  const c = firstUser?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((p) => (p !== null && typeof p === "object" ? ((p as { text?: unknown }).text ?? "") : ""))
    .filter((s): s is string => typeof s === "string")
    .join("");
}

/**
 * 父子分流 streamFn：父请求按工具表含 delegate_task 识别走 parentCore，
 * child 请求（无 delegate_task）走 childCore；蒸馏/摘要用即时应答核心。
 * 与上文派发链路用例同策略，抽出来给事件用例复用。
 */
function dispatchStreamFn(
  parentCore: ReturnType<typeof createFauxCore>,
  childCore: ReturnType<typeof createFauxCore>,
): StreamFn {
  return (model, context, options) => {
    if (isDistillRequest(context)) {
      const core = createFauxCore({});
      core.setResponses([fauxAssistantMessage("UNCHANGED")]);
      return core.streamSimple(model, context, options);
    }
    if (isSummaryRequest(context)) {
      const core = createFauxCore({});
      core.setResponses([fauxAssistantMessage("## 摘要\n- 已确认约束与行程要点已保留")]);
      return core.streamSimple(model, context, options);
    }
    const tools = getCurrentTools(context.messages).map((tool) => tool.name);
    if (tools.includes(DELEGATE_TASK_TOOL)) return parentCore.streamSimple(model, context, options);
    return childCore.streamSimple(model, context, options);
  };
}

/** 兼容底线：每个 progress 帧 message 恒非空单行（旧前端逐帧展示依赖）。 */
function assertEveryFrameHasMessage(events: Record<string, unknown>[]): void {
  for (const e of events) {
    assert.ok(
      typeof e.message === "string" && e.message.length > 0 && !e.message.includes("\n"),
      `message missing/invalid on ${String(e.type ?? "stage")}`,
    );
  }
}

test("stream 过程事件：tool_call 透出参数摘要与命中数，stage 帧不变", async (t) => {
  const dir = tempDir(t);
  const stack = await openWeb(t, {
    eventsPath: seededEventsPath(dir),
    sessionsPath: join(dir, "sessions.db"),
  });
  const hits = await stack.repository.search({ date: DAY1, category: "展览" });
  const ev = hits[0];
  stack.faux.setResponses([
    fauxAssistantMessage([fauxToolCall(SEARCH_EVENTS_TOOL, { date: DAY1, category: "展览" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      envelope(
        { date: DAY1, summary: "下午看展", stops: [stopsAt(ev.id)("13:00", "14:00")] },
        { date: DAY1, availableStart: "13:00", availableEnd: "18:00" },
      ),
    ),
  ]);

  const first = await getHistory(stack.base);
  const uid = cookieUserId(first) as string;
  const reply = await postStream(stack.base, { message: "周六下午去看展" }, withCookie(uid));
  assert.equal(reply.status, 200);
  const { frames } = parseSse(reply.body);
  const events = eventsOf(frames);
  // 完整事件序列：stage → tool_call → stage（type 省略即 stage 兼容帧）。
  assert.deepEqual(
    events.map((e) => e.type ?? "stage"),
    ["stage", "tool_call", "stage"],
  );
  const call = events[1] as unknown as ToolCallFrame;
  assert.equal(call.name, "search_events");
  assert.equal(call.result_count, hits.length);
  assert.match(call.args_summary, /date=2026-11-14/);
  assert.match(call.args_summary, /展览/);
  assert.equal(call.status, "completed");
  assert.ok(call.tool_call_id.length > 0);
  assert.ok(call.subagent_id === undefined, "父会话原生事件不带 subagent_id");
  assertEveryFrameHasMessage(events);
});

test("stream 过程事件：并行派发 spawned/done 配对、plan_id 回填、终态一致", async (t) => {
  const dir = tempDir(t);
  const eventsPath = seededEventsPath(dir);
  const sessionsPath = join(dir, "sessions.db");
  const parentCore = createFauxCore({});
  const childACore = createFauxCore({});
  const childBCore = createFauxCore({});
  // 与上文派发用例同策略但双 child：按 task 文本分流 A/B。
  const streamFn: StreamFn = (model, context, options) => {
    if (isDistillRequest(context) || isSummaryRequest(context)) {
      const core = createFauxCore({});
      core.setResponses([
        isDistillRequest(context)
          ? fauxAssistantMessage("UNCHANGED")
          : fauxAssistantMessage("## 摘要\n- 已确认约束与行程要点已保留"),
      ]);
      return core.streamSimple(model, context, options);
    }
    const tools = getCurrentTools(context.messages).map((tool) => tool.name);
    if (tools.includes(DELEGATE_TASK_TOOL)) return parentCore.streamSimple(model, context, options);
    return (firstUserText(context).includes("市集") ? childBCore : childACore).streamSimple(
      model,
      context,
      options,
    );
  };
  const stack = await openWeb(t, { eventsPath, sessionsPath, streamFn });
  const evA = (await stack.repository.search({ date: DAY1, category: "展览" }))[0];
  const evB = (await stack.repository.search({ date: DAY1, category: "市集" }))[0];
  const childEnvelope = (evId: string, arrive: string, leave: string) =>
    fauxAssistantMessage(
      envelope(
        { date: DAY1, summary: "子任务候选", stops: [stopsAt(evId)(arrive, leave)] },
        { date: DAY1, availableStart: "12:00", availableEnd: "21:00" },
      ),
    );
  childACore.setResponses([childEnvelope(evA.id, "13:00", "14:00")]);
  childBCore.setResponses([childEnvelope(evB.id, "15:00", "16:00")]);
  parentCore.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(DELEGATE_TASK_TOOL, { task: "2026-11-14 看展方向", title: "方案A" }),
        fauxToolCall(DELEGATE_TASK_TOOL, { task: "2026-11-14 市集方向", title: "方案B" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      envelope(
        {
          date: DAY1,
          summary: "看展加市集",
          stops: [stopsAt(evA.id)("13:00", "14:00"), stopsAt(evB.id)("15:00", "16:00")],
        },
        { date: DAY1, availableStart: "13:00", availableEnd: "18:00" },
      ),
    ),
  ]);

  const first = await getHistory(stack.base);
  const uid = cookieUserId(first) as string;
  const reply = await postStream(stack.base, { message: "下午看展，傍晚逛市集" }, withCookie(uid));
  assert.equal(reply.status, 200);
  const { frames } = parseSse(reply.body);
  const events = eventsOf(frames);
  const spawned = events.filter((e) => e.type === "subagent_spawned") as unknown as SpawnedFrame[];
  const done = events.filter((e) => e.type === "subagent_done") as unknown as DoneFrame[];
  const calls = events.filter((e) => e.type === "tool_call") as unknown as ToolCallFrame[];
  assert.equal(spawned.length, 2);
  assert.equal(done.length, 2);
  // spawned：plan_id 按派发序回填、title 取入参、parent_run_id 同值非空。
  const byPlan = [...spawned].sort((a, b) =>
    String(a.plan_id).localeCompare(String(b.plan_id)),
  );
  assert.deepEqual(byPlan.map((s) => s.plan_id), ["A", "B"]);
  assert.deepEqual(byPlan.map((s) => s.title), ["方案A", "方案B"]);
  assert.equal(new Set(spawned.map((s) => s.subagent_id)).size, 2);
  assert.equal(new Set(spawned.map((s) => s.parent_run_id)).size, 1);
  assert.ok(spawned.every((s) => s.parent_run_id.length > 0));
  assert.ok(spawned.every((s) => s.task_summary.includes("方向")));
  // done：与 spawned 按 subagent_id 配对，终态与持久化子 run 一致。
  for (const s of spawned) {
    const d = done.find((x) => x.subagent_id === s.subagent_id);
    assert.ok(d, `subagent_done for ${s.subagent_id}`);
    assert.equal(d.plan_id, s.plan_id);
    assert.equal(d.status, "completed", JSON.stringify(d));
    assert.equal(d.kind, "itinerary");
    assert.equal(d.stops_count, 1);
    assert.equal(d.title, s.title);
    assert.equal(d.child_run_status, "completed");
    assert.ok(d.child_run_id !== null && d.child_run_id.length > 0);
  }
  // tool_call：两次 delegate_task 各一条，字段齐备。
  assert.equal(calls.filter((c) => c.name === "delegate_task").length, 2);
  for (const c of calls) {
    assert.ok(c.tool_call_id.length > 0);
    assert.equal(c.status, "completed");
    assert.ok(typeof c.args_summary === "string");
  }
  assertEveryFrameHasMessage(events);
});

test("stream 父取消：派发中断连 → spawned 已见、父子 run 终态以会话库为准", async (t) => {
  const dir = tempDir(t);
  const eventsPath = seededEventsPath(dir);
  const sessionsPath = join(dir, "sessions.db");
  const parentCore = createFauxCore({});
  const childCore = createFauxCore({ tokensPerSecond: 1 }); // 子任务长流：派发在途
  childCore.setResponses([fauxAssistantMessage("x".repeat(3000))]);
  parentCore.setResponses([
    fauxAssistantMessage(
      [fauxToolCall(DELEGATE_TASK_TOOL, { task: "2026-11-14 看展方向", title: "方案A" })],
      { stopReason: "toolUse" },
    ),
  ]);
  const stack = await openWeb(t, {
    eventsPath,
    sessionsPath,
    streamFn: dispatchStreamFn(parentCore, childCore),
  });
  const first = await getHistory(stack.base);
  const uid = cookieUserId(first) as string;
  const req = httpRequest(stack.base + "/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...withCookie(uid) },
  });
  req.on("error", () => {}); // 客户端侧 ECONNRESET 是预期
  let received = "";
  req.on("response", (res) => {
    res.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
    });
  });
  req.end(JSON.stringify({ message: "分开探路" }));
  // 断连前真实可见：subagent_spawned 帧（含子任务 title）；其后的帧客户端收不到。
  await until(() => received.includes('"subagent_spawned"'), "subagent_spawned frame observed");
  assert.match(received, /"title":"方案A"/);
  req.destroy();
  // 断连后无帧可收：终态一律以会话库为准——父 run cancelled，
  // child 会话已建、其 run 收尾 cancelled 且租约释放。
  await untilAsync(async () => {
    const mains = (await stack.sessions.listSessions(uid)).filter((s) => s.kind === "main");
    if (mains.length !== 1) return false;
    const run = (await stack.sessions.listRunsBySession(uid, mains[0].sessionId)).at(-1);
    return run?.status === "cancelled";
  }, "parent run settled cancelled");
  await untilAsync(async () => {
    const children = (await stack.sessions.listSessions(uid)).filter((s) => s.kind === "child");
    if (children.length !== 1) return false;
    const run = (await stack.sessions.listRunsBySession(uid, children[0].sessionId)).at(-1);
    const sess = await stack.sessions.getSession(uid, children[0].sessionId);
    return run?.status === "cancelled" && sess?.leaseOwner === null;
  }, "child run settled cancelled and lease released");
});

test("stream 子超时：subagent_done cancelled 与子 run 持久化终态一致", async (t) => {
  const dir = tempDir(t);
  const eventsPath = seededEventsPath(dir);
  const sessionsPath = join(dir, "sessions.db");
  const parentCore = createFauxCore({});
  const childCore = createFauxCore({ tokensPerSecond: 1 }); // 子任务长流：必超时
  childCore.setResponses([fauxAssistantMessage("x".repeat(3000))]);
  const stack = await openWeb(t, {
    eventsPath,
    sessionsPath,
    streamFn: dispatchStreamFn(parentCore, childCore),
    // 注入短子任务超时（150ms）：真实走 delegate 超时取消路径。
    createPlanner: (options) =>
      createPersistentPlanner({ ...options, subagentTimeoutMs: 150 }),
  });
  const evA = (await stack.repository.search({ date: DAY1, category: "展览" }))[0];
  parentCore.setResponses([
    fauxAssistantMessage(
      [fauxToolCall(DELEGATE_TASK_TOOL, { task: "2026-11-14 看展方向", title: "方案A" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      envelope(
        { date: DAY1, summary: "看展单线", stops: [stopsAt(evA.id)("13:00", "14:00")] },
        { date: DAY1, availableStart: "12:00", availableEnd: "18:00" },
      ),
    ),
  ]);
  const first = await getHistory(stack.base);
  const uid = cookieUserId(first) as string;
  const reply = await postStream(stack.base, { message: "看展探路" }, withCookie(uid));
  assert.equal(reply.status, 200);
  const { frames } = parseSse(reply.body);
  const events = eventsOf(frames);
  const spawned = events.find((e) => e.type === "subagent_spawned") as unknown as SpawnedFrame;
  const done = events.find((e) => e.type === "subagent_done") as unknown as DoneFrame;
  assert.ok(spawned && done, "spawned/done frames present");
  assert.equal(spawned.title, "方案A");
  assert.equal(done.subagent_id, spawned.subagent_id);
  assert.equal(done.title, "方案A");
  assert.equal(done.status, "cancelled");
  // 事件终态与持久化子 run 一致（不凭主观猜测）：DB 即权威。
  const children = (await stack.sessions.listSessions(uid)).filter((s) => s.kind === "child");
  assert.equal(children.length, 1);
  const childRun = (await stack.sessions.listRunsBySession(uid, children[0].sessionId)).at(-1);
  assert.equal(childRun?.status, "cancelled");
  assert.equal(done.child_run_id, childRun?.runId ?? null);
  assert.equal(done.child_run_status, "cancelled");
  // 父轮收到 cancelled 详情后照常降级输出 result。
  assert.equal(frames.at(-1)?.event, "result");
  assertEveryFrameHasMessage(events);
});

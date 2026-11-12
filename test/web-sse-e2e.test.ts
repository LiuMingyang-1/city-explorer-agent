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

const progressOf = (frames: SseFrame[]) =>
  frames.filter((f) => f.event === "progress").map((f) => f.data as {
    stage: string;
    message: string;
    plan_ids: string[];
  });

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
  assert.deepEqual(
    frames.map((f) => f.event),
    ["meta", "progress", "progress", "result"],
  );
  const meta = frames[0].data as { session_id: string };
  assert.ok(meta.session_id.length > 0);
  const progress = progressOf(frames);
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
  const result = frames[3].data as {
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
    const firstUser = (context.messages as Array<{ role?: string; content?: unknown }>).find(
      (m) => m.role === "user",
    );
    const text = typeof firstUser?.content === "string" ? firstUser.content : "";
    return (text.includes("市集") ? childBCore : childACore).streamSimple(model, context, options);
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
  const progress = progressOf(frames);
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

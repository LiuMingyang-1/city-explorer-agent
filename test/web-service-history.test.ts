/**
 * Web ChatService 离线测试（history + 真实持久链路）：
 * faux 模型 → 真实 createPersistentPlanner → 真实 :memory: 会话库 →
 * 真实校验与指针提交。覆盖多轮顺序、修改、隔离、失败/工具消息过滤、
 * 多对话 session_id 语义、会话标题、404/409 分类与跨对话记忆连续性。
 * send 路径的工厂/关闭语义见 web-service.test.ts。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { EventRepository } from "../src/data/repository.ts";
import type { Event } from "../src/data/types.ts";
import type { Itinerary } from "../src/itinerary/types.ts";
import type { SessionRepository } from "../src/session/repository.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";
import { ChatServiceError, createChatService } from "../src/web/service.ts";
import type { ManagedChatService } from "../src/web/service.ts";
import { ChatClientError } from "../src/web/types.ts";
import type { ChatResult } from "../src/web/types.ts";
import { BASE, CONFIG, DAY1, comparisonEnvelope, envelope, isDistillRequest, makeStreamFn } from "./e2e-fixture.ts";

function makeEvent(id: string, over: Partial<Event> = {}): Event {
  return {
    id,
    title: `活动${id}`,
    description: `介绍${id}`,
    category: "展览",
    venueName: `场馆${id}`,
    address: `地址${id}`,
    latitude: 34.3,
    longitude: 108.9,
    startAt: `${DAY1}T09:00`,
    endAt: `${DAY1}T18:00`,
    suggestedDurationMinutes: 90,
    budgetMin: 0,
    budgetMax: 5000,
    currency: "CNY",
    budgetNote: null,
    guideUrl: null,
    thumbnailUrl: null,
    imageUrls: [],
    ...over,
  };
}

function fakeRepo(events: Event[]): EventRepository {
  const map = new Map(events.map((e) => [e.id, e]));
  return {
    async search() {
      return [];
    },
    async getByIds(ids: string[]) {
      const out = new Map<string, Event>();
      for (const id of ids) {
        const event = map.get(id);
        if (event) out.set(id, event);
      }
      return out;
    },
    close() {},
  };
}

function stop(event_id: string, arrive_at: string, leave_at: string) {
  return { event_id, arrive_at, leave_at, reason: "r" };
}

/** 离线 service：faux 响应队列 + 真实会话库/默认 planner 工厂。 */
function setup(
  t: TestContext,
  events: Event[],
  options: { streamFn?: StreamFn } = {},
): { service: ManagedChatService; sessions: SessionRepository; faux: ReturnType<typeof createFauxCore> } {
  const sessions = createSqliteSessionRepository(":memory:");
  t.after(() => sessions.close());
  const faux = createFauxCore({});
  const { streamFn } = makeStreamFn(faux);
  const service = createChatService({
    config: CONFIG,
    repository: fakeRepo(events),
    sessions,
    streamFn: options.streamFn ?? streamFn,
    currentDate: BASE,
  });
  t.after(async () => {
    await service.shutdown();
  });
  return { service, sessions, faux };
}

/** send 链：首轮拿到 session_id 后同对话后续轮次显式带上。 */
async function sendTurn(
  service: ManagedChatService,
  userId: string,
  message: string,
  sessionId?: string,
): Promise<ChatResult> {
  return service.send(userId, message, sessionId === undefined ? {} : { sessionId });
}

test("空 history：不带 sessionId 直接回空，库里不建用户/会话行", async (t) => {
  const { service, sessions } = setup(t, []);
  const h1 = await service.history("u-new");
  assert.deepEqual(h1, { messages: [], itinerary: null });
  const h2 = await service.history("u-new");
  assert.deepEqual(h2, h1);
  assert.equal(await sessions.getUser("u-new"), undefined); // 不建用户
  assert.deepEqual(await sessions.listSessions("u-new"), []); // 0 会话行
});

test("澄清轮：send 返回 clarification+session_id；history(sessionId) 还原消息", async (t) => {
  const { service, sessions, faux } = setup(t, []);
  faux.setResponses([fauxAssistantMessage('{"type":"clarify","question":"哪天去？"}')]);
  const result = await sendTurn(service, "u-a", "帮我安排");
  assert.equal(result.kind, "clarification");
  if (result.kind !== "clarification") return;
  assert.equal(result.question, "哪天去？");
  assert.equal(typeof result.session_id, "string");
  // 新对话已懒建：一条 kind='main' 会话，标题为首条消息。
  const conversations = await sessions.listSessions("u-a");
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].sessionId, result.session_id);
  assert.equal(conversations[0].kind, "main");
  assert.equal(conversations[0].title, "帮我安排");

  const h = await service.history("u-a", result.session_id);
  assert.deepEqual(h.messages, [
    { role: "user", text: "帮我安排" },
    { role: "assistant", text: "哪天去？" },
  ]);
  assert.equal(h.itinerary, null);
});

test("行程轮：send 返回校验后 itinerary + EventView；history 一致且不含该轮 assistant", async (t) => {
  const ev1 = makeEvent("evt_1");
  const ev2 = makeEvent("evt_2");
  const { service, sessions, faux } = setup(t, [ev1, ev2]);
  faux.setResponses([
    fauxAssistantMessage(
      envelope(
        {
          date: DAY1,
          summary: "双站行程",
          stops: [stop("evt_2", "10:00", "11:00"), stop("evt_1", "12:00", "13:00")],
        },
        { date: DAY1 },
      ),
    ),
  ]);
  const result = await sendTurn(service, "u-a", "安排一下");
  assert.equal(result.kind, "plans");
  if (result.kind !== "plans") return;
  assert.equal(result.mode, "single");
  assert.equal(result.active_plan, "A");
  assert.equal(result.plans.length, 1);
  assert.deepEqual(
    result.events.map((e) => e.event_id),
    ["evt_2", "evt_1"],
  );
  assert.equal(result.events[0].venue_name, "场馆evt_2");
  assert.equal(result.events[0].latitude, ev2.latitude);

  // planner 已关闭：会话写租约释放（不残留 owner）。
  const session = await sessions.getSession("u-a", result.session_id);
  assert.equal(session?.leaseOwner, null);

  const h = await service.history("u-a", result.session_id);
  assert.deepEqual(h.messages, [{ role: "user", text: "安排一下" }]); // 无重复 assistant 卡片
  assert.deepEqual(h.itinerary, result.plans[0].itinerary);
  assert.equal(h.mode, undefined); // 单方案轮不还原 comparison 字段
  assert.deepEqual(h.events, result.events);
});

test("多轮同对话：澄清 → 行程 → 修改行程，显式带 session_id 续轮", async (t) => {
  const ev1 = makeEvent("evt_1");
  const ev2 = makeEvent("evt_2");
  const { service, faux } = setup(t, [ev1, ev2]);
  const planA: Itinerary = {
    date: DAY1,
    summary: "初版：单站看展",
    stops: [stop("evt_1", "10:00", "11:30")],
  };
  const planB: Itinerary = {
    date: DAY1,
    summary: "改后：两站连看",
    stops: [stop("evt_1", "10:00", "11:00"), stop("evt_2", "13:00", "14:30")],
  };
  faux.setResponses([
    fauxAssistantMessage('{"type":"clarify","question":"哪天去？"}'),
    fauxAssistantMessage(envelope(planA, { date: DAY1 })),
    fauxAssistantMessage(envelope(planB, { date: DAY1 })),
  ]);
  const r1 = await sendTurn(service, "u-a", "想出门");
  const sid = r1.session_id;
  const r2 = await sendTurn(service, "u-a", "14 号", sid);
  const r3 = await sendTurn(service, "u-a", "再加一站", sid); // 每次 send 重开同一持久会话
  assert.equal(r2.kind, "plans");
  assert.equal(r3.kind, "plans");
  assert.equal(r2.session_id, sid);
  assert.equal(r3.session_id, sid);

  const h = await service.history("u-a", sid);
  assert.deepEqual(h.messages, [
    { role: "user", text: "想出门" },
    { role: "assistant", text: "哪天去？" },
    { role: "user", text: "14 号" },
    { role: "assistant", text: "初版：单站看展" }, // 被替换行程留摘要文本，不再出卡片
    { role: "user", text: "再加一站" },
  ]);
  assert.deepEqual(h.itinerary, planB);
  assert.deepEqual(
    h.events?.map((e) => e.event_id),
    ["evt_1", "evt_2"],
  );
});

test("comparison 轮：双方案映射 kind:plans，history 还原 plans/mode/active_plan", async (t) => {
  const ev1 = makeEvent("evt_1");
  const ev2 = makeEvent("evt_2");
  const { service, faux } = setup(t, [ev1, ev2]);
  const planA: Itinerary = {
    date: DAY1,
    summary: "方案A：上午看展",
    stops: [stop("evt_1", "10:00", "11:00")],
  };
  const planB: Itinerary = {
    date: DAY1,
    summary: "方案B：连看两场",
    stops: [stop("evt_1", "10:00", "11:00"), stop("evt_2", "13:00", "14:00")],
  };
  faux.setResponses([
    fauxAssistantMessage(
      comparisonEnvelope(
        [
          { label: "A", title: "轻松单站", itinerary: planA },
          { label: "B", title: "紧凑双站", itinerary: planB },
        ],
        { date: DAY1 },
      ),
    ),
  ]);

  const result = await sendTurn(service, "u-a", "两种玩法都行，给两套");
  assert.equal(result.kind, "plans");
  if (result.kind !== "plans") return;
  assert.equal(result.mode, "comparison");
  assert.equal(result.active_plan, "A");
  assert.equal(result.coordinate_system, "GCJ-02");
  assert.deepEqual(
    result.plans.map((p) => p.label),
    ["A", "B"],
  );
  assert.deepEqual(result.plans[0].itinerary, planA);
  assert.deepEqual(result.plans[1].itinerary, planB);
  // events 为全部方案 stops 的并集去重。
  assert.deepEqual(
    result.events.map((e) => e.event_id),
    ["evt_1", "evt_2"],
  );

  // history：最近一轮是 comparison → plans/mode/active_plan 还原；
  // itinerary 仍是首个（active）方案提交的当前指针；双方案轮本身
  // 不重复进 messages（由独立卡片呈现）。
  const h = await service.history("u-a", result.session_id);
  assert.deepEqual(h.messages, [{ role: "user", text: "两种玩法都行，给两套" }]);
  assert.equal(h.mode, "comparison");
  assert.equal(h.active_plan, "A");
  assert.deepEqual(
    h.plans?.map((p) => p.label),
    ["A", "B"],
  );
  assert.deepEqual(h.itinerary, planA); // active 方案的行程即当前指针
  assert.deepEqual(
    h.events?.map((e) => e.event_id),
    ["evt_1", "evt_2"],
  );
});

test("comparison 轮后接修改轮：history 退回单方案视图，plans 字段不再出现", async (t) => {
  const ev1 = makeEvent("evt_1");
  const ev2 = makeEvent("evt_2");
  const { service, faux } = setup(t, [ev1, ev2]);
  const planA: Itinerary = {
    date: DAY1,
    summary: "A",
    stops: [stop("evt_1", "10:00", "11:00")],
  };
  const planB: Itinerary = {
    date: DAY1,
    summary: "B",
    stops: [stop("evt_2", "13:00", "14:00")],
  };
  const planC: Itinerary = {
    date: DAY1,
    summary: "改后单方案",
    stops: [stop("evt_1", "10:00", "12:00")],
  };
  faux.setResponses([
    fauxAssistantMessage(
      comparisonEnvelope(
        [
          { label: "A", title: "甲", itinerary: planA },
          { label: "B", title: "乙", itinerary: planB },
        ],
        { date: DAY1 },
      ),
    ),
    fauxAssistantMessage(envelope(planC, { date: DAY1 })),
  ]);
  const r1 = await sendTurn(service, "u-a", "两套都要看看");
  const r2 = await sendTurn(service, "u-a", "就选甲，加长一点", r1.session_id);
  assert.equal(r2.kind, "plans");
  if (r2.kind !== "plans") return;
  assert.equal(r2.mode, "single");

  const h = await service.history("u-a", r1.session_id);
  // 最新一轮是 single → comparison 字段不还原；comparison 轮 assistant
  // 文本（方案标题串）留在 messages。
  assert.equal(h.mode, undefined);
  assert.equal(h.active_plan, undefined);
  assert.equal(h.plans, undefined);
  assert.deepEqual(h.itinerary, planC);
  assert.deepEqual(h.messages, [
    { role: "user", text: "两套都要看看" },
    { role: "assistant", text: "方案 A：甲；方案 B：乙" },
    { role: "user", text: "就选甲，加长一点" },
  ]);
});

test("不带 sessionId 的 send 每次各建一条独立 main 对话", async (t) => {
  const { service, sessions, faux } = setup(t, []);
  faux.setResponses([
    fauxAssistantMessage('{"type":"clarify","question":"q1"}'),
    fauxAssistantMessage('{"type":"clarify","question":"q2"}'),
  ]);
  const r1 = await sendTurn(service, "u-a", "第一次");
  const r2 = await sendTurn(service, "u-a", "第二次");
  assert.notEqual(r1.session_id, r2.session_id);
  const conversations = await sessions.listSessions("u-a");
  assert.equal(conversations.length, 2);
  assert.ok(conversations.every((s) => s.kind === "main" && s.parentSessionId === null));

  // 各自历史独立：对话 1 只有第一轮消息。
  const h1 = await service.history("u-a", r1.session_id);
  assert.deepEqual(h1.messages, [
    { role: "user", text: "第一次" },
    { role: "assistant", text: "q1" },
  ]);
  const h2 = await service.history("u-a", r2.session_id);
  assert.deepEqual(h2.messages, [
    { role: "user", text: "第二次" },
    { role: "assistant", text: "q2" },
  ]);
});

test("失败 run 连同其输入被忽略；工具消息与纠错文本不进历史", async (t) => {
  const ev1 = makeEvent("evt_1");
  const { service, faux } = setup(t, [ev1]);
  faux.setResponses([
    // 第一轮：先真实调一次 search_events 工具，再追问。
    fauxAssistantMessage([fauxToolCall("search_events", { date: DAY1, category: "展览" })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage('{"type":"clarify","question":"预算多少？"}'),
    // 第二轮：三次不合法回复 → error turn → run failed。
    fauxAssistantMessage("not json"),
    fauxAssistantMessage("still not json"),
    fauxAssistantMessage("nope"),
  ]);
  const r1 = await sendTurn(service, "u-a", "想看展");
  assert.equal(r1.kind, "clarification");
  await assert.rejects(sendTurn(service, "u-a", "随便", r1.session_id), ChatServiceError);

  const h = await service.history("u-a", r1.session_id);
  // 只剩第一轮的 user+question：工具调用、纠错消息、失败 run 的输入全部不可见。
  assert.deepEqual(h.messages, [
    { role: "user", text: "想看展" },
    { role: "assistant", text: "预算多少？" },
  ]);
  assert.equal(h.itinerary, null);
});

test("不同 user 隔离：u-b 看不到 u-a 的对话，跨用户 session_id 一律 not_found", async (t) => {
  const ev1 = makeEvent("evt_1");
  const { service, faux } = setup(t, [ev1]);
  const plan: Itinerary = {
    date: DAY1,
    summary: "u-a 的行程",
    stops: [stop("evt_1", "10:00", "11:00")],
  };
  faux.setResponses([
    fauxAssistantMessage(envelope(plan, { date: DAY1 })),
    fauxAssistantMessage('{"type":"clarify","question":"u-b 想去哪？"}'),
  ]);
  const ra = await sendTurn(service, "u-a", "安排");
  const hA = await service.history("u-a", ra.session_id);
  const hB = await service.history("u-b"); // 无 sessionId：空历史，不建任何行
  assert.deepEqual(hB, { messages: [], itinerary: null });
  assert.ok(hA.messages.length > 0 && hA.itinerary !== null);

  // u-b 拿着 u-a 的 session_id：send/history 都是 not_found（不泄露存在性）。
  await assert.rejects(sendTurn(service, "u-b", "偷看", ra.session_id), (error) => {
    assert.ok(error instanceof ChatClientError);
    assert.equal(error.code, "not_found");
    return true;
  });
  await assert.rejects(service.history("u-b", ra.session_id), (error) => {
    assert.ok(error instanceof ChatClientError);
    assert.equal(error.code, "not_found");
    return true;
  });

  const rb: ChatResult = await sendTurn(service, "u-b", "我也想去");
  assert.equal(rb.kind, "clarification");
  assert.notEqual(rb.session_id, ra.session_id); // u-b 自己的新对话
  const hB2 = await service.history("u-b", rb.session_id);
  assert.deepEqual(hB2.messages, [
    { role: "user", text: "我也想去" },
    { role: "assistant", text: "u-b 想去哪？" },
  ]);
});

test("sessionId 校验矩阵：child 会话 not_found、归档会话 conflict（send/history 同规则）", async (t) => {
  const { service, sessions, faux } = setup(t, []);
  faux.setResponses([
    fauxAssistantMessage('{"type":"clarify","question":"q"}'),
    fauxAssistantMessage('{"type":"clarify","question":"q2"}'),
    fauxAssistantMessage('{"type":"clarify","question":"q3"}'),
  ]);
  const r1 = await sendTurn(service, "u-a", "建个对话");
  const sid = r1.session_id;

  // 造一条 child 会话：需持父对话租约。
  const writer = await sessions.acquireLease("u-a", sid, "test", 60_000);
  assert.ok(writer);
  const child = await sessions.createChildSession(writer, "u-a", {
    parentSessionId: sid,
    title: "子任务",
  });
  await sessions.releaseLease(writer, "u-a", sid);

  // 归档另一条独立对话（不能归档 sid 本身——child 的父必须留 active；
  // 且测试还要用 sid 跑通放行对照组）。
  const r2 = await sendTurn(service, "u-a", "再建一个");
  const writer2 = await sessions.acquireLease("u-a", r2.session_id, "test", 60_000);
  assert.ok(writer2);
  await sessions.archiveSession(writer2, "u-a", r2.session_id);

  const expectClientError = async (promise: Promise<unknown>, code: string) => {
    await assert.rejects(promise, (error) => {
      assert.ok(error instanceof ChatClientError);
      assert.equal(error.code, code);
      return true;
    });
  };

  // child → not_found（send 与 history 同口径）。
  await expectClientError(sendTurn(service, "u-a", "hi", child.sessionId), "not_found");
  await expectClientError(service.history("u-a", child.sessionId), "not_found");
  // archived → conflict。
  await expectClientError(sendTurn(service, "u-a", "hi", r2.session_id), "conflict");
  await expectClientError(service.history("u-a", r2.session_id), "conflict");
  // 不存在 → not_found。
  await expectClientError(sendTurn(service, "u-a", "hi", "conv_nope"), "not_found");
  await expectClientError(service.history("u-a", "conv_nope"), "not_found");
  // 健康对话对照组：放行且返回同一 session_id。
  const ok = await sendTurn(service, "u-a", "继续", sid);
  assert.equal(ok.session_id, sid);
});

test("同会话租约被占：send(sessionId) 映射 ChatClientError(conflict)", async (t) => {
  const { service, sessions, faux } = setup(t, []);
  faux.setResponses([fauxAssistantMessage('{"type":"clarify","question":"q"}')]);
  const r1 = await sendTurn(service, "u-a", "先建对话");
  const sid = r1.session_id;

  // 另一写者占住该会话写租约：续写请求应得 409 而非 500。
  const writer = await sessions.acquireLease("u-a", sid, "other-writer", 60_000);
  assert.ok(writer);
  await assert.rejects(sendTurn(service, "u-a", "并发写入", sid), (error) => {
    assert.ok(error instanceof ChatClientError);
    assert.equal(error.code, "conflict");
    return true;
  });
  await sessions.releaseLease(writer, "u-a", sid);
});

test("跨对话长期记忆：对话 1 确认行程 close 蒸馏后，新对话自动注入记忆", async (t) => {
  const ev1 = makeEvent("evt_1");
  const faux = createFauxCore({});
  const doc = "## 用户\n常驻西安\n\n## 偏好\n喜欢展览\n\n## 足迹\n2026-11-14 看展行程\n";
  const { streamFn: base, distill } = makeStreamFn(faux, undefined, [
    fauxAssistantMessage(doc),
  ]);
  // 记录每次正常会话请求看到的 memory_context（蒸馏/摘要旁路不计）。
  const seenMemory: (string | null | undefined)[] = [];
  const streamFn: StreamFn = (model, context, options) => {
    if (!isDistillRequest(context)) {
      const system = context.messages.find((m) => m.role === "system") as
        | SystemMessage
        | undefined;
      seenMemory.push(system?.sections?.["memory_context"] ?? null);
    }
    return base(model, context, options);
  };
  const { service, sessions } = setup(t, [ev1], { streamFn });

  const plan: Itinerary = {
    date: DAY1,
    summary: "看展行程",
    stops: [stop("evt_1", "10:00", "11:00")],
  };
  faux.setResponses([
    fauxAssistantMessage(envelope(plan, { date: DAY1 })),
    fauxAssistantMessage('{"type":"clarify","question":"去哪？"}'),
  ]);

  // 对话 1：确认行程 → plan 标注 → close 即触发后台蒸馏。
  const r1 = await sendTurn(service, "u-m", "帮我安排行程");
  assert.equal(r1.kind, "plans");
  assert.equal(seenMemory[0], null); // 蒸馏前：首轮请求无 memory_context
  const deadline = Date.now() + 5_000;
  while ((await sessions.getUserMemory("u-m")) === undefined) {
    assert.ok(Date.now() < deadline, "close 的后台蒸馏应写出 user_memory");
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(distill.calls(), 1);
  const memory = await sessions.getUserMemory("u-m");
  assert.match(memory?.content ?? "", /常驻西安/);

  // 对话 2（不传 session_id 的新对话）：首轮模型请求即带上蒸馏出的记忆。
  const r2 = await sendTurn(service, "u-m", "明天再出门");
  assert.equal(r2.kind, "clarification");
  assert.notEqual(r2.session_id, r1.session_id);
  assert.equal(seenMemory.length, 2);
  assert.match(seenMemory[1] ?? "", /常驻西安/);
});

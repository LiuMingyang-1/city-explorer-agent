/**
 * Web ChatService 离线测试（history + 真实持久链路）：
 * faux 模型 → 真实 createPersistentPlanner → 真实 :memory: 会话库 →
 * 真实校验与指针提交。覆盖多轮顺序、修改、隔离、失败/工具消息过滤。
 * send 路径的工厂/关闭语义见 web-service.test.ts。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { EventRepository } from "../src/data/repository.ts";
import type { Event } from "../src/data/types.ts";
import type { Itinerary } from "../src/itinerary/types.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";
import { ChatServiceError, createChatService } from "../src/web/service.ts";
import type { ChatResult } from "../src/web/types.ts";
import { BASE, CONFIG, DAY1, envelope, makeStreamFn } from "./e2e-fixture.ts";

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
function setup(t: TestContext, events: Event[]) {
  const sessions = createSqliteSessionRepository(":memory:");
  t.after(() => sessions.close());
  const faux = createFauxCore({});
  const { streamFn } = makeStreamFn(faux);
  const service = createChatService({
    config: CONFIG,
    repository: fakeRepo(events),
    sessions,
    streamFn,
    currentDate: BASE,
  });
  return { service, sessions, faux };
}

test("空用户 history：幂等建 user+主会话，空消息、itinerary 为 null", async (t) => {
  const { service, sessions } = setup(t, []);
  const h1 = await service.history("u-new");
  assert.deepEqual(h1.messages, []);
  assert.equal(h1.itinerary, null);
  assert.equal(h1.events, undefined);
  const h2 = await service.history("u-new");
  assert.deepEqual(h2, h1);
  const user = await sessions.getUser("u-new");
  const main = await sessions.getMainSession("u-new");
  assert.equal(main.sessionId, user?.mainSessionId); // 两次 history 同一主会话
});

test("澄清轮：send 返回 clarification；history 按顺序还原 user+assistant，无行程", async (t) => {
  const { service, faux } = setup(t, []);
  faux.setResponses([fauxAssistantMessage('{"type":"clarify","question":"哪天去？"}')]);
  const result = await service.send("u-a", "帮我安排");
  assert.deepEqual(result, { kind: "clarification", question: "哪天去？" });
  const h = await service.history("u-a");
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
  const result = await service.send("u-a", "安排一下");
  assert.equal(result.kind, "itinerary");
  if (result.kind !== "itinerary") return;
  assert.deepEqual(
    result.events.map((e) => e.event_id),
    ["evt_2", "evt_1"],
  );
  assert.equal(result.events[0].venue_name, "场馆evt_2");
  assert.equal(result.events[0].latitude, ev2.latitude);

  // planner 已关闭：会话写租约释放（不残留 owner）。
  const main = await sessions.getMainSession("u-a");
  const session = await sessions.getSession("u-a", main.sessionId);
  assert.equal(session?.leaseOwner, null);

  const h = await service.history("u-a");
  assert.deepEqual(h.messages, [{ role: "user", text: "安排一下" }]); // 无重复 assistant 卡片
  assert.deepEqual(h.itinerary, result.itinerary);
  assert.deepEqual(h.events, result.events);
});

test("多轮：澄清 → 行程 → 修改行程，历史顺序完整、被替换行程摘要保留、当前行程独立", async (t) => {
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
  await service.send("u-a", "想出门");
  const r2 = await service.send("u-a", "14 号");
  const r3 = await service.send("u-a", "再加一站"); // 每次 send 重开持久会话（同 user 重开）
  assert.equal(r2.kind, "itinerary");
  assert.equal(r3.kind, "itinerary");

  const h = await service.history("u-a");
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
  const r1 = await service.send("u-a", "想看展");
  assert.equal(r1.kind, "clarification");
  await assert.rejects(service.send("u-a", "随便"), ChatServiceError);

  const h = await service.history("u-a");
  // 只剩第一轮的 user+question：工具调用、纠错消息、失败 run 的输入全部不可见。
  assert.deepEqual(h.messages, [
    { role: "user", text: "想看展" },
    { role: "assistant", text: "预算多少？" },
  ]);
  assert.equal(h.itinerary, null);
});

test("不同 user 隔离：u-b 看不到 u-a 的消息与行程", async (t) => {
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
  const ra = await service.send("u-a", "安排");
  const hA = await service.history("u-a");
  const hB = await service.history("u-b");
  assert.deepEqual(hB.messages, []);
  assert.equal(hB.itinerary, null);
  assert.ok(hA.messages.length > 0 && hA.itinerary !== null);

  const rb: ChatResult = await service.send("u-b", "我也想去");
  assert.deepEqual(rb, { kind: "clarification", question: "u-b 想去哪？" });
  const hB2 = await service.history("u-b");
  assert.deepEqual(hB2.messages, [
    { role: "user", text: "我也想去" },
    { role: "assistant", text: "u-b 想去哪？" },
  ]);
  assert.deepEqual(ra.kind, "itinerary");
});

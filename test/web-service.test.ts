/**
 * Web ChatService 离线测试（send 路径）：注入 stub planner 工厂，
 * 不打模型、不开库——验证 send 的工厂接线、契约映射、错误与关闭语义。
 * history 重建与真实持久链路见 web-service-history.test.ts。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PersistentPlannerOptions,
  PlannerPromptOptions,
  PlannerTurn,
} from "../src/agent/session.ts";
import type { ExplorerConfig } from "../src/config.ts";
import type { EventRepository } from "../src/data/repository.ts";
import type { Event } from "../src/data/types.ts";
import type { Itinerary } from "../src/itinerary/types.ts";
import type { SessionRepository } from "../src/session/repository.ts";
import type { Run } from "../src/session/types.ts";
import { ChatServiceError, createChatService } from "../src/web/service.ts";
import type { ChatPlanner } from "../src/web/service.ts";

const CONFIG: ExplorerConfig = {
  provider: "openai",
  model: "gpt-5.4",
  apiKey: "k",
  contextWindow: 128_000,
  maxTokens: 4096,
  dbPath: "unused.db",
};

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
    startAt: "2026-11-14T09:00",
    endAt: "2026-11-14T18:00",
    suggestedDurationMinutes: 90,
    budgetMin: 0,
    budgetMax: 5000,
    currency: "CNY",
    budgetNote: null,
    guideUrl: null,
    thumbnailUrl: "https://img.example/t.png",
    imageUrls: ["https://img.example/1.png"],
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

interface StubCalls {
  opens: number;
  closes: number;
  cancels: number;
  prompts: string[];
  promptOptions: (PlannerPromptOptions | undefined)[];
  options: PersistentPlannerOptions[];
}

/** stub planner 工厂：记录开/关/取消/调用，prompt 行为由测试脚本决定。 */
function stubFactory(script: (text: string) => Promise<PlannerTurn> | PlannerTurn) {
  const calls: StubCalls = {
    opens: 0,
    closes: 0,
    cancels: 0,
    prompts: [],
    promptOptions: [],
    options: [],
  };
  const createPlanner = async (o: PersistentPlannerOptions): Promise<ChatPlanner> => {
    calls.opens += 1;
    calls.options.push(o);
    return {
      async prompt(text, options) {
        calls.prompts.push(text);
        calls.promptOptions.push(options);
        return script(text);
      },
      cancel() {
        calls.cancels += 1;
      },
      async close() {
        calls.closes += 1;
      },
    };
  };
  return { createPlanner, calls };
}

/** 可控 promise：供"在途"场景精确控制 settle 时机。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让出事件循环，给 promise 链若干 settle 机会。 */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const SESSIONS = {} as SessionRepository; // send 路径只把它透传给工厂

test("send 澄清透传；工厂拿到 config/repository/sessions/userId，planner 用后关闭", async () => {
  const repository = fakeRepo([]);
  const { createPlanner, calls } = stubFactory(() => ({
    kind: "clarification",
    question: "哪天去？",
  }));
  const service = createChatService({
    config: CONFIG,
    repository,
    sessions: SESSIONS,
    createPlanner,
  });
  const result = await service.send("u-web", "  帮我安排  ");
  assert.deepEqual(result, { kind: "clarification", question: "哪天去？" });
  assert.equal(calls.opens, 1);
  assert.equal(calls.closes, 1);
  assert.equal(calls.cancels, 0); // 正常完成不误 cancel
  assert.deepEqual(calls.prompts, ["  帮我安排  "]); // service 不 trim，HTTP 层已裁
  const passed = calls.options[0];
  assert.equal(passed.config, CONFIG);
  assert.equal(passed.repository, repository);
  assert.equal(passed.sessions, SESSIONS);
  assert.equal(passed.userId, "u-web");
});

test("send 带 location：planner.prompt 收到 {location}；不带则 options 无坐标", async () => {
  const { createPlanner, calls } = stubFactory(() => ({
    kind: "clarification",
    question: "q",
  }));
  const service = createChatService({
    config: CONFIG,
    repository: fakeRepo([]),
    sessions: SESSIONS,
    createPlanner,
  });
  await service.send("u-web", "附近逛逛", { location: { lat: 34.27, lng: 108.95 } });
  assert.deepEqual(calls.promptOptions[0], { location: { lat: 34.27, lng: 108.95 } });
  await service.send("u-web", "hi"); // 不带位置：prompt options 无坐标
  assert.equal(calls.promptOptions[1]?.location, undefined);
  assert.equal(calls.closes, 2);
});

test("send 行程：返回完整 itinerary + 按 stops 顺序去重、缺库跳过的 EventView", async () => {
  const ev1 = makeEvent("evt_1");
  const ev2 = makeEvent("evt_2", { budgetMin: null, budgetMax: null, budgetNote: "押金", guideUrl: "https://g.example" });
  const itinerary: Itinerary = {
    date: "2026-11-14",
    summary: "双站",
    stops: [
      { event_id: "evt_2", arrive_at: "10:00", leave_at: "11:00", reason: "r2" },
      { event_id: "evt_1", arrive_at: "12:00", leave_at: "13:00", reason: "r1" },
      { event_id: "evt_2", arrive_at: "14:00", leave_at: "15:00", reason: "dup" },
      { event_id: "evt_gone", arrive_at: "16:00", leave_at: "17:00", reason: "missing" },
    ],
  };
  const { createPlanner } = stubFactory(() => ({
    kind: "itinerary",
    itinerary,
    constraints: { date: "2026-11-14" },
  }));
  const service = createChatService({
    config: CONFIG,
    repository: fakeRepo([ev1, ev2]),
    sessions: SESSIONS,
    createPlanner,
  });
  const result = await service.send("u-web", "安排一下");
  assert.equal(result.kind, "itinerary");
  if (result.kind !== "itinerary") return;
  assert.equal(result.itinerary, itinerary); // 完整对象原样返回
  assert.deepEqual(
    result.events.map((e) => e.event_id),
    ["evt_2", "evt_1"], // stops 顺序、去重、缺库跳过
  );
  const view = result.events[0];
  assert.equal(view.event_id, "evt_2");
  assert.equal(view.venue_name, "场馆evt_2");
  assert.equal(view.latitude, 34.3);
  assert.equal(view.longitude, 108.9);
  assert.equal(view.start_at, "2026-11-14T09:00");
  assert.equal(view.end_at, "2026-11-14T18:00");
  assert.equal(view.suggested_duration_minutes, 90);
  assert.equal(view.budget_min, null);
  assert.equal(view.budget_note, "押金");
  assert.equal(view.guide_url, "https://g.example");
  // 只公开 EventView 列出的展示字段：存储层的 camelCase 键不外漏。
  for (const key of Object.keys(view)) {
    assert.match(key, /^[a-z_]+$/);
    assert.ok(!["id", "venueName", "startAt", "endAt", "imageUrls"].includes(key));
  }
  assert.deepEqual(result.events[1].image_urls, ["https://img.example/1.png"]);
});

test("send error turn → 抛 ChatServiceError，planner 仍关闭", async () => {
  const { createPlanner, calls } = stubFactory(() => ({
    kind: "error",
    message: "行程未通过校验：未知活动 evt_nope",
  }));
  const service = createChatService({
    config: CONFIG,
    repository: fakeRepo([]),
    sessions: SESSIONS,
    createPlanner,
  });
  await assert.rejects(service.send("u-web", "hi"), (error) => {
    assert.ok(error instanceof ChatServiceError);
    assert.match(error.message, /evt_nope/);
    return true;
  });
  assert.equal(calls.closes, 1);
});

test("prompt 本身抛错 → 异常传播且 close 仍被调用", async () => {
  const { createPlanner, calls } = stubFactory(async () => {
    throw new Error("模型服务 503");
  });
  const service = createChatService({
    config: CONFIG,
    repository: fakeRepo([]),
    sessions: SESSIONS,
    createPlanner,
  });
  await assert.rejects(service.send("u-web", "hi"), /模型服务 503/);
  assert.equal(calls.closes, 1);
});

test("同 user 每次 send 开新 planner；不同 user 各自独立", async () => {
  const { createPlanner, calls } = stubFactory(() => ({
    kind: "clarification",
    question: "q",
  }));
  const service = createChatService({
    config: CONFIG,
    repository: fakeRepo([]),
    sessions: SESSIONS,
    createPlanner,
  });
  await service.send("u-a", "m1");
  await service.send("u-a", "m2");
  await service.send("u-b", "m3");
  assert.equal(calls.opens, 3);
  assert.equal(calls.closes, 3);
  assert.deepEqual(
    calls.options.map((o) => o.userId),
    ["u-a", "u-a", "u-b"],
  );
});

test("已 aborted 的 signal：不开 planner、不启动模型，直接拒 AbortError", async () => {
  const { createPlanner, calls } = stubFactory(() => {
    throw new Error("不应被调用");
  });
  const service = createChatService({
    config: CONFIG,
    repository: fakeRepo([]),
    sessions: SESSIONS,
    createPlanner,
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.send("u-web", "hi", { signal: controller.signal }), (error) => {
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
  assert.equal(calls.opens, 0);
  assert.equal(calls.prompts.length, 0);
});

test("处理中 signal abort：调 planner.cancel，prompt settle 后 close 且抛 AbortError", async () => {
  const pending = deferred<PlannerTurn>();
  const { createPlanner, calls } = stubFactory(() => pending.promise);
  const service = createChatService({
    config: CONFIG,
    repository: fakeRepo([]),
    sessions: SESSIONS,
    createPlanner,
  });
  const controller = new AbortController();
  const sent = service.send("u-web", "hi", { signal: controller.signal });
  await tick();
  assert.equal(calls.prompts.length, 1);

  controller.abort(); // HTTP 层传下来的中止信号
  await tick();
  assert.equal(calls.cancels, 1);
  assert.equal(calls.closes, 0); // prompt 未 settle 前不能 close

  // prompt 真正 settle（即便迟到 itinerary 结果也丢弃）→ close 收尾 → AbortError。
  pending.resolve({
    kind: "itinerary",
    itinerary: { date: "2026-11-14", summary: "s", stops: [] },
    constraints: { date: "2026-11-14" },
  });
  await assert.rejects(sent, (error) => {
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
  assert.equal(calls.closes, 1);
});

test("send 之后 abort 不再影响已完成的请求", async () => {
  const { createPlanner, calls } = stubFactory(() => ({
    kind: "clarification",
    question: "q",
  }));
  const service = createChatService({
    config: CONFIG,
    repository: fakeRepo([]),
    sessions: SESSIONS,
    createPlanner,
  });
  const controller = new AbortController();
  const result = await service.send("u-web", "hi", { signal: controller.signal });
  assert.equal(result.kind, "clarification");
  controller.abort(); // 事后 abort：listener 已摘除，无影响
  await tick();
  assert.equal(calls.cancels, 0);
});

test("shutdown：取消在途 send 并等 settle+close，等在途 history，之后拒新请求", async () => {
  const pendingTurn = deferred<PlannerTurn>();
  const pendingRuns = deferred<Run[]>();
  const sessions = {
    // history 走到 listRunsBySession 时被吊住，制造可控在途读。
    createUser: async (input: { userId?: string }) => ({
      userId: input.userId ?? "u",
      mainSessionId: "s1",
      displayName: null,
      createdAt: "t",
      updatedAt: "t",
    }),
    getMainSession: async (userId: string) => ({
      sessionId: "s1",
      userId,
      kind: "main",
      parentSessionId: null,
      title: null,
      status: "active",
      currentItineraryRecordId: null,
      leaseOwner: null,
      leaseEpoch: 0,
      leaseExpiresAt: null,
      lastActivityAt: "t",
      createdAt: "t",
      updatedAt: "t",
    }),
    listRunsBySession: () => pendingRuns.promise,
    getCurrentItinerary: async () => undefined,
    close() {},
  } as unknown as SessionRepository;
  const { createPlanner, calls } = stubFactory(() => pendingTurn.promise);
  const service = createChatService({
    config: CONFIG,
    repository: fakeRepo([]),
    sessions,
    createPlanner,
  });

  const sent = service.send("u-a", "hi");
  const read = service.history("u-a");
  await tick();
  assert.equal(calls.prompts.length, 1);

  let finished = false;
  const down = service.shutdown().then(() => {
    finished = true;
  });
  await tick();
  // 两个在途都被等待：send 被 cancel 但 prompt 未 settle、history 卡在读取。
  assert.equal(calls.cancels, 1);
  assert.equal(finished, false);

  pendingRuns.resolve([]); // history 放行
  await tick();
  assert.equal(finished, false); // send 仍未收尾，shutdown 不提前完成

  pendingTurn.resolve({ kind: "error", message: "运行被取消" });
  await assert.rejects(sent, (error) => {
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
  await assert.doesNotReject(read);
  await down;
  assert.equal(finished, true);
  assert.equal(calls.closes, 1); // send 的 planner 已 close，租约/run 收尾完成

  // shutdown 之后的新请求一律被拒，不再触达依赖。
  await assert.rejects(service.send("u-a", "again"), ChatServiceError);
  await assert.rejects(service.history("u-a"), ChatServiceError);
  assert.equal(calls.opens, 1);
  // 幂等：重复 shutdown 直接返回。
  await service.shutdown();
});

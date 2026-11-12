/**
 * Web Chat HTTP 层离线测试（身份/路由/契约/错误隔离）。
 * 直接 node --test 可跑；service 全注入，不发模型请求、不开数据库。
 * 请求体校验、大小与 Origin 细则见 web-http-guards.test.ts。
 */
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Itinerary } from "../src/itinerary/types.ts";
import { createChatHandler } from "../src/web/http.ts";
import type { WebChatOptions } from "../src/web/http.ts";
import { ChatClientError } from "../src/web/types.ts";
import type {
  ChatHistory,
  ChatLocation,
  ChatResult,
  ChatService,
  EventView,
} from "../src/web/types.ts";

const ITINERARY: Itinerary = {
  date: "2026-11-14",
  summary: "下午看展",
  stops: [{ event_id: "evt_001", arrive_at: "13:00", leave_at: "14:30", reason: "r" }],
};

/** 线上契约是 snake_case 的 EventView（event_id/venue_name），非存储层 Event。 */
const EVENT: EventView = {
  event_id: "evt_001",
  title: "展览",
  latitude: 34.3,
  longitude: 108.9,
  venue_name: "场馆",
  description: "d",
  address: "a",
  start_at: "2026-11-14T10:00",
  end_at: "2026-11-14T18:00",
  guide_url: null,
  image_urls: [],
};

type SendOptions = {
  signal?: AbortSignal;
  location?: ChatLocation;
  sessionId?: string;
  activePlan?: string;
  referencedEventId?: string;
};
type SendCall = { userId: string; message: string; options?: SendOptions };
type HistoryCall = { userId: string; sessionId?: string };

/** 可注入 service：记录调用，可按测试覆写行为或抛错。 */
function fakeService(
  impl: {
    history?: (userId: string, sessionId?: string) => Promise<ChatHistory>;
    send?: (userId: string, message: string, options?: SendOptions) => Promise<ChatResult>;
  } = {},
): ChatService & { historyCalls: HistoryCall[]; sendCalls: SendCall[] } {
  const svc = {
    historyCalls: [] as HistoryCall[],
    sendCalls: [] as SendCall[],
    async history(userId: string, sessionId?: string): Promise<ChatHistory> {
      svc.historyCalls.push({ userId, sessionId });
      return (
        impl.history?.(userId, sessionId) ?? {
          messages: [
            { role: "user", text: "想看展" },
            { role: "assistant", text: "哪天去？" },
          ],
        }
      );
    },
    async send(userId: string, message: string, options?: SendOptions): Promise<ChatResult> {
      svc.sendCalls.push({ userId, message, options });
      return (
        impl.send?.(userId, message, options) ?? {
          kind: "clarification",
          session_id: "sess_1",
          question: "哪天去？",
        }
      );
    },
    // /api/events 与 /api/memory 的接口占位数（本文件不测这两组路由）。
    async listEvents() {
      return { events: [] };
    },
    async getMemory() {
      return { content: "", updated_at: null };
    },
    async putMemory() {
      return { content: "", updated_at: null };
    },
    async deleteMemory() {},
  };
  return svc;
}

/** 起真实 http server（随机端口），返回 base url 与 close。 */
async function start(
  service: ChatService,
  options?: WebChatOptions,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer(createChatHandler(service, options));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json(): unknown;
}

/** 裸 http.request 发请求（fetch 会藏 set-cookie，测试要断言它）。 */
function call(
  base: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method: init.method ?? "GET", headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          json: () => JSON.parse(body),
        });
      });
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

/** 从 set-cookie 里取 chat_uid 值。 */
function cookieUserId(reply: Reply): string | undefined {
  const setCookie = reply.headers["set-cookie"]?.[0];
  return setCookie ? /chat_uid=([0-9a-f]{32})/.exec(setCookie)?.[1] : undefined;
}

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  call(base, "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });

test("首访 GET /api/chat/history：200 + 随机匿名 cookie，service 拿到同一 userId", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    const reply = await call(base, "/api/chat/history");
    assert.equal(reply.status, 200);
    const setCookie = reply.headers["set-cookie"]?.[0] ?? "";
    assert.match(setCookie, /chat_uid=[0-9a-f]{32}/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\//);
    const uid = cookieUserId(reply);
    assert.equal(svc.historyCalls.length, 1);
    assert.equal(svc.historyCalls[0].userId, uid); // 发给前端的 id 即传给 service 的 id
    assert.equal(svc.historyCalls[0].sessionId, undefined); // 无 session_id 参数
    assert.deepEqual(reply.json(), {
      messages: [
        { role: "user", text: "想看展" },
        { role: "assistant", text: "哪天去？" },
      ],
    });
  } finally {
    await close();
  }
});

test("带同一 cookie 的后续请求保持同一身份，不重发 Set-Cookie", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    const first = await call(base, "/api/chat/history");
    const uid = cookieUserId(first);
    const second = await call(base, "/api/chat/history", {
      headers: { Cookie: `chat_uid=${uid}` },
    });
    assert.equal(second.status, 200);
    assert.equal(svc.historyCalls[1].userId, uid);
    assert.equal(second.headers["set-cookie"], undefined);
  } finally {
    await close();
  }
});

test("形状非法的 cookie 值被拒收，服务端另铸新 id", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    const reply = await call(base, "/api/chat/history", {
      headers: { Cookie: "chat_uid=../../etc/passwd" },
    });
    const uid = cookieUserId(reply);
    assert.match(uid ?? "", /^[0-9a-f]{32}$/);
    assert.equal(svc.historyCalls[0].userId, uid); // 不是客户端给的值
  } finally {
    await close();
  }
});

test("query 里的 userId 不被采信，身份只来自 cookie", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    await call(base, "/api/chat/history?userId=spoofed");
    assert.match(svc.historyCalls[0].userId, /^[0-9a-f]{32}$/);
    assert.notEqual(svc.historyCalls[0].userId, "spoofed");
  } finally {
    await close();
  }
});

test("POST /api/chat：clarification 透传，message 被 trim 后交给 service", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    const reply = await post(base, { message: "  想看展  " });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.json(), {
      kind: "clarification",
      session_id: "sess_1",
      question: "哪天去？",
    });
    assert.equal(svc.sendCalls[0].message, "想看展");
    assert.equal(svc.sendCalls[0].options?.sessionId, undefined); // 未带 session_id
    assert.match(svc.sendCalls[0].userId, /^[0-9a-f]{32}$/);
  } finally {
    await close();
  }
});

test("POST /api/chat：合法 location 随 options 透传给 service；不带则 location 为 undefined", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    const reply = await post(base, {
      message: "附近逛逛",
      location: { lat: 34.27, lng: 108.95 },
    });
    assert.equal(reply.status, 200);
    assert.equal(svc.sendCalls.length, 1);
    assert.deepEqual(svc.sendCalls[0].options?.location, { lat: 34.27, lng: 108.95 });
    assert.ok(svc.sendCalls[0].options?.signal instanceof AbortSignal); // 断连取消信号照常带
    const plain = await post(base, { message: "hi" });
    assert.equal(plain.status, 200);
    assert.equal(svc.sendCalls[1].options?.location, undefined);
  } finally {
    await close();
  }
});

test("POST /api/chat：plans 结果与 history 的 plans/itinerary/events 原样透传", async () => {
  const PLAN = {
    plan_id: "A",
    label: "A" as const,
    title: "下午看展",
    itinerary: ITINERARY,
    legs: [],
    validation: { status: "passed" as const, scope: "inter_stop" as const, issues: [] },
    warnings: [],
  };
  const svc = fakeService({
    async send() {
      return {
        kind: "plans",
        session_id: "sess_9",
        mode: "single",
        active_plan: "A",
        plans: [PLAN],
        events: [EVENT],
        coordinate_system: "GCJ-02",
      };
    },
    async history() {
      return {
        messages: [{ role: "user", text: "hi" }],
        itinerary: ITINERARY,
        plans: [PLAN],
        mode: "comparison",
        active_plan: "B",
        events: [EVENT],
      };
    },
  });
  const { base, close } = await start(svc);
  try {
    const send = await post(base, { message: "安排一下" });
    assert.deepEqual(send.json(), {
      kind: "plans",
      session_id: "sess_9",
      mode: "single",
      active_plan: "A",
      plans: [PLAN],
      events: [EVENT],
      coordinate_system: "GCJ-02",
    });
    const history = await call(base, "/api/chat/history");
    const data = history.json() as ChatHistory;
    assert.deepEqual(data.itinerary, ITINERARY);
    assert.deepEqual(data.plans, [PLAN]);
    assert.equal(data.mode, "comparison");
    assert.equal(data.active_plan, "B");
    assert.deepEqual(data.events, [EVENT]);
  } finally {
    await close();
  }
});

test("方法与路由限制：405 + Allow 与 404", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    const wrongMethod = await call(base, "/api/chat/history", { method: "POST" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, "GET");
    const getOnChat = await call(base, "/api/chat");
    assert.equal(getOnChat.status, 405);
    assert.equal(getOnChat.headers.allow, "POST");
    const del = await call(base, "/api/chat", { method: "DELETE" });
    assert.equal(del.status, 405);
    const notFound = await call(base, "/api/other");
    assert.equal(notFound.status, 404);
    const trailing = await call(base, "/api/chat/history/");
    assert.equal(trailing.status, 404);
    for (const reply of [wrongMethod, getOnChat, notFound]) {
      const body = reply.json() as { error?: unknown };
      assert.equal(typeof body.error, "string");
    }
    assert.equal(svc.historyCalls.length + svc.sendCalls.length, 0);
  } finally {
    await close();
  }
});

test("service 异常 → 500 {error}，异常细节（含伪造 API key）不外泄", async () => {
  const secret = "sk-test-SECRET-key-123";
  const svc = fakeService({
    async history() {
      throw new Error(`model call failed: OPENAI_API_KEY=${secret}`);
    },
    async send() {
      throw new Error(`db down at ${secret}`);
    },
  });
  const errors: unknown[] = [];
  const { base, close } = await start(svc, { onError: (e) => errors.push(e) });
  try {
    const h = await call(base, "/api/chat/history");
    const c = await post(base, { message: "hi" });
    for (const reply of [h, c]) {
      assert.equal(reply.status, 500);
      const body = reply.json() as { error?: unknown };
      assert.equal(typeof body.error, "string");
      assert.ok(!reply.body.includes(secret), "响应不得含密钥/内部细节");
    }
    assert.equal(errors.length, 2); // 细节走 onError 留在服务端
  } finally {
    await close();
  }
});

test("service 返回契约外形状 → 500 而非透传", async () => {
  const svc = fakeService({
    async send() {
      return { kind: "weird" } as unknown as ChatResult;
    },
  });
  const { base, close } = await start(svc, { onError: () => {} });
  try {
    const reply = await post(base, { message: "hi" });
    assert.equal(reply.status, 500);
    assert.equal(typeof (reply.json() as { error?: unknown }).error, "string");
  } finally {
    await close();
  }
});

test("service 返回缺 session_id 的结果 → 500（契约外形状不透传）", async () => {
  const svc = fakeService({
    async send() {
      return { kind: "clarification", question: "q" } as unknown as ChatResult;
    },
    async history() {
      return { messages: [] };
    },
  });
  const { base, close } = await start(svc, { onError: () => {} });
  try {
    const reply = await post(base, { message: "hi" });
    assert.equal(reply.status, 500);
    assert.equal(typeof (reply.json() as { error?: unknown }).error, "string");
  } finally {
    await close();
  }
});

test("events 元素必须是 EventView：adapter 透传整条 Event（id/venueName）→ 500", async () => {
  const rawEvent = {
    id: "evt_001",
    venueName: "场馆",
    title: "展览",
    latitude: 34.3,
    longitude: 108.9,
  };
  const svc = fakeService({
    async send() {
      return {
        kind: "itinerary",
        itinerary: ITINERARY,
        events: [rawEvent],
      } as unknown as ChatResult;
    },
    async history() {
      return { messages: [], events: [rawEvent] } as unknown as ChatHistory;
    },
  });
  const { base, close } = await start(svc, { onError: () => {} });
  try {
    const send = await post(base, { message: "hi" });
    assert.equal(send.status, 500);
    assert.ok(!send.body.includes("venueName")); // 不透传内部形状
    const history = await call(base, "/api/chat/history");
    assert.equal(history.status, 500);
  } finally {
    await close();
  }
});

test("客户端中断 POST：service.send 收到 options.signal 并随断连触发 abort", async () => {
  let observed: AbortSignal | undefined;
  let entered!: () => void;
  let abortSeen!: () => void;
  const enteredPromise = new Promise<void>((r) => (entered = r));
  const abortSeenPromise = new Promise<void>((r) => (abortSeen = r));
  const svc = fakeService({
    async send(_userId, _message, options) {
      observed = options?.signal;
      entered();
      return new Promise<ChatResult>((resolve) => {
        options?.signal?.addEventListener("abort", () => {
          abortSeen();
          resolve({ kind: "clarification", session_id: "s", question: "cancelled" });
        });
      });
    },
  });
  const { base, close } = await start(svc, { onError: () => {} });
  const req = httpRequest(base + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  req.on("error", () => {}); // 客户端侧 ECONNRESET 是预期行为
  req.end(JSON.stringify({ message: "hi" }));
  await enteredPromise; // 等 service 真正开始处理再断
  req.destroy();
  await abortSeenPromise;
  assert.equal(observed?.aborted, true);
  await close();
});

test("正常完成的 POST 不触发 abort", async () => {
  let observed: AbortSignal | undefined;
  const svc = fakeService({
    async send(_userId, _message, options) {
      observed = options?.signal;
      return { kind: "clarification", session_id: "s", question: "q" };
    },
  });
  const { base, close } = await start(svc);
  try {
    const reply = await post(base, { message: "hi" });
    assert.equal(reply.status, 200);
    await new Promise((r) => setImmediate(r)); // 让 'close' 事件有机会触发
    assert.equal(observed?.aborted, false);
  } finally {
    await close();
  }
});

test("POST /api/chat 带 session_id → 透传 service.send 的 options.sessionId", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    const reply = await post(base, { message: "继续", session_id: "conv_42" });
    assert.equal(reply.status, 200);
    assert.equal(svc.sendCalls[0].options?.sessionId, "conv_42");
    // 响应里的 session_id 由 service 决定并原样透传。
    assert.equal((reply.json() as { session_id?: unknown }).session_id, "sess_1");
  } finally {
    await close();
  }
});

test("POST /api/chat 的 session_id 校验：非字符串/空白/超长一律 400 且不调 service", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    for (const session_id of [123, null, true, {}, [], "", "   ", "x".repeat(129)]) {
      const reply = await post(base, { message: "hi", session_id });
      assert.equal(reply.status, 400, JSON.stringify(session_id));
      assert.equal(typeof (reply.json() as { error?: unknown }).error, "string");
    }
    assert.equal(svc.sendCalls.length, 0);
    // 边界合法值放行：1 与 128 字符。
    for (const session_id of ["s", "x".repeat(128)]) {
      const ok = await post(base, { message: "hi", session_id });
      assert.equal(ok.status, 200);
    }
    assert.equal(svc.sendCalls.length, 2);
  } finally {
    await close();
  }
});

test("GET /api/chat/history?session_id=… → 透传 service.history 的 sessionId", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    const reply = await call(base, "/api/chat/history?session_id=conv_7");
    assert.equal(reply.status, 200);
    assert.equal(svc.historyCalls[0].sessionId, "conv_7");
    // URL 编码值同样按串透传。
    await call(base, `/api/chat/history?session_id=${encodeURIComponent("a/b+c")}`);
    assert.equal(svc.historyCalls[1].sessionId, "a/b+c");
  } finally {
    await close();
  }
});

test("GET /api/chat/history 的 session_id 校验：空/空白/重复/超长一律 400 且不调 service", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    for (const query of [
      "session_id=",
      "session_id=%20%20",
      `session_id=${"x".repeat(129)}`,
      "session_id=a&session_id=b",
    ]) {
      const reply = await call(base, `/api/chat/history?${query}`);
      assert.equal(reply.status, 400, query);
      assert.equal(typeof (reply.json() as { error?: unknown }).error, "string");
    }
    assert.equal(svc.historyCalls.length, 0);
  } finally {
    await close();
  }
});

test("ChatClientError 映射：not_found → 404、conflict → 409，均不记 onError、不泄细节", async () => {
  const secret = "内部会话细节不得外泄";
  const errors: unknown[] = [];
  const svc = fakeService({
    async send(_userId, message) {
      if (message === "404") throw new ChatClientError("not_found", secret);
      if (message === "409") throw new ChatClientError("conflict", secret);
      throw new Error(`boom ${secret}`);
    },
    async history(_userId, sessionId) {
      if (sessionId === "404") throw new ChatClientError("not_found", secret);
      if (sessionId === "409") throw new ChatClientError("conflict", secret);
      throw new Error(`boom ${secret}`);
    },
  });
  const { base, close } = await start(svc, { onError: (e) => errors.push(e) });
  try {
    const postNotFound = await post(base, { message: "404" });
    assert.equal(postNotFound.status, 404);
    assert.deepEqual(postNotFound.json(), { error: "session not found" });
    const postConflict = await post(base, { message: "409" });
    assert.equal(postConflict.status, 409);
    assert.deepEqual(postConflict.json(), { error: "session unavailable" });
    const getNotFound = await call(base, "/api/chat/history?session_id=404");
    assert.equal(getNotFound.status, 404);
    assert.deepEqual(getNotFound.json(), { error: "session not found" });
    const getConflict = await call(base, "/api/chat/history?session_id=409");
    assert.equal(getConflict.status, 409);
    assert.deepEqual(getConflict.json(), { error: "session unavailable" });
    // 其余异常仍是 500 + onError；404/409 一律不触发 onError。
    const internal = await post(base, { message: "500" });
    assert.equal(internal.status, 500);
    assert.equal(errors.length, 1);
    for (const reply of [postNotFound, postConflict, getNotFound, getConflict]) {
      assert.ok(!reply.body.includes(secret));
    }
  } finally {
    await close();
  }
});

test("所有响应带 no-store / JSON content-type / nosniff", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    for (const reply of [
      await call(base, "/api/chat/history"),
      await post(base, { message: "hi" }),
      await call(base, "/nope"),
    ]) {
      assert.equal(reply.headers["cache-control"], "no-store");
      assert.match(reply.headers["content-type"] ?? "", /^application\/json/);
      assert.equal(reply.headers["x-content-type-options"], "nosniff");
    }
  } finally {
    await close();
  }
});

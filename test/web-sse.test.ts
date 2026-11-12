/**
 * POST /api/chat/stream 离线测试：SSE 写出助手单测 + 路由层测试（stub
 * service，不发模型请求、不开库）。
 * 覆盖：meta→progress*→result|error 事件序列、SSE 头、心跳开/关、
 * 背压排水、断连 abort、与 /api/chat 完全相同的请求守卫。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Itinerary } from "../src/itinerary/types.ts";
import { createChatHandler } from "../src/web/http.ts";
import type { WebChatOptions } from "../src/web/http.ts";
import { createSseWriter } from "../src/web/sse.ts";
import type { ChatProgress } from "../src/web/sse.ts";
import { ChatClientError } from "../src/web/types.ts";
import type {
  ChatHistory,
  ChatResult,
  ChatService,
  EventView,
} from "../src/web/types.ts";
import type { SendOptions } from "../src/web/service.ts";
import { sleep, until } from "./persistent-fixture.ts";

const ITINERARY: Itinerary = {
  date: "2026-11-14",
  summary: "下午看展",
  stops: [{ event_id: "evt_001", arrive_at: "13:00", leave_at: "14:30", reason: "r" }],
};

const EVENT: EventView = {
  event_id: "evt_001",
  title: "展览",
  latitude: 34.3,
  longitude: 108.9,
  venue_name: "场馆",
};

const RESULT: ChatResult = {
  kind: "plans",
  session_id: "sess_1",
  mode: "single",
  active_plan: "A",
  plans: [
    {
      plan_id: "A",
      label: "A",
      title: ITINERARY.summary,
      itinerary: ITINERARY,
      legs: [],
      validation: { status: "passed", scope: "inter_stop", issues: [] },
      warnings: [],
    },
  ],
  events: [EVENT],
  coordinate_system: "GCJ-02",
};

const PROGRESS_SEARCH: ChatProgress = {
  stage: "searching_events",
  message: "正在检索活动",
  plan_ids: [],
};
const PROGRESS_EXPLORE: ChatProgress = {
  stage: "exploring_plans",
  message: "正在并行探路方案 A 与方案 B",
  plan_ids: ["A", "B"],
};

// ---- SSE 帧解析 ----

interface SseFrame {
  event: string;
  data: unknown;
}

/** 把 SSE 响应体拆成事件帧与注释帧数。 */
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

// ---- createSseWriter 单测（FakeRes 只需实现 writer 用到的最小面） ----

class FakeRes extends EventEmitter {
  chunks: string[] = [];
  ended = false;
  destroyed = false;
  /** true 时 write 一律回 false，直到测试手动 emit("drain")。 */
  throttle = false;
  get writableEnded() {
    return this.ended;
  }
  write(chunk: string): boolean {
    if (this.destroyed) throw new Error("write after destroy");
    this.chunks.push(chunk);
    return !this.throttle;
  }
  end(): this {
    this.ended = true;
    this.emit("close");
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

/** 等 writer 的异步写出链排空。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("sse writer：event/data 帧按序写出，end() 排空后收尾且幂等", async () => {
  const res = new FakeRes();
  const sse = createSseWriter(res as never, { heartbeatMs: 0 });
  sse.send("meta", { session_id: "s1" });
  sse.send("progress", { stage: "searching_events", message: "m", plan_ids: [] });
  sse.comment("ping");
  sse.send("result", RESULT);
  sse.end();
  sse.end(); // 幂等
  await flush();
  assert.equal(
    res.chunks.join(""),
    'event: meta\ndata: {"session_id":"s1"}\n\n' +
      'event: progress\ndata: {"stage":"searching_events","message":"m","plan_ids":[]}\n\n' +
      ": ping\n\n" +
      `event: result\ndata: ${JSON.stringify(RESULT)}\n\n`,
  );
  assert.equal(res.ended, true);
  sse.send("meta", { session_id: "too-late" }); // 收尾后被忽略
  await flush();
  assert.equal(res.chunks.filter((c) => c.includes("too-late")).length, 0);
});

test("sse writer：心跳可关——heartbeatMs 触发 : ping，0 完全不发", async () => {
  const res = new FakeRes();
  const sse = createSseWriter(res as never, { heartbeatMs: 10 });
  await sleep(35);
  assert.ok(res.chunks.filter((c) => c === ": ping\n\n").length >= 2);
  sse.end();

  const res2 = new FakeRes();
  const sse2 = createSseWriter(res2 as never, { heartbeatMs: 0 });
  await sleep(30);
  assert.equal(res2.chunks.filter((c) => c === ": ping\n\n").length, 0);
  sse2.end();
});

test("sse writer：背压——write 回 false 时等 drain 再写后续帧", async () => {
  const res = new FakeRes();
  const sse = createSseWriter(res as never, { heartbeatMs: 0 });
  sse.send("meta", { session_id: "s1" });
  await flush();
  assert.equal(res.chunks.length, 1);

  res.throttle = true;
  sse.send("progress", PROGRESS_SEARCH);
  sse.send("result", RESULT);
  await flush();
  // 第二帧 write 回 false 后进入 drain 等待，第三帧仍排队。
  assert.equal(res.chunks.length, 2);
  res.throttle = false;
  res.emit("drain");
  await flush();
  assert.equal(res.chunks.length, 3);
  sse.end();
  await flush();
  assert.equal(res.ended, true);
});

test("sse writer：断连即标 closed，队列帧与心跳一并丢弃", async () => {
  const res = new FakeRes();
  const sse = createSseWriter(res as never, { heartbeatMs: 10 });
  res.throttle = true;
  sse.send("meta", { session_id: "s1" });
  await flush(); // 首帧已 write（回 false，等 drain），次帧排队
  sse.send("result", RESULT);
  res.destroy(); // 客户端断连
  await flush();
  assert.equal(sse.closed, true);
  assert.equal(res.chunks.length, 1); // 队列里的 result 帧不再写
  res.emit("drain");
  await sleep(25); // 心跳也已停
  assert.equal(res.chunks.length, 1);
  sse.end(); // 断连后 end 不抛
});

// ---- 路由层测试（stub service） ----

type SendCall = { userId: string; message: string; options?: SendOptions };

function fakeService(
  impl: {
    history?: (userId: string, sessionId?: string) => Promise<ChatHistory>;
    send?: (userId: string, message: string, options?: SendOptions) => Promise<ChatResult>;
  } = {},
): ChatService & { sendCalls: SendCall[] } {
  const svc = {
    sendCalls: [] as SendCall[],
    async history(userId: string, sessionId?: string): Promise<ChatHistory> {
      return impl.history?.(userId, sessionId) ?? { messages: [], itinerary: null };
    },
    async send(userId: string, message: string, options?: SendOptions): Promise<ChatResult> {
      svc.sendCalls.push({ userId, message, options });
      return impl.send?.(userId, message, options) ?? RESULT;
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

function call(
  base: string,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      base + path,
      { method: init.method ?? "GET", headers: init.headers },
      (res) => {
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
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

const postStream = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  call(base, "/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });

test("stream 事件序列：meta → progress* → result，SSE 头正确；/api/chat 仍是 JSON", async (t) => {
  const svc = fakeService({
    send: async (_u, _m, options) => {
      options?.onSession?.("sess_1");
      options?.onProgress?.(PROGRESS_SEARCH);
      options?.onProgress?.(PROGRESS_EXPLORE);
      return RESULT;
    },
  });
  const { base, close } = await start(svc, { sseHeartbeatMs: 0 });
  t.after(close);

  const reply = await postStream(base, { message: "hi" });
  assert.equal(reply.status, 200);
  assert.match(reply.headers["content-type"] ?? "", /^text\/event-stream/);
  assert.equal(reply.headers["cache-control"], "no-store");
  const { frames, comments } = parseSse(reply.body);
  assert.equal(comments, 0); // 心跳关闭 → 无 ping
  assert.deepEqual(
    frames.map((f) => f.event),
    ["meta", "progress", "progress", "result"],
  );
  assert.deepEqual(frames[0].data, { session_id: "sess_1" });
  assert.deepEqual(frames[1].data, PROGRESS_SEARCH);
  assert.deepEqual(frames[2].data, PROGRESS_EXPLORE);
  assert.deepEqual(frames[3].data, RESULT);

  // 旧端点不变：同样请求体回 JSON。
  const json = await call(base, "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(json.status, 200);
  assert.match(json.headers["content-type"] ?? "", /application\/json/);
  assert.deepEqual(json.json(), RESULT);
});

test("service 不回调 onSession 时，meta 仍先于 result 发出（取 result.session_id）", async (t) => {
  const svc = fakeService(); // 默认实现不回调任何观察钩子
  const { base, close } = await start(svc, { sseHeartbeatMs: 0 });
  t.after(close);

  const reply = await postStream(base, { message: "hi" });
  const { frames } = parseSse(reply.body);
  assert.deepEqual(
    frames.map((f) => f.event),
    ["meta", "result"],
  );
  assert.deepEqual(frames[0].data, { session_id: "sess_1" });
});

test("error 事件：ChatClientError 如实分类；内部错误记 onError 且不外泄", async (t) => {
  const seen: unknown[] = [];
  const svc = fakeService({
    send: async (_u, _m, options) => {
      options?.onSession?.("sess_1");
      options?.onProgress?.(PROGRESS_SEARCH);
      throw new ChatClientError("conflict", "会话已归档");
    },
  });
  const { base, close } = await start(svc, {
    sseHeartbeatMs: 0,
    onError: (e) => seen.push(e),
  });
  t.after(close);

  const reply = await postStream(base, { message: "hi" });
  const { frames } = parseSse(reply.body);
  // 归档是终态：retryable=false；客户端语义错误不记 onError。
  assert.deepEqual(frames.map((f) => f.event), ["meta", "progress", "error"]);
  assert.deepEqual(frames[2].data, {
    error: { code: "conflict", message: "session unavailable", retryable: false },
  });
  assert.equal(seen.length, 0);
});

test("error 事件：not_found retryable=false；内部错误 internal_error 且 onError 留细节", async (t) => {
  const seen: unknown[] = [];
  const svc = fakeService({
    send: async (_u, _m, options) => {
      if (options?.sessionId === "sess_gone") throw new ChatClientError("not_found", "会话不存在");
      throw new Error("db connection lost: secret detail");
    },
  });
  const { base, close } = await start(svc, {
    sseHeartbeatMs: 0,
    onError: (e) => seen.push(e),
  });
  t.after(close);

  const nf = await postStream(base, { message: "hi", session_id: "sess_gone" });
  const nfFrames = parseSse(nf.body).frames;
  assert.equal(nfFrames.length, 1);
  assert.deepEqual(nfFrames[0].data, {
    error: { code: "not_found", message: "session not found", retryable: false },
  });
  assert.equal(seen.length, 0);

  const boom = await postStream(base, { message: "hi" });
  const boomFrames = parseSse(boom.body).frames;
  assert.deepEqual(boomFrames.map((f) => f.event), ["error"]);
  assert.deepEqual(boomFrames[0].data, {
    error: { code: "internal_error", message: "internal server error", retryable: false },
  });
  assert.equal(seen.length, 1); // 内部细节留在服务端
});

test("共享校验：stream 与 /api/chat 同套守卫，拒绝时不触达 service", async (t) => {
  const svc = fakeService();
  const { base, close } = await start(svc, { sseHeartbeatMs: 0 });
  t.after(close);

  const badOrigin = await postStream(base, { message: "hi" }, { Origin: "https://evil.example" });
  assert.equal(badOrigin.status, 403);
  const badType = await call(base, "/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "hi",
  });
  assert.equal(badType.status, 415);
  const badJson = await postStream(base, "{not json");
  assert.equal(badJson.status, 400);
  const extraField = await postStream(base, { message: "hi", userId: "spoof" });
  assert.equal(extraField.status, 400);
  const badMethod = await call(base, "/api/chat/stream", { method: "GET" });
  assert.equal(badMethod.status, 405);
  assert.equal(badMethod.headers.allow, "POST");
  const tooLarge = await postStream(base, { message: "x".repeat(20 * 1024) });
  assert.equal(tooLarge.status, 413);
  // 拒绝的响应仍是 JSON 错误体形，不是 SSE。
  for (const r of [badOrigin, badType, badJson, extraField, badMethod]) {
    assert.match(r.headers["content-type"] ?? "", /application\/json/);
  }
  assert.equal(svc.sendCalls.length, 0);
});

test("心跳：sseHeartbeatMs 生效——慢请求期间出现 : ping，0 关闭", async (t) => {
  const svc = fakeService({
    send: async () => {
      await sleep(120);
      return RESULT;
    },
  });
  const { base, close } = await start(svc, { sseHeartbeatMs: 30 });
  t.after(close);
  const reply = await postStream(base, { message: "hi" });
  const { frames, comments } = parseSse(reply.body);
  assert.ok(comments >= 2, `expected >=2 pings, got ${comments}`);
  assert.deepEqual(
    frames.map((f) => f.event),
    ["meta", "result"],
  );

  const off = await start(svc, { sseHeartbeatMs: 0 });
  t.after(off.close);
  const reply2 = await postStream(off.base, { message: "hi" });
  assert.equal(parseSse(reply2.body).comments, 0);
});

test("客户端断连：close → abort 语义与 /api/chat 相同", async (t) => {
  let captured: AbortSignal | undefined;
  let sendSettled = false;
  const svc = fakeService({
    send: (_u, _m, options) =>
      new Promise<ChatResult>((_resolve, reject) => {
        captured = options?.signal;
        options?.signal?.addEventListener(
          "abort",
          () => {
            sendSettled = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  });
  const { base, close } = await start(svc, { sseHeartbeatMs: 0, onError: () => {} });
  t.after(close);

  const req = httpRequest(base + "/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  req.on("error", () => {}); // 断连的 ECONNRESET 是预期
  req.end(JSON.stringify({ message: "hi" }));
  await until(() => captured !== undefined, "send started");
  req.destroy();
  await until(() => captured?.aborted === true && sendSettled, "abort propagated");
});

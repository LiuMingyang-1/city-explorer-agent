/**
 * Web Chat HTTP 层离线测试（请求守卫）：严格 JSON、越权字段、
 * Content-Type、body 上限、Origin 同源检查与 CORS 白名单。
 * 身份/路由/错误隔离见 web-http.test.ts。
 */
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createChatHandler } from "../src/web/http.ts";
import type { WebChatOptions } from "../src/web/http.ts";
import type { ChatResult, ChatService } from "../src/web/types.ts";

/** 可注入 service：记录 send 调用；本文件只关心"有没有被调到、拿到什么"。 */
function fakeService(
  send?: (userId: string, message: string, signal?: AbortSignal) => Promise<ChatResult>,
): ChatService & { sendCalls: { userId: string; message: string }[] } {
  const svc = {
    sendCalls: [] as { userId: string; message: string }[],
    async history() {
      return { messages: [] };
    },
    async send(userId: string, message: string, signal?: AbortSignal): Promise<ChatResult> {
      svc.sendCalls.push({ userId, message });
      return send?.(userId, message, signal) ?? { kind: "clarification", question: "q" };
    },
  };
  return svc;
}

async function start(
  service: ChatService,
  options?: WebChatOptions,
): Promise<{ base: string; origin: string; close: () => Promise<void> }> {
  const server: Server = createServer(createChatHandler(service, options));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return { base, origin: base, close: () => new Promise<void>((r) => server.close(() => r())) };
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

function post(
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return call(base, "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
}

const expect400 = async (reply: Promise<Reply>, svc: { sendCalls: unknown[] }) => {
  const r = await reply;
  assert.equal(r.status, 400);
  assert.equal(typeof (r.json() as { error?: unknown }).error, "string");
  assert.equal(svc.sendCalls.length, 0);
};

test("严格 {message}：多余字段（userId/messages 等越权字段）一律 400 且不调 service", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    await expect400(post(base, { message: "hi", userId: "spoofed" }), svc);
    await expect400(post(base, { message: "hi", messages: [{ role: "user", text: "x" }] }), svc);
    await expect400(post(base, {}), svc);
    await expect400(post(base, { message: "a", itinerary: {} }), svc);
  } finally {
    await close();
  }
});

test("坏 JSON 与非对象 JSON → 400", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    for (const body of ["{not json", "", "   ", "[1,2]", '"str"', "42", "null"]) {
      await expect400(post(base, body), svc);
    }
  } finally {
    await close();
  }
});

test("message 长度：空白/超长 400，边界 1 与 1000 字放行", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    await expect400(post(base, { message: "" }), svc);
    await expect400(post(base, { message: "   \n\t  " }), svc);
    await expect400(post(base, { message: 123 }), svc);
    await expect400(post(base, { message: "x".repeat(1001) }), svc);
    const one = await post(base, { message: "好" });
    assert.equal(one.status, 200);
    const max = await post(base, { message: "字".repeat(1000) });
    assert.equal(max.status, 200);
    assert.equal(svc.sendCalls.length, 2);
  } finally {
    await close();
  }
});

test("Content-Type 必须是 JSON：缺失/非 JSON → 415，带 charset 放行", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    const plain = await post(base, { message: "hi" }, { "Content-Type": "text/plain" });
    assert.equal(plain.status, 415);
    const missing = await call(base, "/api/chat", { method: "POST", body: "{}" });
    assert.equal(missing.status, 415);
    const withCharset = await post(
      base,
      { message: "hi" },
      { "Content-Type": "application/json; charset=utf-8" },
    );
    assert.equal(withCharset.status, 200);
    assert.equal(svc.sendCalls.length, 1);
  } finally {
    await close();
  }
});

test("body 超过 16 KiB → 413（含 chunked 无 Content-Length 情形）", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    const big = JSON.stringify({ message: "x".repeat(17 * 1024) });
    const declared = await post(base, big);
    assert.equal(declared.status, 413);
    const chunked = await new Promise<Reply>((resolve, reject) => {
      const req = httpRequest(
        base + "/api/chat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
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
      req.write(big.slice(0, 9000));
      req.write(big.slice(9000));
      req.end();
    });
    assert.equal(chunked.status, 413);
    assert.equal(svc.sendCalls.length, 0);
    // 超限后连接仍可复用（body 被 drain）：同一 server 继续正常服务。
    const ok = await post(base, { message: "hi" });
    assert.equal(ok.status, 200);
  } finally {
    await close();
  }
});

test("Origin：无头放行（非浏览器），同源放行，异源/非法 403 且不调 service", async () => {
  const svc = fakeService();
  const { base, origin, close } = await start(svc);
  try {
    const noOrigin = await post(base, { message: "hi" });
    assert.equal(noOrigin.status, 200);
    const sameOrigin = await post(base, { message: "hi" }, { Origin: origin });
    assert.equal(sameOrigin.status, 200);
    for (const bad of ["https://evil.example", "null", "not a url", "http://127.0.0.1:1"]) {
      const r = await post(base, { message: "hi" }, { Origin: bad });
      assert.equal(r.status, 403, bad);
    }
    assert.equal(svc.sendCalls.length, 2);
  } finally {
    await close();
  }
});

test("Origin 严格比较 scheme+host+端口：https 同 host、异端口、非 Origin 形态均 403", async () => {
  const svc = fakeService();
  const { base, origin, close } = await start(svc);
  try {
    const same = await post(base, { message: "hi" }, { Origin: origin });
    assert.equal(same.status, 200);
    const bad = [
      origin.replace("http://", "https://"), // 同 host 不同 scheme ≠ 同源
      "http://127.0.0.1:9", // 异端口 ≠ 同源
      origin + "/", // 尾随斜杠 = 带路径，非 Origin 规范形态
      origin + "/path",
      origin + "?x=1",
      origin.replace("http://", "http://user@"), // userinfo
      origin.replace("http://", "http://user:pw@"),
      origin.replace("http", "HTTP"), // 非规范大小写序列化
      "http://127.0.0.1:9 " + origin, // Origin 列表形态
    ];
    for (const o of bad) {
      const r = await post(base, { message: "hi" }, { Origin: o });
      assert.equal(r.status, 403, o);
    }
    assert.equal(svc.sendCalls.length, 1);
  } finally {
    await close();
  }
});

test("allowedOrigins 白名单：跨源放行并回 CORS 头 + preflight 204；默认无白名单仍 403", async () => {
  const frontend = "http://localhost:5173";
  const svc = fakeService();
  const { base, close } = await start(svc, { allowedOrigins: [frontend] });
  try {
    const r = await post(base, { message: "hi" }, { Origin: frontend });
    assert.equal(r.status, 200);
    assert.equal(r.headers["access-control-allow-origin"], frontend);
    assert.equal(r.headers["access-control-allow-credentials"], "true");
    const pre = await call(base, "/api/chat", {
      method: "OPTIONS",
      headers: {
        Origin: frontend,
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers["access-control-allow-methods"], "POST");
    const evil = await post(base, { message: "hi" }, { Origin: "https://evil.example" });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers["access-control-allow-origin"], undefined);
  } finally {
    await close();
  }
});

test("body 上传中断：不派活给 service、不在死 socket 上写响应、服务继续可用", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc, { onError: () => {} });
  try {
    const req = httpRequest(base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
    });
    req.on("error", () => {}); // 客户端侧中断错误是预期的
    req.write('{"message":"hi"'); // 半个 JSON 就断
    await new Promise((r) => setTimeout(r, 20));
    req.destroy();
    await new Promise((r) => setTimeout(r, 30)); // 给服务端时间走完中断分支
    const ok = await post(base, { message: "hi" });
    assert.equal(ok.status, 200);
    assert.equal(svc.sendCalls.length, 1); // 只有恢复后这一通
  } finally {
    await close();
  }
});

test("非预检 OPTIONS 与未知路径 → 405/404", async () => {
  const svc = fakeService();
  const { base, close } = await start(svc);
  try {
    const opt = await call(base, "/api/chat", { method: "OPTIONS" });
    assert.equal(opt.status, 405);
    const opt404 = await call(base, "/api/else", { method: "OPTIONS" });
    assert.equal(opt404.status, 404);
  } finally {
    await close();
  }
});

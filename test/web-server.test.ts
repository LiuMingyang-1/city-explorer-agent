/**
 * 同源 Web server 组合层离线测试：静态托管白名单、目录越界、方法限制、
 * /api/chat* 代理转发、启动期的活动库检查与 EXPLORER_WEB_* 解析。
 * apiHandler/依赖全注入；不发模型请求、不读 .env、不碰真实 data/*.db。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders, RequestListener, Server } from "node:http";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSqliteEventRepository } from "../src/data/sqlite.ts";
import type { EventRepository } from "../src/data/repository.ts";
import type { Event } from "../src/data/types.ts";
import {
  assertEventsNonEmpty,
  createShutdown,
  createWebServer,
  FRONTEND_ROOT,
  openEventsRepository,
  webListenOptions,
} from "../src/web/server.ts";
import type { ClosableServer } from "../src/web/server.ts";

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json(): unknown;
}

/** 裸 http.request（与 web-http.test.ts 同约定：fetch 会藏 set-cookie）。 */
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

interface ApiCall {
  method?: string;
  url?: string;
  cookie?: string;
  body: string;
}

/** 回显式假 API：记录 method/url/cookie/body 后原样返回，证明请求被完整转发。 */
function echoApi(calls: ApiCall[]): RequestListener {
  return (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      calls.push({
        method: req.method,
        url: req.url,
        cookie: req.headers.cookie,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ echoed: true }));
    });
  };
}

async function start(
  apiHandler: RequestListener,
  options: { staticRoot?: string; onError?: (e: unknown) => void } = {},
): Promise<{ base: string; server: Server; close: () => Promise<void> }> {
  const server = createWebServer({
    apiHandler,
    staticRoot: options.staticRoot ?? FRONTEND_ROOT,
    onError: options.onError,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const unusedApi: RequestListener = (_req, res) => {
  res.writeHead(500).end("api handler should not be called");
};

test("static: index, scripts, styles and nested assets with correct mime", async () => {
  const { base, close } = await start(unusedApi);
  try {
    const index = await call(base, "/");
    assert.equal(index.status, 200);
    assert.match(index.headers["content-type"] ?? "", /^text\/html/);
    assert.match(index.body, /chat\.js/);
    assert.equal(index.headers["x-content-type-options"], "nosniff");

    const chatJs = await call(base, "/chat.js");
    assert.equal(chatJs.status, 200);
    assert.match(chatJs.headers["content-type"] ?? "", /^text\/javascript/);
    assert.match(chatJs.body, /api\/chat/);

    const busted = await call(base, "/app.js?v=backend-chat-1");
    assert.equal(busted.status, 200); // 前端用 ?v= 缓存戳，必须剥离查询串

    const css = await call(base, "/style.css");
    assert.equal(css.status, 200);
    assert.match(css.headers["content-type"] ?? "", /^text\/css/);

    const json = await call(base, "/assets/quiet-map.json");
    assert.equal(json.status, 200);
    assert.match(json.headers["content-type"] ?? "", /^application\/json/);

    const license = await call(base, "/assets/LEAFLET-LICENSE.txt");
    assert.equal(license.status, 200);
    assert.match(license.headers["content-type"] ?? "", /^text\/plain/);
  } finally {
    await close();
  }
});

test("static: HEAD returns headers without body; other methods get 405 + Allow", async () => {
  const { base, close } = await start(unusedApi);
  try {
    const head = await call(base, "/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, "");

    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await call(base, "/", { method, body: "{}" });
      assert.equal(res.status, 405, method);
      assert.equal(res.headers.allow, "GET, HEAD");
    }
  } finally {
    await close();
  }
});

test("static: traversal, symlink escape, non-whitelist ext and dirs all 404", async () => {
  const dir = mkdtempSync(join(tmpdir(), "explorer-web-"));
  try {
    const outside = join(dir, "secret.txt");
    writeFileSync(outside, "top secret");
    const root = join(dir, "public");
    mkdirSync(root);
    // 静态根里放一个指出去的符号链接：realpath 复核必须拦住。
    symlinkSync(outside, join(root, "leak.txt"));
    writeFileSync(join(root, "index.html"), "<h1>ok</h1>");

    const { base, close } = await start(unusedApi, { staticRoot: root });
    try {
      for (const path of [
        "/leak.txt", // 符号链接越界
        "/%2e%2e/secret.txt", // 点段越界（目标真实存在）
        "/%2e%2e%2fsecret.txt", // 编码斜杠变体
        "/..%5csecret.txt", // 反斜杠变体（POSIX 下是普通字符，文件不存在）
        "/../secret.txt", // 未编码点段
        "/index.htmll", // 不存在
        "/secret.txt", // 根外文件即使拼对路径也不在 root 下
        "/", // root 有 index.html → 200，对照组
      ]) {
        const res = await call(base, path);
        if (path === "/") assert.equal(res.status, 200);
        else assert.equal(res.status, 404, path);
      }
    } finally {
      await close();
    }
    // 真实 frontend/：package.json 就在父目录，越界拼它必须 404；
    // README.md 真实存在但 .md 不在白名单，同样 404。
    const real = await start(unusedApi);
    try {
      assert.equal((await call(real.base, "/%2e%2e/package.json")).status, 404);
      assert.equal((await call(real.base, "/README.md")).status, 404);
      assert.equal((await call(real.base, "/assets/")).status, 404); // 目录不是文件
    } finally {
      await real.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/api/chat* proxies to injected handler with url, headers and body intact", async () => {
  const calls: ApiCall[] = [];
  const { base, close } = await start(echoApi(calls));
  try {
    const sent = JSON.stringify({ message: "周六下午想看展" });
    const res = await call(base, "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "chat_uid=abcd" },
      body: sent,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json(), { echoed: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "/api/chat");
    assert.equal(calls[0].cookie, "chat_uid=abcd"); // 匿名身份 cookie 原样透传
    assert.equal(calls[0].body, sent);

    await call(base, "/api/chat/history");
    assert.equal(calls[1].method, "GET");
    assert.equal(calls[1].url, "/api/chat/history");

    // /api/chat 前缀外（含 /api/chatsuffix）的未知路径由协议层自己 404；
    // 组合层只保证它们确实到达了 apiHandler。
    await call(base, "/api/chat/unknown");
    assert.equal(calls[2].url, "/api/chat/unknown");
    await call(base, "/api/chatroom");
    assert.equal(calls[3].url, "/api/chatroom");
  } finally {
    await close();
  }
});

test("non-/api/chat paths never reach the API handler", async () => {
  let reached = 0;
  const counting: RequestListener = (_req, res) => {
    reached += 1;
    res.writeHead(200).end("{}");
  };
  const { base, close } = await start(counting);
  try {
    assert.equal((await call(base, "/api")).status, 404);
    assert.equal((await call(base, "/api/other")).status, 404);
    // /api/chat 前缀命中 → 交协议层判定（假 handler 统一回 200）
    const odd = await call(base, "/api/chatsuffix");
    assert.equal(odd.status, 200);
    assert.equal(reached, 1);
  } finally {
    await close();
  }
});

test("apiHandler exception becomes generic 500 JSON and is reported", async () => {
  const errors: unknown[] = [];
  const boom: RequestListener = () => {
    throw new Error("planner exploded: secret detail");
  };
  const { base, close } = await start(boom, { onError: (e) => errors.push(e) });
  try {
    const res = await call(base, "/api/chat/history");
    assert.equal(res.status, 500);
    assert.deepEqual(res.json(), { error: "internal server error" });
    assert.equal(errors.length, 1); // 细节进 onError，不进响应
    assert.doesNotMatch(res.body, /secret detail/);
  } finally {
    await close();
  }
});

test("startup: missing events db only hints at npm run seed", () => {
  const dir = mkdtempSync(join(tmpdir(), "explorer-web-"));
  try {
    assert.throws(
      () => openEventsRepository({ dbPath: join(dir, "nope", "events.db") }),
      /活动库不存在[\s\S]*npm run seed/,
    );
    // 缺库时绝不自动写库文件
    assert.throws(() => openEventsRepository({ dbPath: join(dir, "nope", "events.db") }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup: empty events db is rejected; closed db propagates the failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "explorer-web-"));
  try {
    const dbPath = join(dir, "events.db");
    const repository = createSqliteEventRepository(dbPath); // 建库+schema，0 行
    await assert.rejects(assertEventsNonEmpty(repository, dbPath), /活动库为空[\s\S]*npm run seed/);
    repository.close();
    // 关库后再探活：底层 sqlite 抛错必须原样冒泡，不能吞。
    await assert.rejects(assertEventsNonEmpty(repository, dbPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup: non-empty events db passes the probe", async () => {
  const event = { id: "evt_1" } as Event;
  const repository: EventRepository = {
    search: () => Promise.resolve([event]),
    getByIds: () => Promise.resolve(new Map()),
    close: () => {},
  };
  await assertEventsNonEmpty(repository, "fake.db");
});

/**
 * 关库顺序：先发起 server.close（记录即证明已停接新连接），再等
 * service.shutdown 结清，连接耗尽后 server close 落地，最后才 closeDbs。
 * 连接先耗尽也不提前关库——必须等在途 Planner.close（service.shutdown 内）。
 */
test("shutdown: server close starts first, dbs close only after service drains", async () => {
  const log: string[] = [];
  let serverCb: ((error?: Error) => void) | undefined;
  const server: ClosableServer = {
    close: (cb) => {
      log.push("server.close:start");
      serverCb = cb;
    },
  };
  let settleShutdown: () => void = () => {};
  const service = {
    shutdown: () =>
      new Promise<void>((resolvePromise) => {
        log.push("service.shutdown:start");
        settleShutdown = () => {
          log.push("service.shutdown:done");
          resolvePromise();
        };
      }),
  };
  const shutdown = createShutdown({
    server,
    service,
    closeDbs: () => {
      log.push("dbs.close");
    },
  });
  const p = shutdown();
  // close() 先于 shutdown() 发起：新连接从此刻起就被拒。
  assert.deepEqual(log, ["server.close:start", "service.shutdown:start"]);
  serverCb!(); // 连接耗尽
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.ok(!log.includes("dbs.close")); // 服务未结清 → 绝不关库
  settleShutdown();
  await p;
  assert.deepEqual(log, [
    "server.close:start",
    "service.shutdown:start",
    "service.shutdown:done",
    "dbs.close",
  ]);
});

/** 真实 server 语义：close() 发起后新连接被拒，在途慢请求被等完后才关库。 */
test("shutdown with real server: stops accepting, drains in-flight before dbs", async () => {
  const log: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  let markStarted: () => void = () => {};
  const sawRequest = new Promise<void>((resolvePromise) => {
    markStarted = resolvePromise;
  });
  const apiHandler: RequestListener = async (_req, res) => {
    markStarted();
    await gate; // 模拟在途慢请求
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  };
  const { base, server } = await start(apiHandler);
  // Connection: close 让响应后 socket 即回收，测试不依赖 keep-alive 超时。
  const inFlight = call(base, "/api/chat", { headers: { Connection: "close" } });
  await sawRequest; // 请求已进 handler——连接算在途，close() 不会拒它
  const shutdown = createShutdown({
    server,
    service: {
      shutdown: async () => {
        log.push("service.shutdown");
        release();
      },
    },
    closeDbs: () => {
      log.push("dbs.close");
    },
  });
  const p = shutdown();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await assert.rejects(call(base, "/")); // 已停接新连接（TCP 层拒）
  const drained = await inFlight; // gate 打开后在途请求正常完成
  assert.equal(drained.status, 200);
  await p;
  assert.deepEqual(log, ["service.shutdown", "dbs.close"]);
});

/** 客户端断连：socket 已死也不影响顺序——关库仍等 service.shutdown 结清。 */
test("shutdown: db close still waits for service after client disconnect", async () => {
  const log: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  let markStarted: () => void = () => {};
  const sawRequest = new Promise<void>((resolvePromise) => {
    markStarted = resolvePromise;
  });
  const apiHandler: RequestListener = async (_req, res) => {
    markStarted();
    await gate;
    res.end("{}");
  };
  const { base, server } = await start(apiHandler);
  const req = httpRequest(base + "/api/chat", { method: "POST" }, () => {});
  req.on("error", () => {}); // 毁 socket 的 ECONNRESET 不归咎于请求本身
  req.end("{}");
  await sawRequest; // 请求已进 handler
  req.destroy(); // 客户端断连（真实装配中 http.ts 还会 abort service.send）
  const shutdown = createShutdown({
    server,
    service: {
      shutdown: async () => {
        log.push("service.shutdown");
        release();
      },
    },
    closeDbs: () => {
      log.push("dbs.close");
    },
  });
  await shutdown();
  assert.deepEqual(log, ["service.shutdown", "dbs.close"]);
});

/** 幂等 + 异常：重复调用同一 Promise 只执行一遍；步骤抛错不跳后续、不重试。 */
test("shutdown is idempotent; a step failure skips nothing and never retries", async () => {
  const log: string[] = [];
  const server: ClosableServer = {
    close: (cb) => {
      log.push("server.close");
      cb?.();
    },
  };
  const service = {
    shutdown: () => {
      log.push("service.shutdown");
      return Promise.reject(new Error("planner still stuck"));
    },
  };
  const shutdown = createShutdown({
    server,
    service,
    closeDbs: () => {
      log.push("dbs.close");
    },
  });
  const first = shutdown();
  assert.strictEqual(shutdown(), first); // 同一 Promise
  await assert.rejects(first, /still stuck/);
  assert.deepEqual(log, ["server.close", "service.shutdown", "dbs.close"]);
  await assert.rejects(shutdown()); // 已结束的同一个 rejected Promise：不重跑
  assert.deepEqual(log, ["server.close", "service.shutdown", "dbs.close"]);
  await createShutdown({})(); // 全部缺省也能安全完成
});

test("webListenOptions: defaults, env overrides and validation", () => {
  const defaults = webListenOptions({});
  assert.equal(defaults.host, "127.0.0.1");
  assert.equal(defaults.port, 8080);
  assert.equal(defaults.staticRoot, FRONTEND_ROOT);
  assert.deepEqual(defaults.allowedOrigins, []);

  const custom = webListenOptions({
    EXPLORER_WEB_HOST: "0.0.0.0",
    EXPLORER_WEB_PORT: "3000",
    EXPLORER_WEB_ALLOWED_ORIGINS: " http://127.0.0.1:5173 ,https://demo.example.com ",
    EXPLORER_WEB_ROOT: "frontend",
  });
  assert.equal(custom.host, "0.0.0.0");
  assert.equal(custom.port, 3000);
  assert.deepEqual(custom.allowedOrigins, ["http://127.0.0.1:5173", "https://demo.example.com"]);

  for (const env of [
    { EXPLORER_WEB_PORT: "abc" },
    { EXPLORER_WEB_PORT: "0" },
    { EXPLORER_WEB_PORT: "65536" },
    { EXPLORER_WEB_PORT: "80.5" },
    { EXPLORER_WEB_ALLOWED_ORIGINS: "not a url" },
    { EXPLORER_WEB_ALLOWED_ORIGINS: "http://a.example.com/path" }, // 带路径不是纯 origin
  ]) {
    assert.throws(() => webListenOptions(env), /EXPLORER_WEB/);
  }
});

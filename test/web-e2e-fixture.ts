import { afterResource } from "./resource-cleanup-fixture.ts";
/**
 * web-e2e-*.test.ts 共用的全链路 fixture；不是测试文件（无 .test 后缀）。
 * 真实 HTTP server → createChatHandler → createChatService → 默认工厂真实
 * createPersistentPlanner → 真实活动 SQLite（临时种子库）+ 真实会话
 * SQLite（临时文件库，可关闭重开）→ HTTP。faux 注入 streamFn：
 * 不打真实模型、不读 .env、不碰仓库 data/。
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingHttpHeaders, Server } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux";
import type { EventRepository } from "../src/data/repository.ts";
import { seedDatabase } from "../src/data/seed.ts";
import { createSqliteEventRepository } from "../src/data/sqlite.ts";
import type { SessionRepository } from "../src/session/repository.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";
import { createChatHandler } from "../src/web/http.ts";
import { createWebServer, listen } from "../src/web/server.ts";
import { createChatService } from "../src/web/service.ts";
import type { ManagedChatService } from "../src/web/service.ts";
import { BASE, CONFIG, makeStreamFn } from "./e2e-fixture.ts";

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json(): unknown;
}

/** 裸 http.request（fetch 会藏 Set-Cookie；与 web-http.test.ts 同约定）。 */
export function call(
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

export const post = (
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> =>
  call(base, "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });

export const withCookie = (uid: string): Record<string, string> => ({
  Cookie: `chat_uid=${uid}`,
});

export const getHistory = (base: string, uid?: string): Promise<Reply> =>
  call(base, "/api/chat/history", uid === undefined ? {} : { headers: withCookie(uid) });

/** 从 Set-Cookie 里取服务端铸的 chat_uid（未签发时为 undefined）。 */
export function cookieUserId(reply: Reply): string | undefined {
  const setCookie = reply.headers["set-cookie"]?.[0];
  return setCookie ? /chat_uid=([0-9a-f]{32})/.exec(setCookie)?.[1] : undefined;
}

/** 异步条件轮询（run 终态/租约释放都在服务端异步收尾）。 */
export async function untilAsync(cond: () => Promise<boolean>, what: string): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > 5_000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface WebStack {
  base: string;
  server: Server;
  service: ManagedChatService;
  sessions: SessionRepository;
  repository: EventRepository;
  faux: ReturnType<typeof createFauxCore>;
  closed: boolean;
}

/** 单个测试的临时目录：活动库/会话库都放这里，绝不写仓库 data/。 */
export function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "explorer-web-e2e-"));
  afterResource(t, () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 在临时目录里写一个种子活动库，返回路径。 */
export function seededEventsPath(dir: string): string {
  const eventsPath = join(dir, "events.db");
  seedDatabase(eventsPath, BASE);
  return eventsPath;
}

/**
 * 与 src/web/main.ts 同接线的整栈（库换成临时文件，模型换 faux）：
 * createWebServer({ apiHandler: createChatHandler(createChatService(...)) })，
 * 监听随机本地端口；t.after 自动幂等收尾。
 */
export async function openWeb(
  t: TestContext,
  options: { eventsPath: string; sessionsPath: string; streamFn?: StreamFn },
): Promise<WebStack> {
  const repository = createSqliteEventRepository(options.eventsPath);
  const sessions = createSqliteSessionRepository(options.sessionsPath);
  const faux = createFauxCore({});
  const service = createChatService({
    config: CONFIG,
    repository,
    sessions,
    streamFn: options.streamFn ?? makeStreamFn(faux).streamFn,
    currentDate: BASE,
  });
  const server = createWebServer({
    apiHandler: createChatHandler(service, { onError: () => {} }),
    onError: () => {},
  });
  await listen(server, "127.0.0.1", 0);
  const { port } = server.address() as AddressInfo;
  const stack: WebStack = {
    base: `http://127.0.0.1:${port}`,
    server,
    service,
    sessions,
    repository,
    faux,
    closed: false,
  };
  afterResource(t, async () => closeWeb(stack));
  return stack;
}

/** 幂等收尾：重开用例会先显式关旧实例，t.after 兜底不再重复关。 */
export async function closeWeb(stack: WebStack): Promise<void> {
  if (stack.closed) return;
  stack.closed = true;
  await new Promise<void>((resolve) => stack.server.close(() => resolve()));
  stack.sessions.close();
  stack.repository.close();
}

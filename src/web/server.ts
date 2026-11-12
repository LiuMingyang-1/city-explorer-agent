/**
 * 同源 Web server 组合层：静态托管 frontend/ + 把 /api/chat* 前缀转给注入的
 * API RequestListener（真实装配在 ./main.ts：createChatHandler(service)）。
 * 本层不 import service/Agent——全部依赖注入 → 可整层离线测试。
 *
 * 静态侧安全边界（思路同 scripts/frontend-dev.mjs，加白名单收紧）：
 * - 只 GET/HEAD；URL 先 decodeURIComponent 再 resolve，结果必须仍在静态根内，
 *   再经 realpath 复核挡符号链接越界；越界/缺失/目录一律 404。
 * - 扩展名白名单（STATIC_MIME）：表外后缀一律 404——即使文件真实存在于
 *   静态根下（如 frontend/README.md，或意外混入的密钥文件）也不出目录。
 * - apiHandler 抛异常且响应未发出时回通用 500，内部细节不外泄。
 */
import { handleAMapNode } from './amap-node.ts';
import type { AMapEnvironment } from './amap.ts';
import { createReadStream, existsSync, realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, RequestListener, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExplorerConfig } from "../config.ts";
import type { EventRepository } from "../data/repository.ts";
import { createSqliteEventRepository } from "../data/sqlite.ts";

/** 默认静态根：仓库内 frontend/（按本文件位置推导，与 cwd 无关）。 */
export const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../frontend");

const TEXTUAL = /\.(?:html|css|js|json|txt|svg)$/;

/** 静态扩展名白名单 → Content-Type；表外后缀按不存在处理（404）。 */
const STATIC_MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

function within(root: string, file: string): boolean {
  return file === root || file.startsWith(root + sep);
}

function respond(
  res: ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(text);
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

/**
 * 静态文件 RequestListener：GET/HEAD 白名单后缀文件；目录越界、符号链接
 * 越界、未知后缀、目录一律 404；其他方法 405 + Allow: GET, HEAD。
 * root 在构造时 realpath——不存在则当场抛错（装配期 fail-fast）。
 */
export function createStaticFileHandler(root: string): RequestListener {
  const base = resolve(root);
  const baseReal = realpathSync(base);
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      respond(res, 405, "method not allowed", { Allow: "GET, HEAD" });
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      respond(res, 404, "not found");
      return;
    }
    const file = resolve(base, `.${pathname === "/" ? "/index.html" : pathname}`);
    const type = STATIC_MIME[extname(file).toLowerCase()];
    if (type === undefined || !within(base, file)) {
      respond(res, 404, "not found");
      return;
    }
    try {
      const real = await realpath(file);
      if (!within(baseReal, real) || !(await stat(real)).isFile()) {
        respond(res, 404, "not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": type + (TEXTUAL.test(file) ? "; charset=utf-8" : ""),
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      if (req.method === "HEAD") res.end();
      else createReadStream(real).on("error", () => res.destroy()).pipe(res);
    } catch {
      respond(res, 404, "not found");
    }
  };
}

export interface WebServerParts {
  mapEnv?: AMapEnvironment;
  mapFetch?: typeof fetch;
  /** /api/chat* 的处理者；真实装配为 createChatHandler(service)。 */
  apiHandler: RequestListener;
  /** 静态根；默认仓库 frontend/。 */
  staticRoot?: string;
  /** apiHandler 未捕获异常回调；细节只留服务端。 */
  onError?: (error: unknown, req: IncomingMessage) => void;
}

/**
 * 同源组合：/api/chat 前缀 → apiHandler（http.ts 自带路由/方法/CORS 判断）；
 * 其余路径 → 静态文件。URL 解析失败的畸形请求回 400。
 */
export function createWebRequestListener(parts: WebServerParts): RequestListener {
  const staticHandler = createStaticFileHandler(parts.staticRoot ?? FRONTEND_ROOT);
  const onError = parts.onError ?? ((error: unknown) => console.error("[web]", error));
  return async (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      respond(res, 400, "bad request");
      return;
    }
    if (pathname === '/api/map-config' || pathname.startsWith('/_AMapService/')) {
      if (await handleAMapNode(req, res, parts.mapEnv, parts.mapFetch)) return;
    }
    if (pathname.startsWith("/api/chat")) {
      try {
        await parts.apiHandler(req, res);
      } catch (error) {
        onError(error, req);
        if (res.headersSent) res.destroy();
        else respondJson(res, 500, { error: "internal server error" });
      }
      return;
    }
    await staticHandler(req, res);
  };
}

export function createWebServer(parts: WebServerParts): Server {
  return createServer(createWebRequestListener(parts));
}

export interface WebListenOptions {
  host: string;
  port: number;
  /** 静态根（EXPLORER_WEB_ROOT 覆盖，默认仓库 frontend/）。 */
  staticRoot: string;
  /** 除同源外额外信任的 Origin 精确值，透传给 createChatHandler。 */
  allowedOrigins: string[];
}

/** 读取 EXPLORER_WEB_* 监听配置；不合法立即抛错（启动 fail-fast）。 */
export function webListenOptions(env: NodeJS.ProcessEnv = process.env): WebListenOptions {
  const host = env.EXPLORER_WEB_HOST?.trim() || "127.0.0.1";
  const portRaw = env.EXPLORER_WEB_PORT?.trim();
  const port = portRaw === undefined || portRaw === "" ? 8080 : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("EXPLORER_WEB_PORT must be an integer between 1 and 65535.");
  }
  const allowedOrigins = (env.EXPLORER_WEB_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
  for (const origin of allowedOrigins) {
    let ok = false;
    try {
      const url = new URL(origin);
      ok = (url.protocol === "http:" || url.protocol === "https:") && url.origin === origin;
    } catch {
      // 非 URL 形态
    }
    if (!ok) {
      throw new Error(
        `EXPLORER_WEB_ALLOWED_ORIGINS entries must be strict origins like "http://127.0.0.1:5173"; got "${origin}".`,
      );
    }
  }
  return {
    host,
    port,
    staticRoot: resolve(env.EXPLORER_WEB_ROOT?.trim() || FRONTEND_ROOT),
    allowedOrigins,
  };
}

/** 打开活动库（fail-fast）：文件缺失只提示 npm run seed，绝不自动写入。 */
export function openEventsRepository(config: Pick<ExplorerConfig, "dbPath">): EventRepository {
  if (!existsSync(config.dbPath)) {
    throw new Error(
      `活动库不存在：${config.dbPath}\n先运行 \`npm run seed\` 生成模拟活动数据。`,
    );
  }
  return createSqliteEventRepository(config.dbPath);
}

/** 启动探活：库里一条活动都没有时提示 seed（与 CLI 入口同口径）。 */
export async function assertEventsNonEmpty(
  repository: EventRepository,
  dbPath: string,
): Promise<void> {
  if ((await repository.search({})).length === 0) {
    throw new Error(
      `活动库为空：${dbPath}\n运行 \`npm run seed\` 写入模拟活动（会重建 events 表数据）。`,
    );
  }
}

/** listen 的 Promise 形式；端口占用等错误 reject，不走静默 'error' 事件。 */
export function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolvePromise();
    });
  });
}

/**
 * close() 形状的最小约束（node:http Server 天然满足）：调用后立即停止接
 * 新连接，callback 在既有连接耗尽后触发；未在监听时带错误回调。
 */
export interface ClosableServer {
  close(callback?: (error?: Error) => void): unknown;
}

/** 优雅关闭：停止接新连接并等活跃连接结束。 */
export function closeServer(server: ClosableServer): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error?: Error) => (error ? reject(error) : resolvePromise()));
  });
}

export interface ShutdownParts {
  /** HTTP server：第一步先对它 close()——停接新连接并开始等连接耗尽。 */
  server?: ClosableServer;
  /** Chat service：可选 shutdown()，取消在途 send 并等 send/history 结清。 */
  service?: { shutdown?: () => Promise<void> };
  /** 关库动作（sessions/repository）；必须晚于在途 Planner.close 收尾。 */
  closeDbs?: () => void | Promise<void>;
}

/**
 * 退出编排（幂等）：
 *   1. 先发起 server.close 的等待——立即停接新连接，但既有连接要等在途
 *      请求 settle 才耗尽，所以先挂上不 await；
 *   2. await service.shutdown()——拒新请求、取消并等齐在途 send/history
 *      （含各 send 末尾的 Planner.close/租约释放），连接随之耗尽；
 *   3. await server.close 完成——确认没有残留连接；
 *   4. closeDbs——关库绝不早于在途 Planner.close 收尾。
 * 任一步抛错仍按序尝试后续步骤，首个错误最后冒泡；重复调用返回同一个
 * Promise——SIGINT/SIGTERM 叠加、异常路径都只会执行一遍。
 */
export function createShutdown(parts: ShutdownParts): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () => {
    running ??= (async () => {
      const closing =
        parts.server === undefined ? Promise.resolve() : closeServer(parts.server);
      // closing 可能先拒绝（如未在监听）：挂上观察分支防 unhandled rejection，
      // 真正的 await 仍按顺序发生在后面（rejection 会被再次观察到）。
      closing.catch(() => {});
      let failed = false;
      let firstError: unknown;
      const attempt = async (step: () => void | Promise<void>): Promise<void> => {
        try {
          await step();
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      };
      await attempt(() => parts.service?.shutdown?.());
      await attempt(() => closing);
      await attempt(() => parts.closeDbs?.());
      if (failed) throw firstError;
    })();
    return running;
  };
}

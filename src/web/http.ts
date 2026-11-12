/**
 * Web Chat HTTP 协议层：把 /api/chat/* 请求翻译成可注入 ChatService 调用，
 * 返回可直接交给 node:http createServer 的 RequestListener。
 * 只依赖 ./types.ts 的契约类型——不 import 真实 Agent；service 实现与
 * server 装配由上层完成（本层不接 CLI、不建库）。
 *
 * 路由契约（响应均为 JSON + Cache-Control: no-store）：
 * - GET  /api/chat/history[?session_id=…] → ChatHistory（无参 = 空历史）
 * - POST /api/chat         → ChatResult（严格 {message, location?, session_id?} 入参）
 * - 会话不存在/跨用户/child → 404，归档/租约忙 → 409（均不记 onError）；
 *   其他路径 404，方法不符 405 + Allow，非 2xx 一律 {error:string}
 *
 * 安全边界见 identity.ts 顶部注释：匿名 cookie 是 bearer 凭证而非登录；
 * POST 校验 Origin 同源（或显式白名单），错误只回通用文案不泄内部细节。
 */
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { CHAT_COOKIE_NAME, mintUserId, readUserIdCookie, userIdSetCookie } from "./identity.ts";
import {
  BODY_TOO_LARGE,
  isChatHistory,
  isChatResult,
  isSameOriginRequest,
  mediaType,
  parseChatSend,
  parseSessionIdQuery,
  readRequestBody,
} from "./request.ts";
import { ChatClientError } from "./types.ts";
import type { ChatService } from "./types.ts";

const HISTORY_PATH = "/api/chat/history";
const CHAT_PATH = "/api/chat";
const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_CHARS = 1000;

export interface WebChatOptions {
  /** 身份 cookie 名；默认 "chat_uid"。 */
  cookieName?: string;
  /** POST body 上限字节数；默认 16 KiB。 */
  maxBodyBytes?: number;
  /**
   * 除同源外额外信任的 Origin 精确值，如独立端口的前端开发服务器
   * "http://127.0.0.1:5173"。命中白名单的跨域响应附带 CORS 头并允许凭证；
   * 默认空 = 纯同源。
   */
  allowedOrigins?: readonly string[];
  /** userId 生成器（默认 crypto 随机；测试可注入）。 */
  mintUserId?: () => string;
  /** 内部错误回调（默认 console.error）；细节只留服务端，绝不写进响应。 */
  onError?: (error: unknown, req: IncomingMessage) => void;
}

export function createChatHandler(
  service: ChatService,
  options: WebChatOptions = {},
): RequestListener {
  const cookieName = options.cookieName ?? CHAT_COOKIE_NAME;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const allowedOrigins = options.allowedOrigins ?? [];
  const mint = options.mintUserId ?? mintUserId;
  const onError = options.onError ?? ((error: unknown) => console.error("[web/chat]", error));

  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      // 兜底：任何未预期异常都不外泄；响应未发出就回通用 500。
      onError(error, req);
      if (res.headersSent) res.destroy();
      else fail(req, res, 500, "internal server error");
    }
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return fail(req, res, 400, "bad request");
    }
    const allow =
      pathname === HISTORY_PATH ? "GET" : pathname === CHAT_PATH ? "POST" : undefined;
    if (allow === undefined) return fail(req, res, 404, "not found");
    if (req.method === "OPTIONS") return preflight(req, res, allow);
    if (req.method !== allow) return fail(req, res, 405, "method not allowed", { Allow: allow });
    if (pathname === HISTORY_PATH) return history(req, res);
    return chat(req, res);
  }

  /**
   * 业务异常分类映射：ChatClientError 是客户端语义错误（会话不存在/
   * 已归档/租约忙），映射为 404/409 且不记 onError——不是服务端故障，
   * 不能污染 500 告警；其余异常统一 500 + onError 留细节。
   */
  function failServiceError(req: IncomingMessage, res: ServerResponse, error: unknown): void {
    if (error instanceof ChatClientError) {
      return error.code === "not_found"
        ? fail(req, res, 404, "session not found")
        : fail(req, res, 409, "session unavailable");
    }
    onError(error, req);
    fail(req, res, 500, "internal server error");
  }

  async function history(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let sessionId: string | undefined;
    try {
      const parsed = parseSessionIdQuery(
        new URL(req.url ?? "/", "http://localhost").searchParams,
      );
      if ("error" in parsed) return fail(req, res, 400, parsed.error);
      sessionId = parsed.sessionId;
    } catch {
      return fail(req, res, 400, "bad request");
    }
    const userId = ensureUser(req, res);
    try {
      const data = await service.history(userId, sessionId);
      if (!isChatHistory(data)) throw new Error("service.history returned invalid shape");
      sendJson(req, res, 200, data);
    } catch (error) {
      failServiceError(req, res, error);
    }
  }

  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isSameOriginRequest(req, allowedOrigins)) {
      return fail(req, res, 403, "origin not allowed");
    }
    if (mediaType(req) !== "application/json") {
      return fail(req, res, 415, "content type must be application/json");
    }
    // 客户端断连（socket 关闭且响应未正常写完）→ abort，透传给 service.send
    // 以取消规划等下游工作；正常完成后 writableEnded 已置位，不会误取消。
    const controller = new AbortController();
    const abortOnClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", abortOnClose);
    try {
      const body = await readRequestBody(req, maxBodyBytes);
      if (body === BODY_TOO_LARGE) return fail(req, res, 413, "request body too large");
      const parsed = parseChatSend(body, MAX_MESSAGE_CHARS);
      if ("error" in parsed) return fail(req, res, 400, parsed.error);
      // body 读完前客户端已走（读中断/断连）：不再给 service 派活。
      if (res.destroyed || controller.signal.aborted) return;
      const userId = ensureUser(req, res);
      const result = await service.send(userId, parsed.message, {
        signal: controller.signal,
        location: parsed.location,
        sessionId: parsed.session_id,
        activePlan: parsed.active_plan,
        referencedEventId: parsed.referenced_event_id,
      });
      if (!isChatResult(result)) throw new Error("service.send returned invalid shape");
      sendJson(req, res, 200, result);
    } catch (error) {
      // res 已毁时 sendJson 直接返回，不会在关闭的 socket 上写响应。
      failServiceError(req, res, error);
    } finally {
      res.off("close", abortOnClose);
    }
  }

  /** 取 cookie 里的合法 userId，否则铸新值并挂 Set-Cookie（先于响应发出）。 */
  function ensureUser(req: IncomingMessage, res: ServerResponse): string {
    const existing = readUserIdCookie(req.headers.cookie, cookieName);
    if (existing !== undefined) return existing;
    const userId = mint();
    res.setHeader("Set-Cookie", userIdSetCookie(cookieName, userId));
    return userId;
  }

  /** CORS preflight：只对白名单 Origin 放行；非预检 OPTIONS 按 405 处理。 */
  function preflight(req: IncomingMessage, res: ServerResponse, allow: string): void {
    if (res.destroyed) return;
    const origin = req.headers.origin;
    const requestedMethod = req.headers["access-control-request-method"];
    if (origin !== undefined && requestedMethod !== undefined && allowedOrigins.includes(origin)) {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": allow,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
        "Cache-Control": "no-store",
        Vary: "Origin",
      });
      res.end();
      return;
    }
    fail(req, res, 405, "method not allowed", { Allow: allow });
  }

  function fail(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    error: string,
    headers: Record<string, string> = {},
  ): void {
    sendJson(req, res, status, { error }, headers);
  }

  /** 统一 JSON 响应：白名单跨域补 CORS 头；所有响应禁缓存、防嗅探。 */
  function sendJson(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    if (res.destroyed) return; // socket 已关：不写响应（客户端断连等）
    const origin = req.headers.origin;
    const cors =
      origin !== undefined && allowedOrigins.includes(origin)
        ? {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            Vary: "Origin",
          }
        : {};
    // 先序列化再发头：body 不可序列化时还能回 500，而不是 200 半截响应。
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...cors,
      ...headers,
    });
    res.end(payload);
  }
}

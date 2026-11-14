/**
 * Web Chat HTTP 协议层：把 /api/* 请求翻译成可注入 ChatService 调用，
 * 返回可直接交给 node:http createServer 的 RequestListener。
 * 只依赖 ./types.ts 的契约类型——不 import 真实 Agent；service 实现与
 * server 装配由上层完成（本层不接 CLI、不建库）。
 *
 * 路由契约（响应均为 JSON + Cache-Control: no-store，stream 除外）：
 * - GET  /api/chat/history[?session_id=…] → ChatHistory（无参 = 空历史）
 * - POST /api/chat         → ChatResult（严格 {message, location?, session_id?} 入参）
 * - POST /api/chat/stream  → text/event-stream（入参与 /api/chat 相同；
 *   meta → progress* → result|error 事件序列，15s `: ping` 心跳）
 * - GET  /api/events[?date=…|from=…&to=…][&bbox=…][&limit=…] → {events: EventView[]}
 * - GET  /api/memory       → {content, updated_at}（无记录 content 空串、updated_at null）
 * - PUT  /api/memory       → {content, updated_at}（严格 {content} 入参，覆盖式更新）
 * - DELETE /api/memory     → 204（清除该 cookie 用户的记忆，幂等）
 * - POST /api/login        → {user:{id,username,display_name}}（严格
 *   {username,password} 入参；成功设 chat_session 登录会话 cookie，
 *   请求附带的匿名 chat_uid 数据并入账号；400 参数非法、401 凭据错误
 *   ——统一"用户名或密码错误"不区分哪一项、429 触发 IP+username 滑窗限流）
 * - POST /api/logout       → 204（删服务端会话行并清 cookie，幂等）
 * - GET  /api/me           → {authenticated:false} | {authenticated:true,user:{…}}
 *   （登录探测，只读不签发任何 cookie）
 * - 会话不存在/跨用户/child → 404（stream 转为 error 事件），归档/租约忙 →
 *   409（stream 同转 error 事件）；其他路径 404，方法不符 405 + Allow，
 *   非 2xx 一律 {error:string}
 *
 * 身份解析顺序：有效 chat_session token → 登录账号 userId；否则 chat_uid
 * 匿名 cookie（现状逻辑不变）。安全边界见 identity.ts 顶部注释：两类
 * cookie 都是 bearer 凭证；POST 校验 Origin 同源（或显式白名单），
 * 错误只回通用文案不泄内部细节。
 */
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { createLoginRateLimiter, parseLoginBody } from "./auth.ts";
import type { AuthAccount, AuthStore } from "./auth.ts";
import {
  CHAT_COOKIE_NAME,
  mintUserId,
  readSessionCookie,
  readUserIdCookie,
  sessionClearCookie,
  sessionSetCookie,
  userIdSetCookie,
} from "./identity.ts";
import {
  BODY_TOO_LARGE,
  isChatHistory,
  isChatResult,
  isEventsResult,
  isSameOriginRequest,
  isUserMemoryView,
  mediaType,
  parseChatSend,
  parseEventsQuery,
  parseMemoryPut,
  parseSessionIdQuery,
  readRequestBody,
} from "./request.ts";
import { createSseWriter } from "./sse.ts";
import type { ChatProgress, ChatStreamError } from "./sse.ts";
import { ChatClientError } from "./types.ts";
import type { ChatLocation, ChatResult, ChatService, EventsQuery } from "./types.ts";

const HISTORY_PATH = "/api/chat/history";
const CHAT_PATH = "/api/chat";
const STREAM_PATH = "/api/chat/stream";
const EVENTS_PATH = "/api/events";
const MEMORY_PATH = "/api/memory";
const LOGIN_PATH = "/api/login";
const LOGOUT_PATH = "/api/logout";
const ME_PATH = "/api/me";
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
  /** SSE `: ping` 心跳间隔（毫秒）；默认 15_000，0 关闭。 */
  sseHeartbeatMs?: number;
  /**
   * 可选登录存储（./auth.ts 的 createAuthStore）。缺省时 /api/login 回
   * 503，/api/logout 幂等清 cookie，/api/me 恒 authenticated:false，其余接口不变。
   */
  auth?: AuthStore;
  /** 登录会话 cookie 加 Secure（https 部署）；默认不加（本地 http）。 */
  secureCookie?: boolean;
  /** 登录限流参数（IP+username 内存滑窗）；默认 10 次失败 / 5 分钟。 */
  loginRateLimit?: { windowMs?: number; maxFailures?: number };
}

/**
 * /api/chat/stream 调 service.send 的扩展参数与最小服务面：onSession/
 * onProgress 由 service.ts 的 SendOptions 定义，但 web/types.ts 的
 * ChatService 契约归 plans-contract 工作流维护——这里本地声明等效签名，
 * 靠结构兼容接上去，不并发改契约文件。
 */
interface StreamSendOptions {
  signal?: AbortSignal;
  location?: ChatLocation;
  sessionId?: string;
  activePlan?: string;
  referencedEventId?: string;
  onSession?: (sessionId: string) => void;
  onProgress?: (progress: ChatProgress) => void;
}
interface StreamService {
  send(userId: string, message: string, options?: StreamSendOptions): Promise<ChatResult>;
}

/** 路径 → 允许的方法集合（405 的 Allow 与 preflight 的 Allow-Methods 同源）。 */
const ROUTES: Record<string, readonly string[]> = {
  [HISTORY_PATH]: ["GET"],
  [CHAT_PATH]: ["POST"],
  [STREAM_PATH]: ["POST"],
  [EVENTS_PATH]: ["GET"],
  [MEMORY_PATH]: ["GET", "PUT", "DELETE"],
  [LOGIN_PATH]: ["POST"],
  [LOGOUT_PATH]: ["POST"],
  [ME_PATH]: ["GET"],
};

export function createChatHandler(
  service: ChatService,
  options: WebChatOptions = {},
): RequestListener {
  const cookieName = options.cookieName ?? CHAT_COOKIE_NAME;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const allowedOrigins = options.allowedOrigins ?? [];
  const mint = options.mintUserId ?? mintUserId;
  const onError = options.onError ?? ((error: unknown) => console.error("[web/chat]", error));
  const sseHeartbeatMs = options.sseHeartbeatMs ?? 15_000;
  const auth = options.auth;
  const secureCookie = options.secureCookie ?? false;
  const loginLimiter = createLoginRateLimiter(options.loginRateLimit);
  // StreamSendOptions 相对契约参数只多可选字段 ⇒ service 可直接按
  // StreamService 使用（扩展字段在真实实现里生效，stub 忽略亦无碍）。
  const streamService: StreamService = service;

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
    const methods = ROUTES[pathname];
    if (methods === undefined) return fail(req, res, 404, "not found");
    const allow = methods.join(", ");
    if (req.method === "OPTIONS") return preflight(req, res, allow);
    if (req.method === undefined || !methods.includes(req.method)) {
      return fail(req, res, 405, "method not allowed", { Allow: allow });
    }
    if (pathname === HISTORY_PATH) return history(req, res);
    if (pathname === CHAT_PATH) return chat(req, res);
    if (pathname === STREAM_PATH) return chatStream(req, res);
    if (pathname === EVENTS_PATH) return events(req, res);
    if (pathname === LOGIN_PATH) return login(req, res);
    if (pathname === LOGOUT_PATH) return logout(req, res);
    if (pathname === ME_PATH) return me(req, res);
    return memory(req, res);
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

  /**
   * POST /api/chat/stream：入参与守卫链和 chat() 完全一致；不同的是响应
   * 升级为 text/event-stream，service.send 期间的会话确定/阶段进度经
   * onSession/onProgress 回调转写为 meta/progress 帧，终态写 result 或
   * error 帧后关流。send 阶段的错误一律走 error 事件（SSE 头已发出，
   * 不再有 JSON 状态码可改）；此前的校验失败仍是 JSON 4xx。
   */
  async function chatStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isSameOriginRequest(req, allowedOrigins)) {
      return fail(req, res, 403, "origin not allowed");
    }
    if (mediaType(req) !== "application/json") {
      return fail(req, res, 415, "content type must be application/json");
    }
    // 断连 abort 语义与 chat() 相同：close 且响应未正常结束 → 取消在途规划。
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
      if (res.destroyed || controller.signal.aborted) return;
      const userId = ensureUser(req, res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Accel-Buffering": "no",
        ...corsHeaders(req),
      });
      const sse = createSseWriter(res, { heartbeatMs: sseHeartbeatMs });
      let metaSent = false;
      const sendMeta = (sessionId: string) => {
        if (metaSent || sessionId === "") return;
        metaSent = true;
        sse.send("meta", { session_id: sessionId });
      };
      try {
        const result = await streamService.send(userId, parsed.message, {
          signal: controller.signal,
          location: parsed.location,
          sessionId: parsed.session_id,
          activePlan: parsed.active_plan,
          referencedEventId: parsed.referenced_event_id,
          onSession: sendMeta,
          onProgress: (progress) => sse.send("progress", progress),
        });
        if (!isChatResult(result)) throw new Error("service.send returned invalid shape");
        // 未实现 onSession 的 service 也要保证 meta 先于 result。
        sendMeta(result.session_id);
        sse.send("result", result);
      } catch (error) {
        sse.send("error", streamErrorPayload(req, error));
      } finally {
        sse.end();
      }
    } catch (error) {
      failServiceError(req, res, error);
    } finally {
      res.off("close", abortOnClose);
    }
  }

  /** error 事件载荷：ChatClientError 如实分类，其余记 onError + 通用文案。 */
  function streamErrorPayload(req: IncomingMessage, error: unknown): ChatStreamError {
    if (error instanceof ChatClientError) {
      if (error.code === "not_found") {
        return { error: { code: "not_found", message: "session not found", retryable: false } };
      }
      // 租约竞争可重试；已归档是终态。
      return {
        error: {
          code: "conflict",
          message: "session unavailable",
          retryable: !error.message.includes("归档"),
        },
      };
    }
    onError(error, req);
    return { error: { code: "internal_error", message: "internal server error", retryable: false } };
  }

  /** GET /api/events：近期活动只读查询；query 解析失败一律 400 不调 service。 */
  async function events(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let query: EventsQuery;
    try {
      const parsed = parseEventsQuery(
        new URL(req.url ?? "/", "http://localhost").searchParams,
      );
      if ("error" in parsed) return fail(req, res, 400, parsed.error);
      query = parsed;
    } catch {
      return fail(req, res, 400, "bad request");
    }
    const userId = ensureUser(req, res);
    try {
      const data = await service.listEvents(userId, query);
      if (!isEventsResult(data)) throw new Error("service.listEvents returned invalid shape");
      sendJson(req, res, 200, data);
    } catch (error) {
      failServiceError(req, res, error);
    }
  }

  /**
   * /api/memory 统一入口：写接口（PUT/DELETE）先过 /api/chat 同款的
   * Origin 同源（或白名单）检查——它们修改用户状态，同属 CSRF 防线。
   * PUT 另有 JSON media-type 校验（在 putMemory 内，与 chat 同序）；
   * DELETE 不带请求体，没有 media-type 可校验。
   */
  async function memory(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET" && !isSameOriginRequest(req, allowedOrigins)) {
      return fail(req, res, 403, "origin not allowed");
    }
    if (req.method === "GET") return getMemory(req, res);
    if (req.method === "PUT") return putMemory(req, res);
    return deleteMemory(req, res);
  }

  async function getMemory(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const userId = ensureUser(req, res);
    try {
      const data = await service.getMemory(userId);
      if (!isUserMemoryView(data)) throw new Error("service.getMemory returned invalid shape");
      sendJson(req, res, 200, data);
    } catch (error) {
      failServiceError(req, res, error);
    }
  }

  async function putMemory(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (mediaType(req) !== "application/json") {
      return fail(req, res, 415, "content type must be application/json");
    }
    try {
      const body = await readRequestBody(req, maxBodyBytes);
      if (body === BODY_TOO_LARGE) return fail(req, res, 413, "request body too large");
      const parsed = parseMemoryPut(body);
      if ("error" in parsed) return fail(req, res, 400, parsed.error);
      if (res.destroyed) return; // body 读完前客户端已走：不再派活。
      const userId = ensureUser(req, res);
      const data = await service.putMemory(userId, parsed.content);
      if (!isUserMemoryView(data)) throw new Error("service.putMemory returned invalid shape");
      sendJson(req, res, 200, data);
    } catch (error) {
      failServiceError(req, res, error);
    }
  }

  async function deleteMemory(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.resume(); // 不带体接口：若客户端仍附带了 body，丢弃它保持连接可复用。
    const userId = ensureUser(req, res);
    try {
      await service.deleteMemory(userId);
      sendNoContent(req, res, 204);
    } catch (error) {
      failServiceError(req, res, error);
    }
  }

  /**
   * POST /api/login：校验凭据 → 并入匿名身份 → 发登录会话 cookie。
   * 校验链与 /api/chat 同序：Origin → media-type → body 上限 → 严格入参；
   * 之后限流（IP+username 滑窗，只看失败次数）→ 凭据。401 统一文案不
   * 区分"无此用户"与"密码错"（auth 层也对时间侧信道做了拉平）。
   */
  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isSameOriginRequest(req, allowedOrigins)) {
      return fail(req, res, 403, "origin not allowed");
    }
    if (mediaType(req) !== "application/json") {
      return fail(req, res, 415, "content type must be application/json");
    }
    try {
      const body = await readRequestBody(req, maxBodyBytes);
      if (body === BODY_TOO_LARGE) return fail(req, res, 413, "request body too large");
      const parsed = parseLoginBody(body);
      if ("error" in parsed) return fail(req, res, 400, parsed.error);
      if (auth === undefined) return fail(req, res, 503, "authentication unavailable");
      if (res.destroyed) return;
      const limitKey = `${req.socket.remoteAddress ?? "unknown"}\n${parsed.username.toLowerCase()}`;
      if (!loginLimiter.allow(limitKey)) {
        return fail(req, res, 429, "too many attempts, try again later");
      }
      const account = auth.verifyLogin(parsed.username, parsed.password);
      if (account === undefined) {
        loginLimiter.recordFailure(limitKey);
        return fail(req, res, 401, "用户名或密码错误");
      }
      loginLimiter.clear(limitKey);
      // 匿名身份并入：请求附带的 chat_uid 名下数据整体归到登录账号。
      const anonymousId = readUserIdCookie(req.headers.cookie, cookieName);
      if (anonymousId !== undefined && anonymousId !== account.userId) {
        auth.mergeAnonymousUser(anonymousId, account.userId);
      }
      // 重复登录替换旧会话：旧 token 行即删，不等到期惰性清理。
      const oldToken = readSessionCookie(req.headers.cookie);
      if (oldToken !== undefined) auth.deleteSession(oldToken);
      const { token } = auth.createSession(account.userId);
      sendJson(req, res, 200, { user: accountView(account) }, {
        "Set-Cookie": sessionSetCookie(token, secureCookie),
      });
    } catch (error) {
      failServiceError(req, res, error);
    }
  }

  /**
   * POST /api/logout：删当前 token 的会话行并清 cookie，幂等——
   * 未登录/无 token 也回 204（结果状态一致）。只清登录会话，chat_uid
   * 匿名 cookie 原样保留（登出后回落匿名身份）。
   */
  function logout(req: IncomingMessage, res: ServerResponse): void {
    if (!isSameOriginRequest(req, allowedOrigins)) {
      return fail(req, res, 403, "origin not allowed");
    }
    req.resume(); // 无 body 接口：附带了也丢弃，保持连接可复用（同 deleteMemory）。
    const token = readSessionCookie(req.headers.cookie);
    if (token !== undefined && auth !== undefined) auth.deleteSession(token);
    sendNoContent(req, res, 204, { "Set-Cookie": sessionClearCookie(secureCookie) });
  }

  /** GET /api/me：登录探测，只读——不签发任何 cookie、不建任何行。 */
  function me(req: IncomingMessage, res: ServerResponse): void {
    const account = resolveSessionUser(req);
    if (account === undefined) return sendJson(req, res, 200, { authenticated: false });
    sendJson(req, res, 200, { authenticated: true, user: accountView(account) });
  }

  /** chat_session token → 登录账号；未配置 auth/无 token/无效过期 → undefined。 */
  function resolveSessionUser(req: IncomingMessage): AuthAccount | undefined {
    if (auth === undefined) return undefined;
    const token = readSessionCookie(req.headers.cookie);
    return token === undefined ? undefined : auth.resolveSession(token);
  }

  /** 登录账号的线上契约视图（snake_case）。 */
  function accountView(account: AuthAccount): {
    id: string;
    username: string;
    display_name: string | null;
  } {
    return { id: account.userId, username: account.username, display_name: account.displayName };
  }

  /**
   * 身份解析：有效 chat_session → 登录 userId；否则取 cookie 里的合法
   * 匿名 userId，仍无则铸新值并挂 Set-Cookie（先于响应发出）。
   */
  function ensureUser(req: IncomingMessage, res: ServerResponse): string {
    const account = resolveSessionUser(req);
    if (account !== undefined) return account.userId;
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

  /** 白名单跨域时的 CORS 响应头；同源/无 Origin 为空对象。 */
  function corsHeaders(req: IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    return origin !== undefined && allowedOrigins.includes(origin)
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Credentials": "true",
          Vary: "Origin",
        }
      : {};
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
    // 先序列化再发头：body 不可序列化时还能回 500，而不是 200 半截响应。
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(req),
      ...headers,
    });
    res.end(payload);
  }

  /** 204 响应：无 body 故无 Content-Type；缓存/嗅探/CORS 头与 JSON 响应同口径。 */
  function sendNoContent(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    headers: Record<string, string> = {},
  ): void {
    if (res.destroyed) return;
    res.writeHead(status, {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(req),
      ...headers,
    });
    res.end();
  }
}

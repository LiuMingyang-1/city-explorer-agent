/**
 * 请求侧辅助：body 读取与严格校验、Origin 同源检查、服务返回值判别。
 * 与 http.ts 拆开仅为控制单文件长度；这些函数都不持有会话状态。
 */
import type { IncomingMessage } from "node:http";
import type { ChatErrorResponse, ChatHistory, ChatLocation, ChatResult } from "./types.ts";

/** 请求体超过上限时的标记返回值（区别于解析结果）。 */
export const BODY_TOO_LARGE = Symbol("body-too-large");

/** 取 Content-Type 的 media type 部分（忽略 charset 等参数），小写。 */
export function mediaType(req: IncomingMessage): string | undefined {
  return req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
}

/**
 * Origin 头必须已是规范序列化 "scheme://host[:port]"（即 url.origin 自身），
 * 否则一律拒——顺带挡掉 userinfo、路径、query、hash、大小写变体、
 * 默认端口冗余、空格分隔的 Origin 列表等一切非 Origin 形态。
 */
function strictOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === value) {
      return url.origin;
    }
  } catch {
    // 非 URL 形态（"null"、"a b" 等）
  }
  return undefined;
}

/**
 * Host 头 → 本服务的规范 http origin；畸形（空、userinfo、路径等）拒。
 * 本层是裸 http 服务，scheme 恒 http：不读 X-Forwarded-Proto——它可被
 * 客户端伪造，TLS 代理场景的公共 https origin 应由部署方写进 allowedOrigins。
 */
function hostOrigin(host: string | undefined): string | undefined {
  if (host === undefined || host.trim() === "") return undefined;
  try {
    const url = new URL(`http://${host}`);
    const clean =
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "";
    return clean ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Origin 同源检查（POST 的 CSRF 防线之一）：
 * - 无 Origin（curl 等非浏览器客户端）放行；
 * - 命中 allowedOrigins 精确匹配的显式白名单放行；
 * - 否则要求 Origin 为规范形态且 scheme+host+有效端口 与本请求完全一致：
 *   https://host 与 http://host 不同源，http://host:8080 与 http://host 不同源；
 *   本服务 scheme 恒为 http（见 hostOrigin 注释），https 公共入口须走白名单。
 */
export function isSameOriginRequest(
  req: IncomingMessage,
  allowedOrigins: readonly string[],
): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (allowedOrigins.includes(origin)) return true;
  const expected = hostOrigin(req.headers.host);
  return expected !== undefined && strictOrigin(origin) === expected;
}

/**
 * 读完整请求体，超限不截断存根：Content-Length 已声明超限则直接 drain
 * （不读入内存）；流式超限后继续读完丢弃以保持连接可复用，但返回标记。
 */
export async function readRequestBody(
  req: IncomingMessage,
  limitBytes: number,
): Promise<Buffer | typeof BODY_TOO_LARGE> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limitBytes) {
    req.resume();
    return BODY_TOO_LARGE;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) overflow = true;
    else chunks.push(chunk as Buffer);
  }
  return overflow ? BODY_TOO_LARGE : Buffer.concat(chunks);
}

/** session_id 的统一长度上限（body 与 query 校验共用）。 */
export const MAX_SESSION_ID_CHARS = 128;

/** active_plan / referenced_event_id 的统一长度上限。 */
export const MAX_REF_CHARS = 128;

/**
 * 短文本值校验：必须是 string 且 trim 后 1..maxChars 字符；返回 trim 后的
 * 合法值，不合法返回 undefined（调用方转 400，不回显输入）。
 */
function validShortString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= maxChars ? trimmed : undefined;
}

/** session_id 值校验（1..128 字符，语义见 MAX_SESSION_ID_CHARS）。 */
function validSessionId(value: unknown): string | undefined {
  return validShortString(value, MAX_SESSION_ID_CHARS);
}

const CHAT_SEND_KEYS = new Set([
  "message",
  "location",
  "session_id",
  "active_plan",
  "referenced_event_id",
]);

/**
 * 严格解析 POST /api/chat 请求体：必须是 JSON 对象，键只允许 message
 * （必填）、location、session_id、active_plan、referenced_event_id
 * （均可选）——其他任何字段（userId、messages、itinerary 等）都直接
 * 拒绝，防止客户端越权指定身份或伪造历史。message 按 trim 后
 * 1..maxChars 字校验；location 若给出必须是恰好 {lat,lng} 的对象：
 * 均为有限 number，lat∈[-90,90]、lng∈[-180,180]，多出的键同样拒绝
 * （只传坐标、不带地名等其他信息）。session_id / active_plan /
 * referenced_event_id 若给出必须是非空白 string（trim 后 1..128 字符）。
 * 返回 {message,location?,session_id?,active_plan?,referenced_event_id?}
 * 即通过（message 已 trim）；返回 {error} 即 400 原因（通用、不回显输入）。
 */
export function parseChatSend(
  body: Buffer,
  maxChars: number,
):
  | {
      message: string;
      location?: ChatLocation;
      session_id?: string;
      active_plan?: string;
      referenced_event_id?: string;
    }
  | ChatErrorResponse {
  let data: unknown;
  try {
    data = JSON.parse(body.toString("utf8"));
  } catch {
    return { error: "request body must be valid JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { error: "request body must be a JSON object" };
  }
  const keys = Object.keys(data);
  if (!keys.includes("message") || !keys.every((k) => CHAT_SEND_KEYS.has(k))) {
    return {
      error:
        'request body must contain only "message" (string), optional "location", "session_id", "active_plan" and "referenced_event_id"',
    };
  }
  const message = (data as { message?: unknown }).message;
  if (typeof message !== "string") {
    return { error: "message must be a string" };
  }
  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) {
    return { error: `message must be 1..${maxChars} characters after trim` };
  }
  const rawSessionId = (data as { session_id?: unknown }).session_id;
  const sessionId = rawSessionId === undefined ? undefined : validSessionId(rawSessionId);
  if (rawSessionId !== undefined && sessionId === undefined) {
    return { error: `session_id must be a string of 1..${MAX_SESSION_ID_CHARS} characters` };
  }
  const rawActivePlan = (data as { active_plan?: unknown }).active_plan;
  const activePlan =
    rawActivePlan === undefined ? undefined : validShortString(rawActivePlan, MAX_REF_CHARS);
  if (rawActivePlan !== undefined && activePlan === undefined) {
    return { error: `active_plan must be a string of 1..${MAX_REF_CHARS} characters` };
  }
  const rawEventId = (data as { referenced_event_id?: unknown }).referenced_event_id;
  const referencedEventId =
    rawEventId === undefined ? undefined : validShortString(rawEventId, MAX_REF_CHARS);
  if (rawEventId !== undefined && referencedEventId === undefined) {
    return { error: `referenced_event_id must be a string of 1..${MAX_REF_CHARS} characters` };
  }
  const rawLocation = (data as { location?: unknown }).location;
  const parsed: {
    message: string;
    location?: ChatLocation;
    session_id?: string;
    active_plan?: string;
    referenced_event_id?: string;
  } = { message: trimmed };
  if (sessionId !== undefined) parsed.session_id = sessionId;
  if (activePlan !== undefined) parsed.active_plan = activePlan;
  if (referencedEventId !== undefined) parsed.referenced_event_id = referencedEventId;
  if (rawLocation === undefined) return parsed;
  if (typeof rawLocation !== "object" || rawLocation === null || Array.isArray(rawLocation)) {
    return { error: "location must be an object {lat,lng}" };
  }
  const locationKeys = Object.keys(rawLocation);
  if (locationKeys.length !== 2 || !locationKeys.includes("lat") || !locationKeys.includes("lng")) {
    return { error: "location must contain only lat and lng" };
  }
  const { lat, lng } = rawLocation as { lat?: unknown; lng?: unknown };
  if (
    typeof lat !== "number" ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90 ||
    typeof lng !== "number" ||
    !Number.isFinite(lng) ||
    lng < -180 ||
    lng > 180
  ) {
    return { error: "location lat must be in [-90,90] and lng in [-180,180]" };
  }
  parsed.location = { lat, lng };
  return parsed;
}

/**
 * 校验 GET /api/chat/history 的 session_id 查询参数：未传 → {sessionId:
 * undefined}（空历史分支）；传了但重复出现/空串/纯空白/超 128 字符 →
 * {error}（400）。
 */
export function parseSessionIdQuery(
  params: URLSearchParams,
): { sessionId?: string } | ChatErrorResponse {
  const values = params.getAll("session_id");
  if (values.length === 0) return { sessionId: undefined };
  if (values.length > 1) return { error: "session_id must appear at most once" };
  const sessionId = validSessionId(values[0]);
  if (sessionId === undefined) {
    return { error: `session_id must be 1..${MAX_SESSION_ID_CHARS} characters` };
  }
  return { sessionId };
}

/**
 * EventView 元素的最小判别：必须是带 string event_id 的对象。
 * 这一条就能拦下 adapter 把整条存储层 Event（id/venueName 为 camelCase）
 * 直接透传的情况——那种对象没有 event_id。
 */
function isEventView(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { event_id?: unknown }).event_id === "string"
  );
}

function isEventViewList(value: unknown): boolean {
  return Array.isArray(value) && value.every(isEventView);
}

/** Plan 元素的最小判别：plan_id 字符串 + itinerary 对象 + legs 数组。 */
function isPlanView(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const p = value as { plan_id?: unknown; itinerary?: unknown; legs?: unknown };
  return (
    typeof p.plan_id === "string" &&
    typeof p.itinerary === "object" &&
    p.itinerary !== null &&
    Array.isArray(p.legs)
  );
}

/** service.history 返回值的最小形状判别；畸形按服务端错误处理。 */
export function isChatHistory(value: unknown): value is ChatHistory {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { messages?: unknown; events?: unknown; plans?: unknown };
  if (!Array.isArray(v.messages)) return false;
  if (v.events !== undefined && !isEventViewList(v.events)) return false;
  return v.plans === undefined || (Array.isArray(v.plans) && v.plans.every(isPlanView));
}

/** service.send 返回值的形状判别；契约外形状按服务端错误处理而非透传。 */
export function isChatResult(value: unknown): value is ChatResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { kind?: unknown; session_id?: unknown };
  if (typeof v.session_id !== "string" || v.session_id.length === 0) return false;
  if (v.kind === "clarification") {
    return typeof (value as { question?: unknown }).question === "string";
  }
  if (v.kind === "plans") {
    const p = value as {
      mode?: unknown;
      active_plan?: unknown;
      plans?: unknown;
      events?: unknown;
      coordinate_system?: unknown;
    };
    return (
      (p.mode === "single" || p.mode === "comparison") &&
      typeof p.active_plan === "string" &&
      Array.isArray(p.plans) &&
      p.plans.length >= 1 &&
      p.plans.every(isPlanView) &&
      isEventViewList(p.events) &&
      p.coordinate_system === "GCJ-02"
    );
  }
  return false;
}

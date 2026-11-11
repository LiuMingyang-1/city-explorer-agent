/**
 * 请求侧辅助：body 读取与严格校验、Origin 同源检查、服务返回值判别。
 * 与 http.ts 拆开仅为控制单文件长度；这些函数都不持有会话状态。
 */
import type { IncomingMessage } from "node:http";
import type { ChatErrorResponse, ChatHistory, ChatResult } from "./types.ts";

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

/**
 * 严格解析 POST /api/chat 请求体：必须是恰好 { "message": string } 的 JSON
 * 对象——任何其他字段（userId、messages、itinerary 等）都直接拒绝，
 * 防止客户端越权指定身份或伪造历史。message 按 trim 后 1..maxChars 字校验。
 * 返回字符串即通过（已 trim）；返回 {error} 即 400 原因（通用、不回显输入）。
 */
export function parseChatMessage(
  body: Buffer,
  maxChars: number,
): string | ChatErrorResponse {
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
  if (keys.length !== 1 || keys[0] !== "message") {
    return { error: 'request body must contain only "message" (string)' };
  }
  const message = (data as { message?: unknown }).message;
  if (typeof message !== "string") {
    return { error: "message must be a string" };
  }
  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) {
    return { error: `message must be 1..${maxChars} characters after trim` };
  }
  return trimmed;
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

/** service.history 返回值的最小形状判别；畸形按服务端错误处理。 */
export function isChatHistory(value: unknown): value is ChatHistory {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { messages?: unknown; events?: unknown };
  if (!Array.isArray(v.messages)) return false;
  return v.events === undefined || isEventViewList(v.events);
}

/** service.send 返回值的形状判别；契约外形状按服务端错误处理而非透传。 */
export function isChatResult(value: unknown): value is ChatResult {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "clarification") {
    return typeof (value as { question?: unknown }).question === "string";
  }
  if (kind === "itinerary") {
    const v = value as { itinerary?: unknown; events?: unknown };
    return (
      typeof v.itinerary === "object" && v.itinerary !== null && isEventViewList(v.events)
    );
  }
  return false;
}

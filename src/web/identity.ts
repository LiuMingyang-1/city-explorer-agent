/**
 * 身份凭证：两个 HttpOnly cookie，按「登录会话优先」解析。
 *
 * 1. chat_session（可选登录）：POST /api/login 成功后服务端铸 32 字节随机
 *    token 交给浏览器保存，库里只存其 sha256——cookie 值本身是登录会话的
 *    bearer 凭证，谁拿到值谁就是该账号。有效期 30 天，过期即失效。
 * 2. chat_uid（匿名兜底）：服务端铸随机 userId 经 cookie 交给浏览器，
 *    cookie 值=128bit userId，是匿名身份的 bearer 凭证——谁拿到值谁就是
 *    "那个匿名用户"，可读写其全部聊天历史与行程。匿名不构成真实的用户
 *    认证或隔离保证，仅用于区分访客；登录后匿名数据可在登录时并入账号。
 *
 * 安全语义（如实声明，不夸大）：
 * - HttpOnly 使 JS 读不到（降低 XSS 窃取面）；SameSite=Lax 挡住大多数
 *   跨站携带（POST 另有 Origin 同源检查兜底）；Path=/ 全站共享身份。
 * - Secure 仅 https 部署时加（EXPLORER_SECURE_COOKIE=1）；本地 http
 *   开发加 Secure 反而会丢 cookie。
 */
import { randomBytes } from "node:crypto";

/** 匿名身份 cookie 名。 */
export const CHAT_COOKIE_NAME = "chat_uid";

/** 登录会话 cookie 名。 */
export const SESSION_COOKIE_NAME = "chat_session";

/** userId 形状：16 字节随机数的 32 位小写 hex。格式校验用于拒收伪造形状。 */
const USER_ID_PATTERN = /^[0-9a-f]{32}$/;

/** 登录会话 token 形状：32 字节随机数的 64 位小写 hex。 */
const SESSION_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** 登录会话 cookie 的 Max-Age（秒）：与服务端 30 天有效期一致。 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** 铸一个新的匿名 userId（不可猜测）。 */
export function mintUserId(): string {
  return randomBytes(16).toString("hex");
}

/** 序列化 Set-Cookie 值。 */
export function userIdSetCookie(cookieName: string, userId: string): string {
  return `${cookieName}=${userId}; HttpOnly; SameSite=Lax; Path=/`;
}

/**
 * 序列化登录会话 Set-Cookie 值。secure 对应 EXPLORER_SECURE_COOKIE=1
 * 的 https 部署；Max-Age 与服务端 token 有效期一致，浏览器不长期保存
 * 死 token（过期的兜底清理仍在服务端）。
 */
export function sessionSetCookie(token: string, secure: boolean): string {
  return (
    `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; ` +
    `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`
  );
}

/** 序列化清除登录会话的 Set-Cookie 值（登出）。 */
export function sessionClearCookie(secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${
    secure ? "; Secure" : ""
  }`;
}

/** 取 Cookie 头里首个同名 cookie 的原始值；缺失返回 undefined。 */
function readCookieValue(
  cookieHeader: string | undefined,
  cookieName: string,
): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== cookieName) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * 从 Cookie 头取回服务端铸过的 userId；缺失或形状不符返回 undefined，
 * 由调用方铸新值。客户端 body/query 里的 userId 一律不读——身份只认 cookie。
 */
export function readUserIdCookie(
  cookieHeader: string | undefined,
  cookieName: string,
): string | undefined {
  const value = readCookieValue(cookieHeader, cookieName);
  return value !== undefined && USER_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * 从 Cookie 头取回登录会话 token；缺失或形状不符返回 undefined。
 * token 本身只是查找键：是否有效由服务端会话表裁决。
 */
export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  const value = readCookieValue(cookieHeader, SESSION_COOKIE_NAME);
  return value !== undefined && SESSION_TOKEN_PATTERN.test(value) ? value : undefined;
}

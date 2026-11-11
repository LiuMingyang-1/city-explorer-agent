/**
 * 匿名身份：服务端铸随机 userId，经 HttpOnly cookie 交给浏览器保存。
 *
 * 安全语义（如实声明，不夸大）：
 * - userId 是 128 bit 加密随机数，**cookie 值本身就是唯一凭证**
 *   （bearer credential）——谁拿到值谁就是"那个匿名用户"，可读写其
 *   全部聊天历史与行程。这里没有登录、口令或服务端会话校验，
 *   不构成真实的用户认证或隔离保证，仅用于 demo 区分访客。
 * - HttpOnly 使 JS 读不到（降低 XSS 窃取面）；SameSite=Lax 挡住大多数
 *   跨站携带（POST 另有 Origin 同源检查兜底）；Path=/ 全站共享身份。
 * - Secure 留给 https 部署再加；本地 http 开发加 Secure 反而会丢 cookie。
 */
import { randomBytes } from "node:crypto";

/** 匿名身份 cookie 名。 */
export const CHAT_COOKIE_NAME = "chat_uid";

/** userId 形状：16 字节随机数的 32 位小写 hex。格式校验用于拒收伪造形状。 */
const USER_ID_PATTERN = /^[0-9a-f]{32}$/;

/** 铸一个新的匿名 userId（不可猜测）。 */
export function mintUserId(): string {
  return randomBytes(16).toString("hex");
}

/** 序列化 Set-Cookie 值。 */
export function userIdSetCookie(cookieName: string, userId: string): string {
  return `${cookieName}=${userId}; HttpOnly; SameSite=Lax; Path=/`;
}

/**
 * 从 Cookie 头取回服务端铸过的 userId；缺失或形状不符返回 undefined，
 * 由调用方铸新值。客户端 body/query 里的 userId 一律不读——身份只认 cookie。
 */
export function readUserIdCookie(
  cookieHeader: string | undefined,
  cookieName: string,
): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== cookieName) continue;
    const value = part.slice(eq + 1).trim();
    return USER_ID_PATTERN.test(value) ? value : undefined;
  }
  return undefined;
}

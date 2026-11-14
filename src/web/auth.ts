/**
 * 可选登录（不影响匿名全功能）：凭据校验、登录会话与匿名数据并入。
 *
 * 口令：node:crypto scrypt（N=16384,r=8,p=1）+ 随机 salt，存储格式
 * scrypt$N$r$p$salt$hash，校验 timingSafeEqual；用户不存在也跑一次
 * scrypt，使响应时间不区分"无此用户"与"密码错"（配合端点统一文案）。
 *
 * 会话：cookie 携带 32 字节随机 token，库内仅存 sha256(token)；30 天有效，
 * resolveSession 每次调用顺带惰性清理全部过期行。token 本身只是查找键，
 * 有效性由服务端表裁决——换浏览器/清匿名 cookie 不丢登录态。
 *
 * 并入：登录时把请求附带 chat_uid 匿名身份的数据并入账号——sessions/runs
 * 换主、user_memory 按"账号侧空/模板才取匿名侧"取舍、无引用后删匿名
 * users 行。匿名侧若持有凭据（实际是账号）则整体跳过，不并入不删行。
 */
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureSessionSchema } from "../session/schema.ts";
import { MEMORY_SECTIONS } from "../memory/doc.ts";
import {
  isUniqueViolation,
  tx,
  type SessionDbContext,
  type UserMemoryRow,
} from "../session/impl/context.ts";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

/** 登录会话有效期：30 天（与 identity.ts 的 cookie Max-Age 一致）。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const HASH_PATTERN = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/;
/** 解析自库的参数上限：N=2^20 远超本应用参数，更大值拒绝计算（防畸形行拖垮进程）。 */
const MAX_SCRYPT_N = 1 << 20;

/** scrypt 哈希编码：scrypt$N$r$p$salt$hash（salt/hash 为 hex）。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN).toString("hex");
  const hash = scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }).toString("hex");
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

/** 校验口令：格式/参数非法或摘要不一致 → false（不抛出，按不匹配处理）。 */
export function verifyPasswordHash(password: string, stored: string): boolean {
  const match = HASH_PATTERN.exec(stored);
  if (match === null) return false;
  const [, nRaw, rRaw, pRaw, salt, expected] = match;
  const n = Number(nRaw);
  if (!Number.isInteger(n) || n <= 1 || n > MAX_SCRYPT_N || (n & (n - 1)) !== 0) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, KEY_LEN, {
      N: n,
      r: Number(rRaw),
      p: Number(pRaw),
    });
  } catch {
    return false; // 非法参数组合（r/p 超界）按不匹配处理
  }
  const expectedBuf = Buffer.from(expected, "hex");
  return derived.length === expectedBuf.length && timingSafeEqual(derived, expectedBuf);
}

/** 铸登录会话 token：32 字节随机数 64 位 hex（cookie 明文）。 */
export function mintSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/** token 的库内查找键：只存 sha256，不落明文。 */
function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 登录账号的对外视图（userId/username/displayName）。 */
export interface AuthAccount {
  userId: string;
  username: string;
  displayName: string | null;
}

export interface AuthStore {
  /**
   * 该 username 无凭据行则创建 users+凭据行（displayName 缺省取 username）；
   * 已存在返回既有账号（幂等，不重置口令）。created 标记本次是否新建。
   */
  ensureAccount(input: {
    username: string;
    password: string;
    displayName?: string;
  }): AuthAccount & { created: boolean };
  /** 校验用户名口令；命中返回账号视图，否则 undefined（不区分哪一项错）。 */
  verifyLogin(username: string, password: string): AuthAccount | undefined;
  /** 为账号开新登录会话：返回明文 token（库内只存 sha256）与到期时间。 */
  createSession(userId: string): { token: string; expiresAt: string };
  /** token → 账号视图；缺失/过期 → undefined。顺带惰性清理全部过期行。 */
  resolveSession(token: string): AuthAccount | undefined;
  /** 删除指定会话行（登出/重复登录替换）；不存在时幂等 no-op。 */
  deleteSession(token: string): void;
  /**
   * 把匿名身份的 sessions/runs 换主到账号；user_memory 仅当账号侧为空/
   * 模板（无行、墓碑、仅小节标题）且匿名侧有实质内容时采用匿名侧，
   * 否则保留账号侧；并入后删除匿名 users 行（不再被引用时）。匿名侧
   * 持有凭据（实为账号）时整体跳过。单事务。
   */
  mergeAnonymousUser(anonymousUserId: string, accountUserId: string): void;
  /** 释放底层连接（仅自持连接时生效）。 */
  close(): void;
}

export interface AuthStoreOptions {
  /** 时钟注入（测试可推进覆盖过期判定）；默认真实时间。 */
  now?: () => Date;
}

type CredentialRow = {
  user_id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
};

function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/**
 * 登录存储（auth_credentials/auth_sessions 两表，随会话库同文件）。
 * source 传路径时自持连接（与会话库是同一文件的两条连接，靠 WAL +
 * busy_timeout 共存）；传 DatabaseSync 时借用该连接（测试用）。
 */
export function createAuthStore(
  source: string | DatabaseSync,
  options: AuthStoreOptions = {},
): AuthStore {
  const owns = typeof source === "string";
  const db = owns ? openDb(source) : source;
  db.exec("PRAGMA foreign_keys = ON");
  ensureSessionSchema(db); // 幂等：七表建齐（含 auth 两表）。
  const clock = options.now ?? (() => new Date());
  const ctx: SessionDbContext = {
    db,
    nowIso: () => clock().toISOString(),
    nowPlus: (ttlMs) => new Date(clock().getTime() + ttlMs).toISOString(),
  };

  const findByUsername = (username: string): CredentialRow | undefined =>
    db
      .prepare(
        `SELECT c.user_id, c.username, c.password_hash, u.display_name
         FROM auth_credentials c JOIN users u ON u.user_id = c.user_id
         WHERE c.username = ?`,
      )
      .get(username) as CredentialRow | undefined;

  // 初始化时计算，避免首次不存在用户的请求额外执行一次 scrypt。
  const dummyHash = hashPassword("not-a-real-password");

  return {
    ensureAccount(input) {
      const username = input.username.trim();
      if (username.length === 0 || username.length > 128) {
        throw new Error("auth username must be 1..128 characters");
      }
      if (input.password.length === 0 || input.password.length > MAX_PASSWORD_CHARS) {
        throw new Error(`auth password must be 1..${MAX_PASSWORD_CHARS} characters`);
      }
      const create = (): AuthAccount & { created: boolean } =>
        tx(ctx, true, () => {
          const existing = findByUsername(username);
          if (existing !== undefined) {
            return {
              userId: existing.user_id,
              username: existing.username,
              displayName: existing.display_name,
              created: false,
            };
          }
          const userId = randomUUID();
          const displayName = input.displayName ?? username;
          const now = ctx.nowIso();
          db.prepare(
            "INSERT INTO users (user_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
          ).run(userId, displayName, now, now);
          db.prepare(
            `INSERT INTO auth_credentials (user_id, username, password_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(userId, username, hashPassword(input.password), now, now);
          return { userId, username, displayName, created: true };
        });
      try {
        return create();
      } catch (error) {
        // 另一连接抢先建同一 username：唯一冲突按幂等返回既有账号。
        if (isUniqueViolation(error)) {
          const row = findByUsername(username);
          if (row !== undefined) {
            return {
              userId: row.user_id,
              username: row.username,
              displayName: row.display_name,
              created: false,
            };
          }
        }
        throw error;
      }
    },

    verifyLogin(username, password) {
      const row = findByUsername(username);
      const stored = row?.password_hash ?? dummyHash;
      // 先算 scrypt 再判行：短路跳过会让"无此用户"更快返回（时间侧信道）。
      const ok = verifyPasswordHash(password, stored);
      if (row === undefined || !ok) return undefined;
      return { userId: row.user_id, username: row.username, displayName: row.display_name };
    },

    createSession(userId) {
      const token = mintSessionToken();
      const expiresAt = ctx.nowPlus(SESSION_TTL_MS);
      db.prepare(
        `INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(tokenHash(token), userId, expiresAt, ctx.nowIso());
      return { token, expiresAt };
    },

    resolveSession(token) {
      // 惰性清理：每次解析顺带清掉全部过期行（索引上极小代价）。
      db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(ctx.nowIso());
      const row = db
        .prepare(
          `SELECT s.user_id, c.username, u.display_name
           FROM auth_sessions s
           JOIN auth_credentials c ON c.user_id = s.user_id
           JOIN users u ON u.user_id = s.user_id
           WHERE s.token_hash = ?`,
        )
        .get(tokenHash(token)) as
        | { user_id: string; username: string; display_name: string | null }
        | undefined;
      return row === undefined
        ? undefined
        : { userId: row.user_id, username: row.username, displayName: row.display_name };
    },

    deleteSession(token) {
      db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash(token));
    },

    mergeAnonymousUser(anonymousUserId, accountUserId) {
      if (anonymousUserId === accountUserId) return;
      tx(ctx, true, () => {
        // 防御：匿名身份若持有凭据（实为账号），不并入、不删行。
        const credential = db
          .prepare("SELECT 1 AS x FROM auth_credentials WHERE user_id = ?")
          .get(anonymousUserId);
        if (credential !== undefined) return;
        db.prepare("UPDATE sessions SET user_id = ? WHERE user_id = ?").run(
          accountUserId,
          anonymousUserId,
        );
        db.prepare("UPDATE runs SET user_id = ? WHERE user_id = ?").run(
          accountUserId,
          anonymousUserId,
        );
        const anonMemory = db
          .prepare("SELECT * FROM user_memory WHERE user_id = ?")
          .get(anonymousUserId) as UserMemoryRow | undefined;
        const acctMemory = db
          .prepare("SELECT * FROM user_memory WHERE user_id = ?")
          .get(accountUserId) as UserMemoryRow | undefined;
        // 账号侧空/模板（无行、墓碑、仅小节标题）时采用匿名侧文档，连同蒸馏
        // 游标整对搬入（游标描述"该文档蒸到哪儿"，会话已换主故仍指向有效会话）；
        // 两侧都有实质内容保留账号侧——已确认身份优先，匿名痕迹不覆盖账号记忆。
        if (
          anonMemory !== undefined &&
          !isBlankMemoryDoc(anonMemory.content) &&
          (acctMemory === undefined || isBlankMemoryDoc(acctMemory.content))
        ) {
          db.prepare(
            `INSERT INTO user_memory (user_id, content, source_session_id, through_message_seq, version, updated_at)
             VALUES (?, ?, ?, ?, 1, ?)
             ON CONFLICT(user_id) DO UPDATE SET
               content = excluded.content,
               source_session_id = excluded.source_session_id,
               through_message_seq = excluded.through_message_seq,
               version = user_memory.version + 1,
               updated_at = excluded.updated_at`,
          ).run(
            accountUserId,
            anonMemory.content,
            anonMemory.source_session_id,
            anonMemory.through_message_seq,
            ctx.nowIso(),
          );
        }
        db.prepare("DELETE FROM user_memory WHERE user_id = ?").run(anonymousUserId);
        // 匿名 users 行不再被引用时删除；仍有引用（异常边缘）则保留。
        db.prepare(
          `DELETE FROM users WHERE user_id = ?
             AND NOT EXISTS (SELECT 1 FROM sessions WHERE user_id = ?)
             AND NOT EXISTS (SELECT 1 FROM runs WHERE user_id = ?)
             AND NOT EXISTS (SELECT 1 FROM user_memory WHERE user_id = ?)
             AND NOT EXISTS (SELECT 1 FROM auth_sessions WHERE user_id = ?)
             AND NOT EXISTS (SELECT 1 FROM auth_credentials WHERE user_id = ?)`,
        ).run(
          anonymousUserId,
          anonymousUserId,
          anonymousUserId,
          anonymousUserId,
          anonymousUserId,
          anonymousUserId,
        );
      });
    },

    close() {
      if (owns) db.close();
    },
  };
}

/**
 * 空/模板文档判定：仅剥掉固定小节标题与空行——等于蒸馏空文档
 * （emptyMemoryDoc 的"三个小节标题、无内容"形态），含墓碑 content=""。
 */
function isBlankMemoryDoc(content: string): boolean {
  return content
    .split("\n")
    .every((line) => line.trim() === "" || MEMORY_SECTIONS.some((name) => line.trim() === `## ${name}`));
}

export const MAX_USERNAME_CHARS = 128;
export const MAX_PASSWORD_CHARS = 1024;

/**
 * 严格解析 POST /api/login 请求体：JSON 对象且只含 username/password
 * 两个 string 键——多余字段一律拒绝（不接纳 token/userId 等越权字段）。
 * username trim 后 1..128；password 不 trim（空格可属口令本身）1..1024。
 */
export function parseLoginBody(
  body: Buffer,
): { username: string; password: string } | { error: string } {
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
  if (keys.length !== 2 || !keys.includes("username") || !keys.includes("password")) {
    return { error: 'request body must contain only "username" and "password"' };
  }
  const { username, password } = data as { username?: unknown; password?: unknown };
  if (typeof username !== "string" || typeof password !== "string") {
    return { error: "username and password must be strings" };
  }
  const trimmed = username.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_USERNAME_CHARS) {
    return { error: `username must be 1..${MAX_USERNAME_CHARS} characters after trim` };
  }
  if (password.length === 0 || password.length > MAX_PASSWORD_CHARS) {
    return { error: `password must be 1..${MAX_PASSWORD_CHARS} characters` };
  }
  return { username: trimmed, password };
}

/** 登录限流（内存滑窗）：同 key（IP+username）窗口内失败超限 → 拒。 */
export interface LoginRateLimiter {
  /** 当前是否放行；顺带清理窗口外记录并防表无界增长。 */
  allow(key: string): boolean;
  /** 记一次失败。 */
  recordFailure(key: string): void;
  /** 登录成功后清掉该 key 的失败记录。 */
  clear(key: string): void;
}

export function createLoginRateLimiter(
  options: { windowMs?: number; maxFailures?: number; now?: () => number } = {},
): LoginRateLimiter {
  const windowMs = options.windowMs ?? 5 * 60_000;
  const maxFailures = options.maxFailures ?? 10;
  const now = options.now ?? (() => Date.now());
  const failures = new Map<string, number[]>();
  const sweep = (cutoff: number): void => {
    for (const [key, list] of failures) {
      const recent = list.filter((t) => t > cutoff);
      if (recent.length === 0) failures.delete(key);
      else failures.set(key, recent);
    }
  };
  return {
    allow(key) {
      const cutoff = now() - windowMs;
      if (failures.size > 10_000) sweep(cutoff); // 防 map 无界增长
      const list = failures.get(key);
      if (list === undefined) return true;
      const recent = list.filter((t) => t > cutoff);
      if (recent.length === 0) {
        failures.delete(key);
        return true;
      }
      failures.set(key, recent);
      return recent.length < maxFailures;
    },
    recordFailure(key) {
      const list = failures.get(key) ?? [];
      list.push(now());
      failures.set(key, list);
    },
    clear(key) {
      failures.delete(key);
    },
  };
}

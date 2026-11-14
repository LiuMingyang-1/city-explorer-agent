/**
 * 可选登录离线测试：真实 HTTP server → createChatHandler（注入真实
 * AuthStore + stub service）→ 会话库临时文件（AuthStore 与
 * SessionRepository 两条连接同库）。覆盖：登录/登出/me、并入匿名数据、
 * 限流、过期 token、匿名回归。不发模型请求、不碰仓库 data/。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type { SessionRepository } from "../src/session/repository.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";
import { createAuthStore, hashPassword, verifyPasswordHash, type AuthStore } from "../src/web/auth.ts";
import { createChatHandler, type WebChatOptions } from "../src/web/http.ts";
import { SESSION_TTL_MS } from "../src/web/auth.ts";
import type { ChatService } from "../src/web/types.ts";
import { afterResource } from "./resource-cleanup-fixture.ts";
import { call, withCookie, type Reply } from "./web-e2e-fixture.ts";

interface Stack {
  base: string;
  server: Server;
  service: ChatService & { userIds: string[] };
  sessions: SessionRepository;
  auth: AuthStore;
  dbPath: string;
}

/** 只记 userId 的 stub service：本组测试不打模型、只验身份传递。 */
function fakeService(): ChatService & { userIds: string[] } {
  const svc = {
    userIds: [] as string[],
    async history(userId: string) {
      svc.userIds.push(userId);
      return { messages: [] };
    },
    async send(userId: string) {
      svc.userIds.push(userId);
      return { kind: "clarification" as const, session_id: "sess_1", question: "?" };
    },
    async listEvents() {
      return { events: [] };
    },
    async getMemory() {
      return { content: "", updated_at: null };
    },
    async putMemory() {
      return { content: "", updated_at: null };
    },
    async deleteMemory() {},
  };
  return svc;
}

/**
 * 起整栈：会话库落临时文件（AuthStore 自持第二条连接共享同库，
 * 与 main.ts 装配同构）；options 透传 createChatHandler/auth 时钟。
 */
async function openStack(
  t: TestContext,
  options: WebChatOptions & { now?: () => Date } = {},
): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), "explorer-auth-"));
  afterResource(t, () => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "sessions.db");
  const sessions = createSqliteSessionRepository(dbPath);
  const { now, ...handlerOptions } = options;
  const auth = createAuthStore(dbPath, { now });
  const service = fakeService();
  const server = createServer(
    createChatHandler(service, { onError: () => {}, ...handlerOptions, auth }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const stack: Stack = { base: `http://127.0.0.1:${port}`, server, service, sessions, auth, dbPath };
  afterResource(t, async () => {
    await new Promise<void>((resolve) => stack.server.close(() => resolve()));
    stack.auth.close();
    stack.sessions.close();
  });
  return stack;
}

const postJson = (stack: Stack, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(stack.base, path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const login = (stack: Stack, body: unknown, headers: Record<string, string> = {}) =>
  postJson(stack, "/api/login", body, headers);

/** 从 set-cookie 取 chat_session 值。 */
function sessionToken(reply: Reply): string | undefined {
  for (const header of reply.headers["set-cookie"] ?? []) {
    const match = /chat_session=([0-9a-f]{64})/.exec(header);
    if (match) return match[1];
  }
  return undefined;
}

const sessionCookie = (token: string): Record<string, string> => ({
  Cookie: `chat_session=${token}`,
});

test("口令散列随机加盐、拒绝错误/畸形散列，播种口令长度与登录一致", () => {
  const first = hashPassword("pw"), second = hashPassword("pw");
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(verifyPasswordHash("pw", first), true);
  assert.equal(verifyPasswordHash("wrong", first), false);
  for (const bad of ["pw", "scrypt$3$8$1$aa$bb", "scrypt$16384$0$1$aa$bb"]) {
    assert.equal(verifyPasswordHash("pw", bad), false);
  }
  const auth = createAuthStore(":memory:");
  try {
    assert.throws(() => auth.ensureAccount({ username: "a", password: "p".repeat(1025) }));
    const account = auth.ensureAccount({ username: "a", password: "p".repeat(1024) });
    assert.equal(auth.verifyLogin("a", "p".repeat(1024))?.userId, account.userId);
    assert.equal(auth.ensureAccount({ username: "A", password: "replacement" }).created, false);
    assert.equal(auth.verifyLogin("a", "replacement"), undefined);
  } finally { auth.close(); }
});

test("Secure cookie 登录与清除一致，异源 logout 不吊销 token", async (t) => {
  const stack = await openStack(t, { secureCookie: true });
  stack.auth.ensureAccount({ username: "a", password: "pw" });
  const signed = await login(stack, { username: "a", password: "pw" });
  const token = sessionToken(signed)!;
  assert.match(signed.headers["set-cookie"]!.join(";"), /; Secure/);
  const denied = await call(stack.base, "/api/logout", {
    method: "POST", headers: { ...sessionCookie(token), Origin: "https://evil.example" },
  });
  assert.equal(denied.status, 403);
  assert.ok(stack.auth.resolveSession(token));
  const out = await call(stack.base, "/api/logout", { method: "POST", headers: sessionCookie(token) });
  assert.match(out.headers["set-cookie"]!.join(";"), /Max-Age=0; Secure/);
});

test("账号不能被并入其他账号，失败并入事务回滚不改变匿名归属", async (t) => {
  const stack = await openStack(t);
  const a = stack.auth.ensureAccount({ username: "a", password: "pw" });
  const b = stack.auth.ensureAccount({ username: "b", password: "pw" });
  const session = await stack.sessions.createConversation(a.userId, { title: "A" });
  stack.auth.mergeAnonymousUser(a.userId, b.userId);
  assert.ok(await stack.sessions.getSession(a.userId, session.sessionId));
  assert.equal(await stack.sessions.getSession(b.userId, session.sessionId), undefined);
  const anon = "9".repeat(32);
  await stack.sessions.createUser({ userId: anon });
  const anonymousSession = await stack.sessions.createConversation(anon, { title: "匿名" });
  await stack.sessions.putUserMemory(anon, { content: "## 偏好\n步行", sourceSessionId: anonymousSession.sessionId, throughMessageSeq: 1 });
  const db = new DatabaseSync(stack.dbPath);
  try {
    // 在换主之后的记忆写入阶段制造错误，验证前面的 sessions UPDATE 也回滚。
    db.exec("CREATE TRIGGER reject_merge BEFORE INSERT ON user_memory BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.throws(() => stack.auth.mergeAnonymousUser(anon, b.userId));
    assert.ok(await stack.sessions.getSession(anon, anonymousSession.sessionId));
    assert.equal(await stack.sessions.getSession(b.userId, anonymousSession.sessionId), undefined);
    assert.equal((await stack.sessions.getUserMemory(anon))?.content, "## 偏好\n步行");
  } finally { db.close(); }
});

test("登录成功 → 200 + chat_session cookie（HttpOnly/Lax/Max-Age），库内只存 sha256", async (t) => {
  const stack = await openStack(t);
  const account = stack.auth.ensureAccount({ username: "admin", password: "pw-1" });
  const reply = await login(stack, { username: "admin", password: "pw-1" });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json(), {
    user: { id: account.userId, username: "admin", display_name: "admin" },
  });
  const setCookie = (reply.headers["set-cookie"] ?? []).find((h) => h.includes("chat_session"));
  assert.ok(setCookie);
  assert.match(setCookie, /chat_session=[0-9a-f]{64}/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=2592000/);
  assert.ok(!setCookie.includes("Secure")); // 本地 http 默认不加
  // 库内只存 sha256(token)，不落明文；到期 ≈ 30 天。
  const token = sessionToken(reply)!;
  const db = new DatabaseSync(stack.dbPath);
  const row = db
    .prepare("SELECT token_hash, user_id, expires_at FROM auth_sessions")
    .get() as { token_hash: string; user_id: string; expires_at: string };
  db.close();
  assert.equal(row.token_hash, createHash("sha256").update(token, "utf8").digest("hex"));
  assert.equal(row.user_id, account.userId);
  assert.notEqual(row.token_hash, token);
  assert.ok(Date.parse(row.expires_at) > Date.now() + SESSION_TTL_MS - 60_000);
});

test("username 大小写不敏感命中（COLLATE NOCASE），响应回库内规范名", async (t) => {
  const stack = await openStack(t);
  stack.auth.ensureAccount({ username: "Admin", password: "pw" });
  const reply = await login(stack, { username: "ADMIN", password: "pw" });
  assert.equal(reply.status, 200);
  assert.equal((reply.json() as { user: { username: string } }).user.username, "Admin");
});

test("凭据错误 → 401 统一文案；密码错与用户不存在同文不区分", async (t) => {
  const stack = await openStack(t);
  stack.auth.ensureAccount({ username: "admin", password: "pw" });
  const wrong = await login(stack, { username: "admin", password: "nope" });
  const missing = await login(stack, { username: "ghost", password: "pw" });
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.deepEqual(wrong.json(), missing.json());
  assert.equal((wrong.json() as { error: string }).error, "用户名或密码错误");
});

test("入参校验：缺/多字段、非 string、坏 JSON → 400；非 JSON media type → 415；异源 → 403", async (t) => {
  const stack = await openStack(t);
  for (const body of [
    { username: "admin" },
    { password: "x" },
    { username: "a", password: "b", userId: "spoof" },
    { username: 1, password: "b" },
    { username: "a", password: 2 },
    { username: "  ", password: "b" },
    { username: "a".repeat(129), password: "b" },
    {},
    [1],
    "str",
  ]) {
    const reply = await login(stack, body);
    assert.equal(reply.status, 400, JSON.stringify(body)?.slice(0, 50));
    assert.equal(typeof (reply.json() as { error?: unknown }).error, "string");
  }
  assert.equal((await login(stack, "{not json")).status, 400);
  const plain = await call(stack.base, "/api/login", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(plain.status, 415);
  const denied = await login(stack, { username: "a", password: "b" }, { Origin: "https://evil.example" });
  assert.equal(denied.status, 403);
});

test("/api/me：匿名 → {authenticated:false} 且不签发 cookie；带 token → 账号视图；伪造 → false", async (t) => {
  const stack = await openStack(t);
  stack.auth.ensureAccount({ username: "admin", password: "pw" });
  const anon = await call(stack.base, "/api/me");
  assert.equal(anon.status, 200);
  assert.deepEqual(anon.json(), { authenticated: false });
  assert.equal(anon.headers["set-cookie"], undefined); // 只读探测不铸 cookie
  const forged = await call(stack.base, "/api/me", { headers: sessionCookie("f".repeat(64)) });
  assert.deepEqual(forged.json(), { authenticated: false });
  const badShape = await call(stack.base, "/api/me", { headers: sessionCookie("xyz") });
  assert.deepEqual(badShape.json(), { authenticated: false });
  const token = sessionToken(await login(stack, { username: "admin", password: "pw" }))!;
  const authed = await call(stack.base, "/api/me", { headers: sessionCookie(token) });
  assert.equal(authed.status, 200);
  const body = authed.json() as { authenticated: boolean; user: { username: string } };
  assert.equal(body.authenticated, true);
  assert.equal(body.user.username, "admin");
});

test("身份解析顺序：有效 chat_session 优先于 chat_uid；登录后请求走账号身份", async (t) => {
  const stack = await openStack(t);
  const account = stack.auth.ensureAccount({ username: "admin", password: "pw" });
  const token = sessionToken(await login(stack, { username: "admin", password: "pw" }))!;
  // 同时携带匿名 chat_uid 与登录 token → 服务端按账号身份调 service。
  const both = await call(stack.base, "/api/chat/history", {
    headers: { Cookie: `chat_uid=${"a".repeat(32)}; chat_session=${token}` },
  });
  assert.equal(both.status, 200);
  assert.equal(stack.service.userIds.at(-1), account.userId);
  // 只带 token → 同样账号身份。
  await call(stack.base, "/api/chat/history", { headers: sessionCookie(token) });
  assert.equal(stack.service.userIds.at(-1), account.userId);
});

test("logout → 204 清 cookie 删会话行；之后回落匿名 chat_uid，me 回匿名", async (t) => {
  const stack = await openStack(t);
  stack.auth.ensureAccount({ username: "admin", password: "pw" });
  const token = sessionToken(await login(stack, { username: "admin", password: "pw" }))!;
  const anonUid = "b".repeat(32);
  const out = await call(stack.base, "/api/logout", {
    method: "POST",
    headers: { Cookie: `chat_uid=${anonUid}; chat_session=${token}` },
  });
  assert.equal(out.status, 204);
  assert.equal(out.body, "");
  const clear = (out.headers["set-cookie"] ?? []).find((h) => h.includes("chat_session"));
  assert.match(clear ?? "", /Max-Age=0/);
  assert.equal(stack.auth.resolveSession(token), undefined); // 行已删
  // 登出后同一请求回落匿名身份（chat_uid 未被清）。
  await call(stack.base, "/api/chat/history", {
    headers: { Cookie: `chat_uid=${anonUid}; chat_session=${token}` },
  });
  assert.equal(stack.service.userIds.at(-1), anonUid);
  const me = await call(stack.base, "/api/me", { headers: sessionCookie(token) });
  assert.deepEqual(me.json(), { authenticated: false });
  // 幂等：未登录再登出仍 204。
  assert.equal((await call(stack.base, "/api/logout", { method: "POST" })).status, 204);
});

test("登录限流：同 IP+username 失败超限 → 429（正确口令同样拦），成功清空计数", async (t) => {
  const stack = await openStack(t, { loginRateLimit: { windowMs: 60_000, maxFailures: 3 } });
  stack.auth.ensureAccount({ username: "admin", password: "pw" });
  for (let i = 0; i < 3; i++) {
    assert.equal((await login(stack, { username: "admin", password: "bad" })).status, 401);
  }
  // 超限后正确口令也 429；其他 username 不受影响（key 是 IP+username）。
  const blocked = await login(stack, { username: "admin", password: "pw" });
  assert.equal(blocked.status, 429);
  stack.auth.ensureAccount({ username: "other", password: "pw" });
  assert.equal((await login(stack, { username: "other", password: "pw" })).status, 200);
});

test("限流计数在成功登录后清零", async (t) => {
  const stack = await openStack(t, { loginRateLimit: { windowMs: 60_000, maxFailures: 3 } });
  stack.auth.ensureAccount({ username: "admin", password: "pw" });
  await login(stack, { username: "admin", password: "bad" });
  await login(stack, { username: "admin", password: "bad" });
  assert.equal((await login(stack, { username: "admin", password: "pw" })).status, 200);
  // 成功后重新计数：再失败 2 次仍未超限。
  assert.equal((await login(stack, { username: "admin", password: "bad" })).status, 401);
  assert.equal((await login(stack, { username: "admin", password: "bad" })).status, 401);
});

test("登录并入匿名数据：sessions/runs 换主、空账号侧记忆取匿名文档、匿名 users 行删除", async (t) => {
  const stack = await openStack(t);
  const account = stack.auth.ensureAccount({ username: "admin", password: "pw" });
  const anonUid = "c".repeat(32);
  await stack.sessions.createUser({ userId: anonUid });
  const conversation = await stack.sessions.createConversation(anonUid, { title: "匿名行程" });
  const writer = await stack.sessions.acquireLease(anonUid, conversation.sessionId, "w1", 60_000);
  const run = await stack.sessions.createRun(writer!, anonUid, {
    sessionId: conversation.sessionId,
    input: { goal: "x" },
    startImmediately: true,
  });
  await stack.sessions.putUserMemory(anonUid, {
    content: "## 用户\n喜欢步行",
    sourceSessionId: conversation.sessionId,
    throughMessageSeq: 7,
  });
  const reply = await login(stack, { username: "admin", password: "pw" }, withCookie(anonUid));
  assert.equal(reply.status, 200);
  // sessions/runs 换主到账号。
  const moved = await stack.sessions.getSession(account.userId, conversation.sessionId);
  assert.equal(moved?.userId, account.userId);
  assert.equal(await stack.sessions.getSession(anonUid, conversation.sessionId), undefined);
  assert.equal((await stack.sessions.getRun(account.userId, run.runId))?.userId, account.userId);
  // 空账号侧取匿名文档连同蒸馏游标整对搬入。
  const memory = await stack.sessions.getUserMemory(account.userId);
  assert.equal(memory?.content, "## 用户\n喜欢步行");
  assert.equal(memory?.throughMessageSeq, 7);
  assert.equal(memory?.sourceSessionId, conversation.sessionId);
  // 匿名 users 行已删；其记忆行随之清空。
  assert.equal(await stack.sessions.getUser(anonUid), undefined);
  assert.equal(await stack.sessions.getUserMemoryRaw(anonUid), undefined);
  // 登录后带 chat_session 请求即可读到并入的会话历史归属（service 拿账号 id）。
  const token = sessionToken(reply)!;
  await call(stack.base, `/api/chat/history?session_id=${conversation.sessionId}`, {
    headers: sessionCookie(token),
  });
  assert.equal(stack.service.userIds.at(-1), account.userId);
});

test("并入取舍：账号侧已有实质记忆时保留账号文档，匿名文档不覆盖", async (t) => {
  const stack = await openStack(t);
  const account = stack.auth.ensureAccount({ username: "admin", password: "pw" });
  await stack.sessions.putUserMemory(account.userId, {
    content: "## 偏好\n账号的偏好",
    sourceSessionId: "sess_acct",
    throughMessageSeq: 42,
  });
  const anonUid = "d".repeat(32);
  await stack.sessions.createUser({ userId: anonUid });
  await stack.sessions.putUserMemory(anonUid, {
    content: "## 偏好\n匿名的偏好",
    sourceSessionId: "sess_anon",
    throughMessageSeq: 3,
  });
  const reply = await login(stack, { username: "admin", password: "pw" }, withCookie(anonUid));
  assert.equal(reply.status, 200);
  const memory = await stack.sessions.getUserMemory(account.userId);
  assert.equal(memory?.content, "## 偏好\n账号的偏好"); // 账号侧保留
  assert.equal(memory?.throughMessageSeq, 42); // 游标不回退
  assert.equal(await stack.sessions.getUser(anonUid), undefined); // 匿名行仍清理
});

test("并入取舍：账号侧仅模板空文档视为空，取匿名侧文档", async (t) => {
  const stack = await openStack(t);
  const account = stack.auth.ensureAccount({ username: "admin", password: "pw" });
  await stack.sessions.putUserMemory(account.userId, {
    content: "## 用户\n\n## 偏好\n\n## 足迹\n",
    sourceSessionId: null,
    throughMessageSeq: 0,
  });
  const anonUid = "e".repeat(32);
  await stack.sessions.createUser({ userId: anonUid });
  await stack.sessions.putUserMemory(anonUid, {
    content: "## 偏好\n爱逛博物馆",
    sourceSessionId: "sess_anon",
    throughMessageSeq: 5,
  });
  const reply = await login(stack, { username: "admin", password: "pw" }, withCookie(anonUid));
  assert.equal(reply.status, 200);
  const memory = await stack.sessions.getUserMemory(account.userId);
  assert.equal(memory?.content, "## 偏好\n爱逛博物馆");
  assert.equal(memory?.throughMessageSeq, 5);
});

test("并入不把含实际偏好的自定义标题误判为空模板", async (t) => {
  const stack = await openStack(t);
  const account = stack.auth.ensureAccount({ username: "admin", password: "pw" });
  const anon = "8".repeat(32);
  await stack.sessions.createUser({ userId: anon });
  await stack.sessions.putUserMemory(anon, { content: "## 花生严重过敏", sourceSessionId: null, throughMessageSeq: 0 });
  stack.auth.mergeAnonymousUser(anon, account.userId);
  assert.equal((await stack.sessions.getUserMemory(account.userId))?.content, "## 花生严重过敏");
  // 账号侧已有自定义标题时，也必须保留账号内容。
  await stack.sessions.createUser({ userId: anon });
  await stack.sessions.putUserMemory(anon, { content: "## 偏好\n喜欢步行", sourceSessionId: null, throughMessageSeq: 0 });
  stack.auth.mergeAnonymousUser(anon, account.userId);
  assert.equal((await stack.sessions.getUserMemory(account.userId))?.content, "## 花生严重过敏");
});

test("过期 token：resolveSession 判无效并惰性清理，/api/me 回匿名", async (t) => {
  let nowMs = Date.now();
  const stack = await openStack(t, { now: () => new Date(nowMs) });
  stack.auth.ensureAccount({ username: "admin", password: "pw" });
  const token = sessionToken(await login(stack, { username: "admin", password: "pw" }))!;
  nowMs += SESSION_TTL_MS + 60_000; // 时钟推进过 30 天
  const me = await call(stack.base, "/api/me", { headers: sessionCookie(token) });
  assert.deepEqual(me.json(), { authenticated: false });
  const db = new DatabaseSync(stack.dbPath);
  const count = db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get() as { n: number };
  assert.equal(count.n, 0); // 行已惰性清理
  db.close();
  // 过期 token 的其它请求回落匿名身份而非报错。
  await call(stack.base, "/api/chat/history", {
    headers: { Cookie: `chat_uid=${"f".repeat(32)}; chat_session=${token}` },
  });
  assert.equal(stack.service.userIds.at(-1), "f".repeat(32));
});

test("未配置 auth 的装配：/api/login → 503，/api/me → 匿名，/api/logout 幂等 204，其余路由不变", async (t) => {
  const service = fakeService();
  const server = createServer(createChatHandler(service, { onError: () => {} }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  afterResource(t, () => new Promise<void>((resolve) => server.close(() => resolve())));
  const denied = await call(base, "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "a", password: "b" }),
  });
  assert.equal(denied.status, 503);
  // logout 无服务端状态可删：幂等 204 且仍清 cookie。
  const out = await call(base, "/api/logout", { method: "POST" });
  assert.equal(out.status, 204);
  assert.match((out.headers["set-cookie"] ?? []).find((h) => h.includes("chat_session")) ?? "", /Max-Age=0/);
  assert.deepEqual((await call(base, "/api/me")).json(), { authenticated: false });
  // 匿名路由行为不变：history 照常签发 chat_uid。
  const history = await call(base, "/api/chat/history");
  assert.equal(history.status, 200);
  assert.match(history.headers["set-cookie"]?.[0] ?? "", /chat_uid=[0-9a-f]{32}/);
});

test("方法与路由：GET /api/login → 405 + Allow；/api/loginx → 404", async (t) => {
  const stack = await openStack(t);
  const wrongMethod = await call(stack.base, "/api/login");
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "POST");
  assert.equal((await call(stack.base, "/api/me", { method: "POST" })).status, 405);
  assert.equal((await call(stack.base, "/api/loginx")).status, 404);
  assert.equal((await call(stack.base, "/api/me/x")).status, 404);
});

test("重复登录替换会话：带旧 cookie 再登录删旧行，独立会话互不影响", async (t) => {
  const stack = await openStack(t);
  stack.auth.ensureAccount({ username: "admin", password: "pw" });
  const first = sessionToken(await login(stack, { username: "admin", password: "pw" }))!;
  // 同一浏览器携带旧 token 再登录 → 旧行被删，新 token 生效。
  const second = sessionToken(
    await login(stack, { username: "admin", password: "pw" }, sessionCookie(first)),
  )!;
  assert.notEqual(first, second);
  assert.equal(stack.auth.resolveSession(first), undefined);
  assert.notEqual(stack.auth.resolveSession(second), undefined);
  // 不带旧 cookie 的另一次登录是独立会话（多端共存），不顶掉已有会话。
  const third = sessionToken(await login(stack, { username: "admin", password: "pw" }))!;
  assert.notEqual(stack.auth.resolveSession(second), undefined);
  assert.notEqual(stack.auth.resolveSession(third), undefined);
});

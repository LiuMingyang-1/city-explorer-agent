/**
 * /api/memory 离线测试：真实 HTTP server → createChatHandler →
 * createChatService → 真实会话 SQLite（:memory:）+ 空活动库（:memory:）。
 * 覆盖：空记忆、PUT 覆盖与游标保留、DELETE 幂等清除、入参校验
 * （400/413/415/403）、跨用户隔离。不发模型请求、不碰仓库 data/。
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { EventRepository } from "../src/data/repository.ts";
import { createSqliteEventRepository } from "../src/data/sqlite.ts";
import type { SessionRepository } from "../src/session/repository.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";
import { createChatHandler } from "../src/web/http.ts";
import { createChatService, type ManagedChatService } from "../src/web/service.ts";
import { CONFIG } from "./e2e-fixture.ts";
import { call, cookieUserId, withCookie, type Reply } from "./web-e2e-fixture.ts";

interface Stack {
  base: string;
  server: Server;
  service: ManagedChatService;
  repository: EventRepository;
  sessions: SessionRepository;
}

/** 起整栈：活动库只用于满足装配（本组接口不读它），会话库承载 user_memory。 */
async function openStack(t: TestContext): Promise<Stack> {
  const repository = createSqliteEventRepository(":memory:");
  const sessions = createSqliteSessionRepository(":memory:");
  const service = createChatService({ config: CONFIG, repository, sessions });
  const server = createServer(createChatHandler(service, { onError: () => {} }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const stack: Stack = {
    base: `http://127.0.0.1:${port}`,
    server,
    service,
    repository,
    sessions,
  };
  t.after(async () => {
    await new Promise<void>((resolve) => stack.server.close(() => resolve()));
    await stack.service.shutdown();
    stack.sessions.close();
    stack.repository.close();
  });
  return stack;
}

const getMemory = (stack: Stack, uid?: string): Promise<Reply> =>
  call(stack.base, "/api/memory", uid === undefined ? {} : { headers: withCookie(uid) });

const putMemory = (stack: Stack, body: unknown, headers: Record<string, string> = {}): Promise<Reply> =>
  call(stack.base, "/api/memory", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const deleteMemory = (stack: Stack, uid?: string, headers: Record<string, string> = {}): Promise<Reply> =>
  call(stack.base, "/api/memory", {
    method: "DELETE",
    headers: { ...(uid === undefined ? {} : withCookie(uid)), ...headers },
  });

const view = (reply: Reply): { content: string; updated_at: string | null } =>
  reply.json() as { content: string; updated_at: string | null };

test("GET 空记忆：无记录 → content 空串、updated_at null，并照常签发身份 cookie", async (t) => {
  const stack = await openStack(t);
  const reply = await getMemory(stack);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json(), { content: "", updated_at: null });
  assert.match(cookieUserId(reply) ?? "", /^[0-9a-f]{32}$/);
  // 已有 cookie 的用户同样读到空文档（未写过不建记忆行）。
  const known = await getMemory(stack, "a".repeat(32));
  assert.deepEqual(known.json(), { content: "", updated_at: null });
});

test("PUT → GET 往返：覆盖式写入并可读回；未建过 users 行的 cookie 用户也能写", async (t) => {
  const stack = await openStack(t);
  const uid = "a".repeat(32);
  const put = await putMemory(stack, { content: "  喜欢博物馆与步行路线  " });
  assert.equal(put.status, 200);
  const minted = cookieUserId(put);
  assert.match(minted ?? "", /^[0-9a-f]{32}$/);
  const written = view(put);
  assert.equal(written.content, "喜欢博物馆与步行路线"); // trim 后入库
  assert.equal(typeof written.updated_at, "string");
  // service 为无 users 行的 cookie 用户幂等建好主行，再落记忆行。
  assert.equal((await stack.sessions.getUser(minted!))?.userId, minted);
  const stored = await stack.sessions.getUserMemory(minted!);
  assert.equal(stored?.throughMessageSeq, 0); // 无既有游标 → 0
  assert.equal(stored?.sourceSessionId, null);
  const read = await getMemory(stack, minted!);
  assert.deepEqual(read.json(), written);
  // 指定 cookie 的写入覆盖同一用户的旧值。
  const second = await putMemory(stack, { content: "改去市集" }, withCookie(uid));
  assert.equal(second.status, 200);
  assert.equal((await getMemory(stack, uid)).status, 200);
  assert.equal(view(await getMemory(stack, uid)).content, "改去市集");
});

test("PUT 覆盖正文且整对保留蒸馏游标（sourceSessionId + seq 不回退）", async (t) => {
  const stack = await openStack(t);
  const uid = "b".repeat(32);
  await stack.sessions.createUser({ userId: uid });
  await stack.sessions.putUserMemory(uid, {
    content: "蒸馏旧文",
    sourceSessionId: "sess_src",
    throughMessageSeq: 42,
  });
  const put = await putMemory(stack, { content: "手工新文" }, withCookie(uid));
  assert.equal(put.status, 200);
  const stored = await stack.sessions.getUserMemory(uid);
  assert.equal(stored?.content, "手工新文");
  assert.equal(stored?.throughMessageSeq, 42); // 蒸馏进度不回退
  // 游标是会话+序号的整体：清会话 ID 会让下次蒸馏从头重读、可能复活刚删掉的内容。
  assert.equal(stored?.sourceSessionId, "sess_src");
});

test("DELETE → 204 清除记忆；无记录/重复删幂等，GET 回到空文档", async (t) => {
  const stack = await openStack(t);
  const uid = "c".repeat(32);
  await putMemory(stack, { content: "待清除" }, withCookie(uid));
  const del = await deleteMemory(stack, uid);
  assert.equal(del.status, 204);
  assert.equal(del.body, ""); // 204 无响应体
  assert.equal(del.headers["cache-control"], "no-store");
  assert.deepEqual(view(await getMemory(stack, uid)), { content: "", updated_at: null });
  assert.equal(await stack.sessions.getUserMemory(uid), undefined); // 行已删
  // 再删仍 204；从未写过的用户删也 204。
  assert.equal((await deleteMemory(stack, uid)).status, 204);
  assert.equal((await deleteMemory(stack, "d".repeat(32))).status, 204);
});

test("PUT 入参校验：空/超长/非对象/多余键/坏 JSON 一律 400 且不写库", async (t) => {
  const stack = await openStack(t);
  const uid = "e".repeat(32);
  for (const body of [
    { content: "" },
    { content: "   \n\t " },
    { content: "x".repeat(8_001) },
    { content: 42 },
    { content: null },
    { content: "ok", userId: "spoofed" }, // 越权字段
    { content: "ok", updated_at: "x" },
    {},
    [1, 2],
    "str",
    42,
    null,
  ]) {
    const reply = await putMemory(stack, body, withCookie(uid));
    assert.equal(reply.status, 400, JSON.stringify(body)?.slice(0, 60));
    assert.equal(typeof (reply.json() as { error?: unknown }).error, "string");
  }
  const badJson = await putMemory(stack, "{not json", withCookie(uid));
  assert.equal(badJson.status, 400);
  assert.equal(await stack.sessions.getUserMemory(uid), undefined);
  // 边界合法值放行：trim 后恰 8000 字符（ASCII 单字节，避免撞上 16KiB body 上限）。
  const max = await putMemory(stack, { content: "x".repeat(8_000) }, withCookie(uid));
  assert.equal(max.status, 200);
  assert.equal(view(max).content.length, 8_000);
});

test("PUT 媒体类型与体积：非 JSON → 415，body 超 16KiB → 413", async (t) => {
  const stack = await openStack(t);
  const plain = await putMemory(stack, { content: "x" }, { "Content-Type": "text/plain" });
  assert.equal(plain.status, 415);
  const missing = await call(stack.base, "/api/memory", { method: "PUT", body: "{}" });
  assert.equal(missing.status, 415);
  const big = await putMemory(stack, { content: "x".repeat(17 * 1024) });
  assert.equal(big.status, 413);
  // 8000 字符上界内仍可正常写。
  const ok = await putMemory(stack, { content: "恢复" });
  assert.equal(ok.status, 200);
});

test("写接口 Origin 同源校验：异源 PUT/DELETE → 403，GET 不受限", async (t) => {
  const stack = await openStack(t);
  const uid = "f".repeat(32);
  await putMemory(stack, { content: "原始" }, withCookie(uid));
  const evil = "https://evil.example";
  const deniedPut = await putMemory(stack, { content: "篡改" }, {
    ...withCookie(uid),
    Origin: evil,
  });
  assert.equal(deniedPut.status, 403);
  const deniedDel = await deleteMemory(stack, uid, { Origin: evil });
  assert.equal(deniedDel.status, 403);
  assert.equal((await stack.sessions.getUserMemory(uid))?.content, "原始"); // 未被改动
  // 同源（Origin = Host 推导值）放行；GET 属读接口不查 Origin（同 history）。
  const sameOrigin = await putMemory(stack, { content: "同源改" }, {
    ...withCookie(uid),
    Origin: stack.base,
  });
  assert.equal(sameOrigin.status, 200);
  const read = await getMemory(stack, uid);
  assert.equal(read.status, 200);
});

test("跨用户隔离：各自读写互不可见，B 删除不影响 A", async (t) => {
  const stack = await openStack(t);
  const uidA = "1".repeat(32);
  const uidB = "2".repeat(32);
  await putMemory(stack, { content: "A 的记忆" }, withCookie(uidA));
  await putMemory(stack, { content: "B 的记忆" }, withCookie(uidB));
  assert.equal(view(await getMemory(stack, uidA)).content, "A 的记忆");
  assert.equal(view(await getMemory(stack, uidB)).content, "B 的记忆");
  assert.equal((await deleteMemory(stack, uidB)).status, 204);
  assert.deepEqual(view(await getMemory(stack, uidB)), { content: "", updated_at: null });
  assert.equal(view(await getMemory(stack, uidA)).content, "A 的记忆");
});

test("方法与路由：POST → 405 + Allow、未知子路径 → 404、非预检 OPTIONS → 405", async (t) => {
  const stack = await openStack(t);
  const wrongMethod = await call(stack.base, "/api/memory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "GET, PUT, DELETE");
  const unknown = await getMemory(stack);
  assert.equal((await call(stack.base, "/api/memory/x")).status, 404);
  const options = await call(stack.base, "/api/memory", { method: "OPTIONS" });
  assert.equal(options.status, 405);
  assert.equal(unknown.status, 200);
});

/**
 * Web 全链路 E2E（请求边界）：协议层拒绝（异源 Origin/坏 body）不触达
 * 模型与库；客户端断连中止在途请求后，run 收尾为 cancelled、租约释放、
 * 同 cookie 重试可继续。整栈与库装配见 web-e2e-fixture.ts。
 */
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { slowStream, until } from "./persistent-fixture.ts";
import {
  cookieUserId,
  getHistory,
  openWeb,
  post,
  seededEventsPath,
  tempDir,
  untilAsync,
  withCookie,
} from "./web-e2e-fixture.ts";

test("守卫在全链路上仍生效：异源 Origin 403、坏 body 400，均不触达模型与库", async (t) => {
  const dir = tempDir(t);
  const stack = await openWeb(t, {
    eventsPath: seededEventsPath(dir),
    sessionsPath: join(dir, "sessions.db"),
  });
  stack.faux.setResponses([fauxAssistantMessage('{"type":"clarify","question":"q"}')]);

  const first = await getHistory(stack.base);
  const uid = cookieUserId(first) as string;
  const sid = (await stack.sessions.getMainSession(uid)).sessionId;

  const evil = await post(
    stack.base,
    { message: "hi" },
    { ...withCookie(uid), Origin: "https://evil.example" },
  );
  assert.equal(evil.status, 403);
  const badJson = await post(stack.base, "{not json", withCookie(uid));
  assert.equal(badJson.status, 400);
  const extraField = await post(
    stack.base,
    { message: "hi", userId: "spoofed" },
    withCookie(uid),
  );
  assert.equal(extraField.status, 400);
  // 同源对照组放行：全链路澄清 200。
  const sameOrigin = await post(
    stack.base,
    { message: "hi" },
    { ...withCookie(uid), Origin: stack.base },
  );
  assert.equal(sameOrigin.status, 200);

  assert.equal(stack.faux.state.callCount, 1); // 只有同源那通打到模型
  const runs = await stack.sessions.listRunsBySession(uid, sid);
  assert.equal(runs.length, 1); // 被拒的请求没有建 run
});

test("客户端断连：在途 run 收尾为 cancelled、租约释放，同 cookie 重试可继续", async (t) => {
  const dir = tempDir(t);
  const slow = createFauxCore({ tokensPerSecond: 25 });
  const stack = await openWeb(t, {
    eventsPath: seededEventsPath(dir),
    sessionsPath: join(dir, "sessions.db"),
    streamFn: slowStream(slow),
  });
  slow.setResponses([
    fauxAssistantMessage("x".repeat(3_000)), // 慢流留出稳定的中断窗口
    fauxAssistantMessage('{"type":"clarify","question":"断连后继续"}'),
  ]);

  const first = await getHistory(stack.base);
  const uid = cookieUserId(first) as string;
  const sid = (await stack.sessions.getMainSession(uid)).sessionId;

  const req = httpRequest(stack.base + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...withCookie(uid) },
  });
  req.on("error", () => {}); // 客户端侧 ECONNRESET 是预期行为
  req.end(JSON.stringify({ message: "取消我" }));
  // 等模型请求真正开始（run 已建、prompt 在途）再断连，落点才确定。
  await until(() => slow.state.callCount > 0, "model call started");
  req.destroy(); // 客户端断连 → res close → abort → service 取消在途 planner

  // run 终态与租约释放在服务端异步收尾：轮询到落定，不看实现细节。
  await untilAsync(async () => {
    const run = (await stack.sessions.listRunsBySession(uid, sid)).at(-1);
    const sess = await stack.sessions.getSession(uid, sid);
    return run?.status === "cancelled" && sess?.leaseOwner === null;
  }, "aborted run settled as cancelled and lease released");
  const aborted = (await stack.sessions.listRunsBySession(uid, sid)).at(-1);
  assert.equal(aborted?.status, "cancelled");
  assert.equal(aborted?.cancelRequested, true);

  // 同 cookie 重试：租约已释放，新 planner 正常接管并完成。
  const retry = await post(stack.base, { message: "重来" }, withCookie(uid));
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.json(), { kind: "clarification", question: "断连后继续" });
  const runs = await stack.sessions.listRunsBySession(uid, sid);
  assert.equal(runs.at(-1)?.status, "completed");
  assert.equal(runs.at(-2)?.status, "cancelled");
});

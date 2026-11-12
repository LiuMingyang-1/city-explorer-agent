/**
 * Web 全链路 E2E（会话边界）：不同 cookie 的对话完全隔离；同一用户每次
 * 访问各建独立 main 对话；session_id 校验矩阵（不存在/跨用户/child →
 * 404，归档/租约忙 → 409，畸形 → 400）；关闭 service 与两个库连接并
 * 重开后，同一 cookie + session_id 恢复同一对话与当前行程。
 * 整栈与库装配见 web-e2e-fixture.ts。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { Itinerary } from "../src/itinerary/types.ts";
import type { ChatHistory, ChatResult } from "../src/web/types.ts";
import { DAY1, envelope, exhibition, stopsAt } from "./e2e-fixture.ts";
import {
  closeWeb,
  cookieUserId,
  getHistory,
  openWeb,
  post,
  seededEventsPath,
  tempDir,
  withCookie,
} from "./web-e2e-fixture.ts";

test("不同 cookie 完全隔离：各自对话、当前行程互不可见，跨用户 session_id 一律 404", async (t) => {
  const dir = tempDir(t);
  const stack = await openWeb(t, {
    eventsPath: seededEventsPath(dir),
    sessionsPath: join(dir, "sessions.db"),
  });

  const ev1 = await exhibition(stack.repository, DAY1);
  stack.faux.setResponses([
    fauxAssistantMessage(
      envelope(
        { date: DAY1, summary: "u-a 的行程", stops: [stopsAt(ev1.id)("13:00", "14:00")] },
        { date: DAY1, availableStart: "13:00", availableEnd: "18:00" },
      ),
    ),
    fauxAssistantMessage('{"type":"clarify","question":"u-b 想去哪？"}'),
  ]);

  const firstA = await getHistory(stack.base);
  const uidA = cookieUserId(firstA) as string;
  const sentA = await post(stack.base, { message: "安排" }, withCookie(uidA));
  assert.equal(sentA.status, 200);
  const sidA = (sentA.json() as ChatResult).session_id;

  // 全新访客（无 cookie）→ 另铸 uid；无 session_id 时历史恒空、不建行。
  const firstB = await getHistory(stack.base);
  const uidB = cookieUserId(firstB) as string;
  assert.ok(uidB && uidB !== uidA);
  const emptyB = firstB.json() as ChatHistory;
  assert.deepEqual(emptyB.messages, []);
  assert.equal(emptyB.itinerary, null);
  // u-b 拿 u-a 的 session_id 发消息/读历史：统一 404，不泄露存在性。
  const stolenSend = await post(
    stack.base,
    { message: "偷看", session_id: sidA },
    withCookie(uidB),
  );
  assert.equal(stolenSend.status, 404);
  const stolenHistory = await getHistory(stack.base, uidB, sidA);
  assert.equal(stolenHistory.status, 404);

  const sentB = await post(stack.base, { message: "我也想去" }, withCookie(uidB));
  const resultB = sentB.json() as Extract<ChatResult, { kind: "clarification" }>;
  assert.equal(resultB.kind, "clarification");
  assert.equal(resultB.question, "u-b 想去哪？");
  const sidB = resultB.session_id;
  assert.notEqual(sidB, sidA); // u-b 自己的独立对话

  const hB = (await getHistory(stack.base, uidB, sidB)).json() as ChatHistory;
  assert.deepEqual(hB.messages, [
    { role: "user", text: "我也想去" },
    { role: "assistant", text: "u-b 想去哪？" },
  ]);
  assert.equal(hB.itinerary, null);

  // u-a 侧不受影响：行程仍是自己的，消息不回灌 u-b 的轮次。
  const hA = (await getHistory(stack.base, uidA, sidA)).json() as ChatHistory;
  assert.deepEqual(hA.messages, [{ role: "user", text: "安排" }]);
  assert.equal((hA.itinerary as Itinerary | null)?.summary, "u-a 的行程");

  // 存储层也分属两条不同的 main 会话。
  const sessA = await stack.sessions.getSession(uidA, sidA);
  const sessB = await stack.sessions.getSession(uidB, sidB);
  assert.equal(sessA?.kind, "main");
  assert.equal(sessB?.kind, "main");
});

test("同一用户每次访问各建独立 main 对话；显式 session_id 续用指定对话", async (t) => {
  const dir = tempDir(t);
  const stack = await openWeb(t, {
    eventsPath: seededEventsPath(dir),
    sessionsPath: join(dir, "sessions.db"),
  });
  stack.faux.setResponses([
    fauxAssistantMessage('{"type":"clarify","question":"第一轮"}'), // 对话 1 首轮
    fauxAssistantMessage('{"type":"clarify","question":"第二轮"}'), // 对话 1 续轮
    fauxAssistantMessage('{"type":"clarify","question":"另一个对话"}'), // 对话 2
  ]);
  const first = await getHistory(stack.base);
  const uid = cookieUserId(first) as string;

  // 对话 1：两轮（首轮建会话，第二轮显式续用）。
  const r1 = await post(stack.base, { message: "第一条" }, withCookie(uid));
  const sid1 = (r1.json() as ChatResult).session_id;
  const r1b = await post(
    stack.base,
    { message: "接着", session_id: sid1 },
    withCookie(uid),
  );
  assert.equal((r1b.json() as ChatResult).session_id, sid1);

  // 对话 2：不带 session_id 再发 → 独立新对话，不回灌对话 1 的消息。
  const r2 = await post(stack.base, { message: "另起炉灶" }, withCookie(uid));
  const sid2 = (r2.json() as ChatResult).session_id;
  assert.notEqual(sid2, sid1);

  const conversations = await stack.sessions.listSessions(uid);
  assert.equal(conversations.length, 2);
  assert.ok(conversations.every((s) => s.kind === "main" && s.parentSessionId === null));

  const h1 = (await getHistory(stack.base, uid, sid1)).json() as ChatHistory;
  assert.deepEqual(h1.messages, [
    { role: "user", text: "第一条" },
    { role: "assistant", text: "第一轮" },
    { role: "user", text: "接着" },
    { role: "assistant", text: "第二轮" },
  ]);
  const h2 = (await getHistory(stack.base, uid, sid2)).json() as ChatHistory;
  assert.deepEqual(h2.messages, [
    { role: "user", text: "另起炉灶" },
    { role: "assistant", text: "另一个对话" },
  ]);
});

test("session_id 校验矩阵：不存在/child → 404，归档/租约忙 → 409，畸形 → 400，均不误 500", async (t) => {
  const dir = tempDir(t);
  const stack = await openWeb(t, {
    eventsPath: seededEventsPath(dir),
    sessionsPath: join(dir, "sessions.db"),
  });
  stack.faux.setResponses([
    fauxAssistantMessage('{"type":"clarify","question":"q1"}'),
    fauxAssistantMessage('{"type":"clarify","question":"q2"}'),
    fauxAssistantMessage('{"type":"clarify","question":"q3"}'),
  ]);
  const first = await getHistory(stack.base);
  const uid = cookieUserId(first) as string;
  const cookie = withCookie(uid);

  const r1 = await post(stack.base, { message: "建对话" }, cookie);
  const sid1 = (r1.json() as ChatResult).session_id;
  const r2 = await post(stack.base, { message: "留来归档" }, cookie);
  const sid2 = (r2.json() as ChatResult).session_id;

  // 造 child 会话与归档会话（库层直改，模拟内部状态）。
  const w1 = await stack.sessions.acquireLease(uid, sid1, "test", 60_000);
  assert.ok(w1);
  const child = await stack.sessions.createChildSession(w1, uid, {
    parentSessionId: sid1,
    title: "子任务",
  });
  await stack.sessions.releaseLease(w1, uid, sid1);
  const w2 = await stack.sessions.acquireLease(uid, sid2, "test", 60_000);
  assert.ok(w2);
  await stack.sessions.archiveSession(w2, uid, sid2);

  // 404：不存在 / child；POST 与 GET 同口径，不泄露内部会话存在性。
  for (const sid of ["conv_nope", child.sessionId]) {
    assert.equal((await post(stack.base, { message: "hi", session_id: sid }, cookie)).status, 404, sid);
    assert.equal((await getHistory(stack.base, uid, sid)).status, 404, sid);
  }
  // 409：已归档。
  assert.equal((await post(stack.base, { message: "hi", session_id: sid2 }, cookie)).status, 409);
  assert.equal((await getHistory(stack.base, uid, sid2)).status, 409);
  // 409：同会话写租约被另一写者占用。
  const busy = await stack.sessions.acquireLease(uid, sid1, "other-writer", 60_000);
  assert.ok(busy);
  assert.equal(
    (await post(stack.base, { message: "并发", session_id: sid1 }, cookie)).status,
    409,
  );
  await stack.sessions.releaseLease(busy, uid, sid1);
  // 400：畸形 session_id。
  assert.equal((await post(stack.base, { message: "hi", session_id: 42 }, cookie)).status, 400);
  assert.equal((await post(stack.base, { message: "hi", session_id: "" }, cookie)).status, 400);
  assert.equal(
    (await getHistory(stack.base, uid)).status === 200 &&
      (await post(stack.base, { message: "hi", session_id: sid1 }, cookie)).status === 200,
    true,
    "租约释放+合法请求对照组应放行",
  );
});

test("关闭 service/两个库并重开后：同一 cookie + session_id 恢复同一对话与当前行程", async (t) => {
  const dir = tempDir(t);
  const eventsPath = seededEventsPath(dir);
  const sessionsPath = join(dir, "sessions.db");

  const a = await openWeb(t, { eventsPath, sessionsPath });
  const ev1 = await exhibition(a.repository, DAY1);
  const plan: Itinerary = {
    date: DAY1,
    summary: "重启前定的行程",
    stops: [stopsAt(ev1.id)("13:00", "14:00")],
  };
  a.faux.setResponses([
    fauxAssistantMessage(
      envelope(plan, { date: DAY1, availableStart: "13:00", availableEnd: "18:00" }),
    ),
  ]);
  const first = await getHistory(a.base);
  const uid = cookieUserId(first) as string;
  const sent = await post(a.base, { message: "安排一下" }, withCookie(uid));
  assert.equal(sent.status, 200);
  const sid = (sent.json() as ChatResult).session_id;
  await closeWeb(a); // 关掉 HTTP/service/两个库连接——模拟进程重启

  // 全新连接与 service 实例重开同两个库文件：同一 session_id 恢复对话。
  const b = await openWeb(t, { eventsPath, sessionsPath });
  const sess = await b.sessions.getSession(uid, sid);
  assert.equal(sess?.status, "active");
  const h = (await getHistory(b.base, uid, sid)).json() as ChatHistory;
  assert.deepEqual(h.messages, [{ role: "user", text: "安排一下" }]);
  assert.deepEqual(h.itinerary, plan);
  assert.deepEqual(
    h.events?.map((e) => e.event_id),
    [ev1.id],
  );
  assert.equal(h.events?.[0]?.venue_name, ev1.venueName);

  // 重开后仍可继续写：同一 session_id 续轮走完整链路正常返回。
  b.faux.setResponses([fauxAssistantMessage('{"type":"clarify","question":"重启后继续"}')]);
  const again = await post(
    b.base,
    { message: "继续", session_id: sid },
    withCookie(uid),
  );
  assert.equal(again.status, 200);
  assert.deepEqual(again.json(), {
    kind: "clarification",
    session_id: sid,
    question: "重启后继续",
  });
});

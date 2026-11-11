/**
 * Web 全链路 E2E（会话边界）：不同 cookie 的历史/当前行程完全隔离；
 * 关闭 service 与两个库连接并重开后，同一 cookie 恢复同一主会话。
 * 整栈与库装配见 web-e2e-fixture.ts。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { Itinerary } from "../src/itinerary/types.ts";
import type { ChatHistory } from "../src/web/types.ts";
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

test("不同 cookie 完全隔离：历史、当前行程互不可见", async (t) => {
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

  // 全新访客（无 cookie）→ 另铸 uid；看不到 u-a 的任何消息与行程。
  const firstB = await getHistory(stack.base);
  const uidB = cookieUserId(firstB) as string;
  assert.ok(uidB && uidB !== uidA);
  const emptyB = firstB.json() as ChatHistory;
  assert.deepEqual(emptyB.messages, []);
  assert.equal(emptyB.itinerary, null);

  const sentB = await post(stack.base, { message: "我也想去" }, withCookie(uidB));
  assert.deepEqual(sentB.json(), { kind: "clarification", question: "u-b 想去哪？" });
  const hB = (await getHistory(stack.base, uidB)).json() as ChatHistory;
  assert.deepEqual(hB.messages, [
    { role: "user", text: "我也想去" },
    { role: "assistant", text: "u-b 想去哪？" },
  ]);
  assert.equal(hB.itinerary, null);

  // u-a 侧不受影响：行程仍是自己的，消息不回灌 u-b 的轮次。
  const hA = (await getHistory(stack.base, uidA)).json() as ChatHistory;
  assert.deepEqual(hA.messages, [{ role: "user", text: "安排" }]);
  assert.equal((hA.itinerary as Itinerary | null)?.summary, "u-a 的行程");

  // 存储层也分属两个主会话。
  const mainA = await stack.sessions.getMainSession(uidA);
  const mainB = await stack.sessions.getMainSession(uidB);
  assert.notEqual(mainA.sessionId, mainB.sessionId);
});

test("关闭 service/两个库并重开后：同一 cookie 恢复同一主会话与当前行程", async (t) => {
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
  const sidA = (await a.sessions.getMainSession(uid)).sessionId;
  await closeWeb(a); // 关掉 HTTP/service/两个库连接——模拟进程重启

  // 全新连接与 service 实例重开同两个库文件：上下文从会话库恢复。
  const b = await openWeb(t, { eventsPath, sessionsPath });
  const sidB = (await b.sessions.getMainSession(uid)).sessionId;
  assert.equal(sidB, sidA);
  const h = (await getHistory(b.base, uid)).json() as ChatHistory;
  assert.deepEqual(h.messages, [{ role: "user", text: "安排一下" }]);
  assert.deepEqual(h.itinerary, plan);
  assert.deepEqual(
    h.events?.map((e) => e.event_id),
    [ev1.id],
  );
  assert.equal(h.events?.[0]?.venue_name, ev1.venueName);

  // 重开后仍可继续写：新一轮澄清走完整链路正常返回。
  b.faux.setResponses([fauxAssistantMessage('{"type":"clarify","question":"重启后继续"}')]);
  const again = await post(b.base, { message: "继续" }, withCookie(uid));
  assert.equal(again.status, 200);
  assert.deepEqual(again.json(), { kind: "clarification", question: "重启后继续" });
});

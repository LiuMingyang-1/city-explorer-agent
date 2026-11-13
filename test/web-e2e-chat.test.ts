/**
 * Web 全链路 E2E（chat 主流程）：首访签发匿名 cookie 且空页面不产生会话行；
 * 首条 POST 懒建对话回传 session_id，同页后续轮显式带它续用同一对话——
 * 澄清 → 行程 → 修改行程；GET history?session_id= 的当前行程走独立
 * 字段+卡片 events，不重复进 messages。整栈与库装配见 web-e2e-fixture.ts。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { Itinerary } from "../src/itinerary/types.ts";
import type { ChatHistory, ChatResult, EventView } from "../src/web/types.ts";
import { DAY1, envelope, exhibition, stopsAt } from "./e2e-fixture.ts";
import {
  cookieUserId,
  getHistory,
  openWeb,
  post,
  seededEventsPath,
  tempDir,
  withCookie,
} from "./web-e2e-fixture.ts";

test("空页面只发 cookie 不建行；首条 POST 懒建对话并回传 session_id，同页续轮", async (t) => {
  const dir = tempDir(t);
  const stack = await openWeb(t, {
    eventsPath: seededEventsPath(dir),
    sessionsPath: join(dir, "sessions.db"),
  });

  const ev1 = await exhibition(stack.repository, DAY1);
  const talk = (await stack.repository.search({ date: DAY1, category: "讲座" }))[0];
  assert.ok(talk, "种子库应有讲座活动");
  assert.ok(talk.startAt !== null && talk.endAt !== null);
  const planA: Itinerary = {
    date: DAY1,
    summary: "初版：单站看展",
    stops: [stopsAt(ev1.id)("13:00", "14:00")],
  };
  const planB: Itinerary = {
    date: DAY1,
    summary: "改后：看展再听讲座",
    stops: [
      stopsAt(ev1.id)("13:00", "14:00"),
      stopsAt(talk.id)(talk.startAt.slice(11, 16), talk.endAt.slice(11, 16)),
    ],
  };
  stack.faux.setResponses([
    fauxAssistantMessage('{"type":"clarify","question":"哪天去？"}'),
    fauxAssistantMessage(
      envelope(planA, { date: DAY1, availableStart: "13:00", availableEnd: "18:00" }),
    ),
    // 时段约束沿用上一轮已确认值（补丁只带 date）。
    fauxAssistantMessage(envelope(planB, { date: DAY1 })),
  ]);

  // 1) 首访 GET history：签发匿名身份 cookie，返回空历史——且库里
  //    不产生任何用户/会话行（对话在首条 POST 时才懒建）。
  const first = await getHistory(stack.base);
  assert.equal(first.status, 200);
  const setCookie = first.headers["set-cookie"]?.[0] ?? "";
  assert.match(setCookie, /chat_uid=[0-9a-f]{32}/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  const uid = cookieUserId(first) as string;
  assert.ok(uid);
  const empty = first.json() as ChatHistory;
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.itinerary, null);
  assert.deepEqual(await stack.sessions.listSessions(uid), []);
  assert.equal(await stack.sessions.getUser(uid), undefined);

  // 2) 首条 POST（不带 session_id）：懒建对话，澄清透传，响应回传 session_id；
  //    身份复用 cookie，不重发 Set-Cookie。
  const r1 = await post(stack.base, { message: "想出门" }, withCookie(uid));
  assert.equal(r1.status, 200);
  const firstResult = r1.json() as Extract<ChatResult, { kind: "clarification" }>;
  assert.equal(firstResult.kind, "clarification");
  assert.equal(firstResult.question, "哪天去？");
  const sid = firstResult.session_id;
  assert.equal(typeof sid, "string");
  assert.ok(sid.length > 0);
  assert.equal(r1.headers["set-cookie"], undefined);
  // 对话已落库：kind='main'、title 取首条消息。
  const conv = await stack.sessions.getSession(uid, sid);
  assert.equal(conv?.kind, "main");
  assert.equal(conv?.title, "想出门");

  // 3) 同页续轮：带 session_id 走同一对话，返回校验后行程 + EventView。
  const r2 = await post(
    stack.base,
    { message: "周六下午半天", session_id: sid },
    withCookie(uid),
  );
  assert.equal(r2.status, 200);
  const it2 = r2.json() as Extract<ChatResult, { kind: "plans" }>;
  assert.equal(it2.kind, "plans");
  assert.equal(it2.mode, "single");
  assert.equal(it2.active_plan, "A");
  assert.equal(it2.coordinate_system, "GCJ-02");
  assert.equal(it2.session_id, sid);
  assert.equal(it2.plans.length, 1);
  assert.equal(it2.plans[0].label, "A");
  assert.deepEqual(it2.plans[0].itinerary, planA);
  // legs 本期恒空（由高德算路工作流填充）；校验视图恒 passed。
  assert.deepEqual(it2.plans[0].legs, []);
  assert.equal(it2.plans[0].validation.status, "passed");
  assert.deepEqual(
    it2.events.map((e) => e.event_id),
    [ev1.id],
  );
  const view1: EventView = it2.events[0];
  assert.equal(view1.title, ev1.title);
  assert.equal(view1.venue_name, ev1.venueName);
  assert.equal(view1.latitude, ev1.latitude);
  assert.equal(view1.longitude, ev1.longitude);
  // 只出线上契约的 snake_case 键，不透传存储层 camelCase。
  assert.ok(!("id" in view1) && !("venueName" in view1) && !("startAt" in view1));

  // 4) 同对话修改轮：新行程多一站讲座（产生新的当前行程指针）。
  const r3 = await post(
    stack.base,
    { message: "听完讲座再去", session_id: sid },
    withCookie(uid),
  );
  const it3 = r3.json() as Extract<ChatResult, { kind: "plans" }>;
  assert.equal(it3.kind, "plans");
  assert.equal(it3.mode, "single");
  assert.equal(it3.session_id, sid);
  assert.equal(it3.plans.length, 1);
  assert.deepEqual(it3.plans[0].itinerary, planB);
  assert.deepEqual(
    it3.events.map((e) => e.event_id),
    [ev1.id, talk.id],
  );

  // 每次 send 的 planner 用完即关：会话租约不残留 owner；三轮 run 全 completed。
  const sess = await stack.sessions.getSession(uid, sid);
  assert.equal(sess?.leaseOwner, null);
  const runs = await stack.sessions.listRunsBySession(uid, sid);
  assert.equal(runs.length, 3);
  assert.ok(runs.every((r) => r.status === "completed"));

  // 5) GET history?session_id=：当前行程（planB）走独立字段+卡片 events，
  //    不重复进 messages；被替换的 planA 只留摘要文本，不再出卡片。
  const h = (await getHistory(stack.base, uid, sid)).json() as ChatHistory;
  assert.deepEqual(h.messages, [
    { role: "user", text: "想出门" },
    { role: "assistant", text: "哪天去？" },
    { role: "user", text: "周六下午半天" },
    { role: "assistant", text: "初版：单站看展" },
    { role: "user", text: "听完讲座再去" },
  ]);
  assert.deepEqual(h.itinerary, planB);
  assert.deepEqual(
    h.events?.map((e) => e.event_id),
    [ev1.id, talk.id],
  );

  // 6) GET history 不带 session_id：始终空历史（本期前端不调，保留给
  //    "继续对话"入口；不产生任何额外库行）。
  const emptyAgain = (await getHistory(stack.base, uid)).json() as ChatHistory;
  assert.deepEqual(emptyAgain.messages, []);
  assert.equal(emptyAgain.itinerary, null);
  assert.deepEqual((await stack.sessions.listSessions(uid)).map((s) => s.sessionId), [sid]);
});

test("新对话 title 取首条消息前 30 个码点：超长含 emoji 截断不碎代理对", async (t) => {
  const dir = tempDir(t);
  const stack = await openWeb(t, {
    eventsPath: seededEventsPath(dir),
    sessionsPath: join(dir, "sessions.db"),
  });
  stack.faux.setResponses([
    fauxAssistantMessage('{"type":"clarify","question":"q"}'),
    fauxAssistantMessage('{"type":"clarify","question":"q2"}'),
  ]);
  const first = await getHistory(stack.base);
  const uid = cookieUserId(first) as string;

  // 20 个 emoji + 中文超长：title 恰为前 30 码点。
  const longMessage = `${"🎉".repeat(20)}然后想去${"很".repeat(30)}远`;
  const r1 = await post(stack.base, { message: longMessage }, withCookie(uid));
  assert.equal(r1.status, 200);
  const sid1 = (r1.json() as { session_id: string }).session_id;
  const conv1 = await stack.sessions.getSession(uid, sid1);
  const title1 = conv1?.title ?? "";
  assert.equal([...title1].length, 30);
  assert.ok(title1.startsWith("🎉".repeat(20)));
  // 截断点不切碎 surrogate pair：无孤立代理半区。
  for (let i = 0; i < title1.length; i++) {
    const code = title1.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = title1.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, "lead surrogate 必须有 trail 配对");
      i++;
    }
  }

  // 短消息：title 为整条消息（trim 后）。
  const r2 = await post(stack.base, { message: "  周末爬山  " }, withCookie(uid));
  const sid2 = (r2.json() as { session_id: string }).session_id;
  assert.notEqual(sid2, sid1); // 每次访问即新对话
  const conv2 = await stack.sessions.getSession(uid, sid2);
  assert.equal(conv2?.title, "周末爬山");
});

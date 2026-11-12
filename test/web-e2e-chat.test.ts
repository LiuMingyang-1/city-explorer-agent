/**
 * Web 全链路 E2E（chat 主流程）：首访签发匿名 cookie → 同 cookie
 * 澄清 → 行程 → 修改行程；GET history 的当前行程走独立字段+卡片
 * events，不重复进 messages。整栈与库装配见 web-e2e-fixture.ts。
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

test("首访签发匿名 cookie；同 cookie 澄清→行程→修改行程，history 不重复当前行程卡片", async (t) => {
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

  // 1) 首访 GET history：签发匿名身份 cookie，历史与行程为空。
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

  // 2) 同 cookie 澄清轮：身份复用，不重发 Set-Cookie。
  const r1 = await post(stack.base, { message: "想出门" }, withCookie(uid));
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.json(), { kind: "clarification", question: "哪天去？" });
  assert.equal(r1.headers["set-cookie"], undefined);

  // 3) 同 cookie 行程轮：返回校验后的行程 + event_id/venue_name/坐标 EventView。
  const r2 = await post(stack.base, { message: "周六下午半天" }, withCookie(uid));
  assert.equal(r2.status, 200);
  const it2 = r2.json() as Extract<ChatResult, { kind: "itinerary" }>;
  assert.equal(it2.kind, "itinerary");
  assert.deepEqual(it2.itinerary, planA);
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

  // 4) 同 cookie 修改轮：新行程多一站讲座（产生新的当前行程指针）。
  const r3 = await post(stack.base, { message: "听完讲座再去" }, withCookie(uid));
  const it3 = r3.json() as Extract<ChatResult, { kind: "itinerary" }>;
  assert.equal(it3.kind, "itinerary");
  assert.deepEqual(it3.itinerary, planB);
  assert.deepEqual(
    it3.events.map((e) => e.event_id),
    [ev1.id, talk.id],
  );

  // 每次 send 的 planner 用完即关：主会话租约不残留 owner；三轮 run 全部 completed。
  const main = await stack.sessions.getMainSession(uid);
  const sess = await stack.sessions.getSession(uid, main.sessionId);
  assert.equal(sess?.leaseOwner, null);
  const runs = await stack.sessions.listRunsBySession(uid, main.sessionId);
  assert.equal(runs.length, 3);
  assert.ok(runs.every((r) => r.status === "completed"));

  // 5) GET history：当前行程（planB）走独立字段+卡片 events，不重复进 messages；
  //    被替换的 planA 只留摘要文本，不再出卡片。
  const h = (await getHistory(stack.base, uid)).json() as ChatHistory;
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
});

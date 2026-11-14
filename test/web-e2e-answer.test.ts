/**
 * Issue #19 Web 全链路回归（C2 服务端 + C3 传输链）：生成方案 → POST /api/chat
 * 问答返回 {kind:"answer",text}（不带方案），GET history 恢复聊天记录与
 * 原行程指针；/api/chat/stream 同一问答经 meta→result 帧回传 answer；
 * "换成室内的"修改轮仍正常产出 plans。整栈 fixture 见 web-e2e-fixture.ts。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ChatHistory, ChatResult } from "../src/web/types.ts";
import { afternoonPlan, answerEnvelope, DAY1, envelope, exhibition, stopsAt } from "./e2e-fixture.ts";
import {
  call,
  cookieUserId,
  getHistory,
  openWeb,
  post,
  seededEventsPath,
  tempDir,
  withCookie,
} from "./web-e2e-fixture.ts";

/** answer 响应的本地期望（实现落地前 ChatResult 尚无此成员）。 */
interface AnswerResult {
  kind: "answer";
  session_id: string;
  text: string;
}

function asAnswerResult(body: unknown): AnswerResult {
  const result = body as AnswerResult & Record<string, unknown>;
  assert.equal(result.kind, "answer", `期望普通回答结果，得到 ${JSON.stringify(body)}`);
  assert.equal(typeof result.session_id, "string", "answer 必须带 session_id");
  assert.equal(typeof result.text, "string");
  assert.ok(result.text.trim().length > 0, "answer.text 不应为空");
  // 普通回答不得携带方案载荷——前端据此不渲染新卡片。
  assert.ok(!("plans" in result) && !("itinerary" in result), "answer 不得夹带方案");
  return result;
}

/** 简单 SSE 帧收集：把 body 文本切成 [{event,data}]（够用即可，不测解析器本身）。 */
function sseFrames(body: string): { event: string; data: unknown }[] {
  const frames: { event: string; data: unknown }[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) {
      frames.push({ event, data: JSON.parse(dataLines.join("\n")) });
    }
  }
  return frames;
}

test("生成方案后 HTTP 问答：answer 结果不带方案、history 恢复行程与回答", async (t) => {
  const dir = tempDir(t);
  const stack = await openWeb(t, {
    eventsPath: seededEventsPath(dir),
    sessionsPath: join(dir, "sessions.db"),
  });
  const first = await getHistory(stack.base);
  const uid = cookieUserId(first) as string;

  const ev = await exhibition(stack.repository, DAY1);
  const talk = (await stack.repository.search({ date: DAY1, category: "讲座" }))[0];
  assert.ok(talk.startAt !== null && talk.endAt !== null);
  const plan = {
    date: DAY1,
    summary: "初版：下午看展",
    stops: [stopsAt(ev.id)("13:00", "14:00")],
  };
  const weatherText = "明天多云转阴，18–24℃，基本不影响出行。";
  const bookingText = "第二站公益讲座免费但需提前预约，建议今天内登记。";
  const modified = {
    date: DAY1,
    summary: "改后：看展再听室内讲座",
    stops: [
      stopsAt(ev.id)("13:00", "13:50"),
      stopsAt(talk.id)(talk.startAt.slice(11, 16), talk.endAt.slice(11, 16)),
    ],
  };
  stack.faux.setResponses([
    afternoonPlan(ev),
    fauxAssistantMessage(answerEnvelope(weatherText)),
    fauxAssistantMessage(answerEnvelope(bookingText)),
    fauxAssistantMessage(
      envelope(modified, { date: DAY1, availableStart: "13:00", availableEnd: "18:00" }),
    ),
  ]);

  // 1) 规划轮（plan 响应里 summary 与自定义 plan 一致，故直接复用 afternoonPlan 的形状断言）。
  const r1 = await post(stack.base, { message: "周六下午想看展" }, withCookie(uid));
  assert.equal(r1.status, 200);
  const plans1 = r1.json() as Extract<ChatResult, { kind: "plans" }>;
  assert.equal(plans1.kind, "plans");
  const sid = plans1.session_id;
  const committedItinerary = plans1.plans[0].itinerary;

  // 2) 天气问答：answer 结果——同会话、只有文本、不夹带方案。
  const r2 = await post(
    stack.base,
    { message: "明天天气怎么样", session_id: sid },
    withCookie(uid),
  );
  assert.equal(r2.status, 200);
  const a2 = asAnswerResult(r2.json());
  assert.equal(a2.session_id, sid);
  assert.equal(a2.text, weatherText);

  // 3) 预约问答：第二个 answer，同样无副作用。
  const r3 = await post(
    stack.base,
    { message: "第二站需要预约吗", session_id: sid },
    withCookie(uid),
  );
  assert.equal(r3.status, 200);
  assert.equal(asAnswerResult(r3.json()).text, bookingText);

  // 4) history：问答进了聊天记录，原行程指针与方案视图仍在。
  const h1 = (await getHistory(stack.base, uid, sid)).json() as ChatHistory;
  assert.deepEqual(h1.messages, [
    { role: "user", text: "周六下午想看展" },
    // 产生当前行程的 run 由卡片替代，不进 messages。
    { role: "user", text: "明天天气怎么样" },
    { role: "assistant", text: weatherText },
    { role: "user", text: "第二站需要预约吗" },
    { role: "assistant", text: bookingText },
  ]);
  assert.deepEqual(h1.itinerary, committedItinerary);
  assert.deepEqual(h1.events?.map((e) => e.event_id), [ev.id]);
  // 期望契约：最近的方案轮仍在，刷新后行程卡片可恢复（若实现选择
  // "answer 后不还原 plans"，此处失败——提交 reviewer 裁决）。
  assert.equal(h1.mode, "single", "answer 后方案视图应仍按最近方案轮还原");
  assert.equal(h1.active_plan, "A");
  assert.equal(h1.plans?.length, 1);
  assert.deepEqual(h1.plans?.[0].itinerary, committedItinerary);

  // 5) "换成室内的"：修改轮正常出 plans；history 换成新指针。
  const r4 = await post(
    stack.base,
    { message: "那帮我换成室内的", session_id: sid },
    withCookie(uid),
  );
  assert.equal(r4.status, 200);
  const plans4 = r4.json() as Extract<ChatResult, { kind: "plans" }>;
  assert.equal(plans4.kind, "plans");
  assert.deepEqual(plans4.plans[0].itinerary, modified);
  const h2 = (await getHistory(stack.base, uid, sid)).json() as ChatHistory;
  assert.deepEqual(h2.itinerary, modified);
  assert.ok(
    h2.messages.some((m) => m.role === "assistant" && m.text === weatherText),
    "修改轮之后 answer 历史仍保留",
  );
});

test("POST /api/chat/stream：answer 经 meta→result 帧回传，无 error/progress 副作用", async (t) => {
  const dir = tempDir(t);
  const stack = await openWeb(t, {
    eventsPath: seededEventsPath(dir),
    sessionsPath: join(dir, "sessions.db"),
  });
  const first = await getHistory(stack.base);
  const uid = cookieUserId(first) as string;
  const ev = await exhibition(stack.repository, DAY1);
  const weatherText = "明天晴，16–25℃。";
  stack.faux.setResponses([afternoonPlan(ev), fauxAssistantMessage(answerEnvelope(weatherText))]);

  const r1 = await post(stack.base, { message: "周六下午想看展" }, withCookie(uid));
  const sid = (r1.json() as { session_id: string }).session_id;

  const res = await call(stack.base, "/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...withCookie(uid) },
    body: JSON.stringify({ message: "明天天气怎么样", session_id: sid }),
  });
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /text\/event-stream/);
  const frames = sseFrames(res.body);
  const kinds = frames.map((f) => f.event);
  assert.equal(kinds[0], "meta");
  assert.equal((frames[0].data as { session_id: string }).session_id, sid);
  assert.equal(kinds.at(-1), "result");
  const result = asAnswerResult(frames.at(-1)!.data);
  assert.equal(result.text, weatherText);
  assert.equal(result.session_id, sid);
  assert.ok(!kinds.includes("error"), "answer 轮不得产生 error 帧");
});

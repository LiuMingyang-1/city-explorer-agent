/**
 * Issue #19 多轮状态保护回归（C2，持久化层）：生成方案 → answer 问答 →
 * 原行程指针、已确认约束、方案/消息历史全部保留 → close+reopen 恢复 →
 * "换成室内的"修改成功并推进指针。answer 轮照常落库（run completed、
 * user/assistant 消息追加），只是不触碰 current_itinerary 指针与约束。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { parseStoredMessagePayload } from "../src/session/payload.ts";
import {
  afternoonPlan,
  answerEnvelope,
  comparisonEnvelope,
  DAY1,
  envelope,
  exhibition,
  makePersistent,
  stopsAt,
} from "./e2e-fixture.ts";
import { asText, messageRecords } from "./persistent-fixture.ts";
import { openMemoryRepo } from "./session-fixture.ts";

test("answer 轮落库但不挪指针；重开后原方案/约束/历史恢复，修改轮正常提交", async (t) => {
  const sessions = openMemoryRepo(t);
  const first = await makePersistent(t, [], { sessions });
  const ev = await exhibition(first.repo, DAY1);
  const talk = (await first.repo.search({ date: DAY1, category: "讲座" }))[0];
  assert.ok(talk.startAt !== null && talk.endAt !== null);
  const weatherText = "明天多云转阴，18–24℃，基本不影响出行。";
  const modified = {
    date: DAY1,
    summary: "改后：看展再听室内讲座",
    stops: [
      stopsAt(ev.id)("13:00", "13:50"),
      stopsAt(talk.id)(talk.startAt.slice(11, 16), talk.endAt.slice(11, 16)),
    ],
  };
  first.faux.setResponses([afternoonPlan(ev), fauxAssistantMessage(answerEnvelope(weatherText))]);

  // 1) 规划轮：指针提交到本条 assistant 消息。
  const t1 = await first.session.prompt("周六下午想看展");
  assert.equal(t1.kind, "itinerary");
  const sid = first.session.sessionId as string;
  const planPointer = await sessions.getCurrentItinerary("u-test", sid);
  assert.ok(planPointer);
  const committedConstraints = first.session.constraints;
  const messagesAfterPlan = await messageRecords(sessions, sid);

  // 2) 问答轮：turn 为 answer；run completed 且结果存的是 answer turn；
  //    消息照常追加；行程指针与已确认约束原样保留。
  const t2 = await first.session.prompt("明天天气怎么样");
  assert.equal(t2.kind, "answer", `期望普通回答轮，得到 ${JSON.stringify(t2)}`);
  assert.equal((t2 as unknown as { text?: unknown }).text, weatherText);
  const runs = await sessions.listRunsBySession("u-test", sid);
  assert.equal(runs.length, 2);
  const answerRun = runs[1];
  assert.equal(answerRun.status, "completed");
  const storedTurn = (JSON.parse(answerRun.result as string) as { turn: { kind?: unknown; text?: unknown } }).turn;
  assert.equal(storedTurn.kind, "answer");
  assert.equal(storedTurn.text, weatherText);
  assert.ok(!("itinerary" in storedTurn) && !("plans" in storedTurn), "answer 轮不得携带方案");

  const messagesAfterAnswer = await messageRecords(sessions, sid);
  assert.equal(messagesAfterAnswer.length, messagesAfterPlan.length + 2, "answer 应只追加 user+assistant 两条");
  const stored = messagesAfterAnswer.map((r) => parseStoredMessagePayload(r.payload, r.recordId).message);
  assert.ok(asText(stored[stored.length - 2]).includes("明天天气怎么样"), "user 消息应落库");
  assert.ok(asText(stored[stored.length - 1]).includes(weatherText), "assistant 回答文本应落库");

  // 指针、内存行程与约束全部未动。
  const pointerAfterAnswer = await sessions.getCurrentItinerary("u-test", sid);
  assert.equal(pointerAfterAnswer?.record.recordId, planPointer.record.recordId);
  assert.deepEqual(first.session.itinerary, planPointer.plan.itinerary);
  assert.deepEqual(first.session.constraints, committedConstraints);
  await first.session.close();

  // 3) 重开同一会话：原方案/约束恢复，问答历史仍在上下文里。
  const second = await makePersistent(t, [], {
    sessions,
    repository: first.repo,
    sessionId: sid,
  });
  assert.deepEqual(second.session.itinerary, planPointer.plan.itinerary);
  assert.deepEqual(second.session.constraints, committedConstraints);
  const restored = second.session.agent.state.messages;
  assert.ok(asText(restored).includes("明天天气怎么样"), "重开后问答输入应恢复");
  assert.ok(asText(restored).includes(weatherText), "重开后 answer 文本应恢复");
  assert.ok(asText(restored[0]).includes(ev.id), "已确认行程仍注入 system section");

  // 4) "换成室内的"修改轮：理解原方案上下文，新行程提交并推进指针。
  second.faux.setResponses([
    fauxAssistantMessage(
      envelope(modified, { date: DAY1, availableStart: "13:00", availableEnd: "18:00" }),
    ),
  ]);
  const t3 = await second.session.prompt("那帮我换成室内的");
  assert.equal(t3.kind, "itinerary", JSON.stringify(t3));
  if (t3.kind !== "itinerary") return;
  assert.deepEqual(t3.itinerary, modified);
  const finalPointer = await sessions.getCurrentItinerary("u-test", sid);
  assert.ok(finalPointer);
  assert.notEqual(finalPointer.record.recordId, planPointer.record.recordId);
  assert.deepEqual(finalPointer.plan.itinerary, modified);
});

/**
 * C5：comparison → 界面选中 B → answer → 重开 → 修改 的选择上下文回归。
 * active_plan 注入的前提是"最近一轮产出过 comparison"（latestProducedTurn
 * 由落库 run 重建、跳过 answer 轮）——answer 若抢占该位置，重开后
 * active_plan:"B" 会被静默丢弃，修改请求失去选中方案上下文。
 */
test("comparison 选中 B 后 answer/重开：选择上下文仍注入修改轮，指针正常推进", async (t) => {
  const sessions = openMemoryRepo(t);
  const first = await makePersistent(t, [], { sessions });
  const ev = await exhibition(first.repo, DAY1);
  const constraintsV1 = { date: DAY1, availableStart: "13:00", availableEnd: "18:00" };
  const planA = {
    date: DAY1,
    summary: "A：上午看展",
    stops: [stopsAt(ev.id)("13:00", "14:00")],
  };
  const planB = {
    date: DAY1,
    summary: "B：下午看展",
    stops: [stopsAt(ev.id)("14:00", "15:00")],
  };
  const bookingText = "B 方案那一站免费、凭身份证入场即可，不需要预约。";
  const modified = {
    date: DAY1,
    summary: "改后：B 线换成室内安排",
    stops: [stopsAt(ev.id)("14:00", "15:00")],
  };
  first.faux.setResponses([
    fauxAssistantMessage(
      comparisonEnvelope(
        [
          { label: "A", title: "上午线", itinerary: planA },
          { label: "B", title: "下午线", itinerary: planB },
        ],
        constraintsV1,
      ),
    ),
    fauxAssistantMessage(answerEnvelope(bookingText)),
  ]);

  // 1) comparison 轮：首个 plan 提交为当前行程指针。
  const t1 = await first.session.prompt("上午下午都行，给我两个方向");
  assert.equal(t1.kind, "comparison");
  const sid = first.session.sessionId as string;
  const pointerA = await sessions.getCurrentItinerary("u-test", sid);
  assert.ok(pointerA);
  assert.equal((pointerA.plan.itinerary as { summary?: string }).summary, "A：上午看展");

  // 2) 界面选中 B 后问答：只追加聊天，指针不动。
  const t2 = await first.session.prompt("B 方案需要预约吗", { activePlan: "B" });
  assert.equal(t2.kind, "answer", JSON.stringify(t2));
  const pointerAfterAnswer = await sessions.getCurrentItinerary("u-test", sid);
  assert.equal(pointerAfterAnswer?.record.recordId, pointerA.record.recordId);
  await first.session.close();

  // 3) 重开：answer 轮不得抢占"最近产出方案轮"的位置——修改请求仍应带着
  //    "用户当前选中的方案：B" 的界面选择节（证明上下文链没断）；answer 文本
  //    也照常留在对话上下文里。
  const second = await makePersistent(t, [], {
    sessions,
    repository: first.repo,
    sessionId: sid,
  });
  let sawSelectionB = false;
  let sawAnswerContext = false;
  second.faux.setResponses([
    (context) => {
      const systemText = JSON.stringify(
        (context.messages as Array<{ role?: string }>).filter((m) => m.role === "system"),
      );
      sawSelectionB = systemText.includes("用户当前选中的方案：B");
      sawAnswerContext = JSON.stringify(context.messages).includes(bookingText);
      return fauxAssistantMessage(envelope(modified, constraintsV1));
    },
  ]);
  const t3 = await second.session.prompt("那帮我换成室内的", { activePlan: "B" });
  assert.equal(t3.kind, "itinerary", JSON.stringify(t3));
  assert.ok(sawSelectionB, "answer+重开后修改轮仍应注入 B 的界面选择节");
  assert.ok(sawAnswerContext, "answer 文本应仍在重开后的上下文中");
  const finalPointer = await sessions.getCurrentItinerary("u-test", sid);
  assert.ok(finalPointer);
  assert.notEqual(finalPointer.record.recordId, pointerA.record.recordId);
  assert.deepEqual(finalPointer.plan.itinerary, modified);
});

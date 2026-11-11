import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { latestCandidatePlan } from "../src/agent/persistent/runs.ts";
import type { PlannerTurn } from "../src/agent/session.ts";
import type { Run } from "../src/session/types.ts";
import {
  DAY1,
  afternoonPlan,
  envelope,
  exhibition,
  makePersistent,
} from "./e2e-fixture.ts";
import { asText, messageRecords } from "./persistent-fixture.ts";
import { makeUser, mustAcquire, openMemoryRepo } from "./session-fixture.ts";

/**
 * 统一审查回归（三）：requestId 幂等键须校验输入文本；
 * child 会话产出候选行程但不维护正式指针。
 */

test("requestId replay compares the stored text; different input conflicts", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session, repo, faux } = await makePersistent(t, [], { sessions });
  const ev = await exhibition(repo, DAY1);
  faux.setResponses([afternoonPlan(ev)]);
  const first = await session.prompt("安排展览", { requestId: "req-1" });
  assert.equal(first.kind, "itinerary");
  const sid = session.sessionId as string;
  const calls = faux.state.callCount;

  const clash = await session.prompt("完全不同的安排", { requestId: "req-1" });
  assert.equal(clash.kind, "error");
  if (clash.kind === "error") {
    assert.equal(clash.code, "request_conflict");
    assert.match(clash.message, /requestId/);
  }
  assert.equal(faux.state.callCount, calls, "冲突不得再调模型");
  const sidRuns = await sessions.listRunsBySession("u-test", sid);
  assert.equal(sidRuns.length, 1, "冲突不得新建 run");
  assert.equal((await messageRecords(sessions, sid)).length, 2, "冲突不得写消息");
  const pointer = await sessions.getCurrentItinerary("u-test", sid);
  assert.equal(pointer?.record.runId, sidRuns[0].runId, "冲突不得动指针");

  // 同键同文本仍然按既有结果重放。
  const replay = await session.prompt("安排展览", { requestId: "req-1" });
  assert.equal(replay.kind, "itinerary");
  assert.equal(faux.state.callCount, calls);
});

test("requestId replays a failed run as stored failure; conflict still rejected", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session, faux } = await makePersistent(t, [], { sessions });
  faux.setResponses([]); // 响应队列空 → error turn → failed run
  const first = await session.prompt("失败的请求", { requestId: "req-9" });
  assert.equal(first.kind, "error");
  const calls = faux.state.callCount;

  const replay = await session.prompt("失败的请求", { requestId: "req-9" });
  assert.equal(replay.kind, "error");
  if (replay.kind === "error") assert.match(replay.message, /已失败|相同请求/);
  assert.equal(faux.state.callCount, calls);

  const clash = await session.prompt("换个文本", { requestId: "req-9" });
  assert.equal(clash.kind, "error");
  if (clash.kind === "error") assert.equal(clash.code, "request_conflict");
});

test("child sessions keep candidate plans off the main itinerary pointer", async (t) => {
  const sessions = openMemoryRepo(t);
  const { main } = await makeUser(sessions, "u-child");
  const writer = await mustAcquire(sessions, "u-child", main.sessionId);
  const child = await sessions.createChildSession(writer, "u-child", {
    parentSessionId: main.sessionId,
  });
  await sessions.releaseLease(writer, "u-child", main.sessionId);

  const { session, repo, faux } = await makePersistent(t, [], {
    sessions,
    userId: "u-child",
    sessionId: child.sessionId,
  });
  const ev = await exhibition(repo, DAY1);
  faux.setResponses([afternoonPlan(ev)]);
  const turn = await session.prompt("子任务：安排下午");
  assert.equal(turn.kind, "itinerary");
  if (turn.kind === "itinerary") assert.deepEqual(session.itinerary, turn.itinerary);

  const sid = child.sessionId;
  assert.equal((await messageRecords(sessions, sid, "u-child")).length, 2);
  const run = (await sessions.listRunsBySession("u-child", sid)).at(-1);
  assert.equal(run?.status, "completed");
  const stored = JSON.parse(run?.result ?? "null") as { turn?: PlannerTurn } | null;
  assert.equal(stored?.turn?.kind, "itinerary");

  // 合法空行程同样只是会话内候选。
  faux.setResponses([
    fauxAssistantMessage(
      envelope({ date: DAY1, summary: "空行程", stops: [] }, { date: DAY1 }),
    ),
  ]);
  const empty = await session.prompt("改成空行程");
  assert.equal(empty.kind, "itinerary");

  // 后续对话正常；child 始终不设指针，main 也未被触碰。
  faux.setResponses([fauxAssistantMessage('{"type":"clarify","question":"再想想哪天"}')]);
  const follow = await session.prompt("再想想");
  assert.equal(follow.kind, "clarification");
  assert.equal((await sessions.getSession("u-child", sid))?.currentItineraryRecordId, null);
  assert.equal(await sessions.getCurrentItinerary("u-child", sid), undefined);
  assert.equal(
    (await sessions.getSession("u-child", main.sessionId))?.currentItineraryRecordId,
    null,
  );
  await session.close();

  // 重开：候选轮次的消息按原文恢复，指针仍为空。
  const reopened = await makePersistent(t, [], {
    sessions,
    userId: "u-child",
    sessionId: sid,
  });
  assert.ok(asText(reopened.session.agent.state.messages).includes("子任务：安排下午"));
  assert.equal(
    (await sessions.getSession("u-child", sid))?.currentItineraryRecordId,
    null,
  );
  assert.equal(
    (await sessions.getSession("u-child", main.sessionId))?.currentItineraryRecordId,
    null,
  );
});

/** 同毫秒时间戳下的候选 run：结果列直接存 turn JSON。 */
function itineraryRun(runId: string, stamp: string, summary: string): Run {
  const turn: PlannerTurn = {
    kind: "itinerary",
    itinerary: { date: DAY1, summary, stops: [] },
    constraints: { date: DAY1 },
  };
  return {
    runId,
    userId: "u",
    sessionId: "s",
    parentRunId: null,
    rootRunId: runId,
    replyToSessionId: null,
    status: "completed",
    input: "{}",
    result: JSON.stringify({ turn }),
    error: null,
    cancelRequested: false,
    deliveredAt: null,
    createdAt: stamp,
    startedAt: stamp,
    finishedAt: stamp,
  };
}

test("candidate restore breaks same-ms ties by message_seq, not run order", () => {
  const stamp = "2026-11-11T12:00:00.000Z";
  // 真实时钟同毫秒时 run_id 随机排序：新候选可能排在旧候选之前，
  // 决胜只能看各自已落库消息的最大 message_seq。
  const newer = itineraryRun("run-aaa", stamp, "新候选");
  const older = itineraryRun("run-zzz", stamp, "旧候选");
  const seqByRun = new Map([
    ["run-aaa", 9],
    ["run-zzz", 5],
  ]);
  const picked = latestCandidatePlan([newer, older], seqByRun);
  assert.equal(picked?.itinerary.summary, "新候选");
  // 反序输入同样结论：次序与列表顺序无关。
  const pickedReversed = latestCandidatePlan([older, newer], seqByRun);
  assert.equal(pickedReversed?.itinerary.summary, "新候选");
});

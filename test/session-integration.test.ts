import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFauxCore,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { createPersistentPlanner } from "../src/agent/session.ts";
import type { PlannerTurn } from "../src/agent/session.ts";
import { parseStoredMessagePayload } from "../src/session/payload.ts";
import type { SessionRepository } from "../src/session/repository.ts";
import { isSessionError } from "../src/session/types.ts";
import {
  CONFIG,
  DAY1,
  afternoonPlan,
  envelope,
  exhibition,
  makePersistent,
} from "./e2e-fixture.ts";
import {
  LOOSE,
  asText,
  compactionRecords,
  messageRecords,
  slowStream,
  until,
} from "./persistent-fixture.ts";
import {
  assistantMessage,
  mustAcquire,
  openMemoryRepo,
  toolResultMessage,
  userMessage,
} from "./session-fixture.ts";

/**
 * 任务04 端到端验收（一）：打开/恢复、写路径、计划指针。
 * faux 模型 → 真实 search_events/活动库 → 会话 SQLite（:memory:）。
 * 不打真实 API、不读 .env。租约/取消/自动压缩用例见
 * session-concurrency.test.ts。
 */

// ---- 打开 / 恢复 ----

test("first prompt persists run+messages, close+reopen keeps main session and plan", async (t) => {
  const sessions = openMemoryRepo(t);
  const first = await makePersistent(t, [], { sessions });
  const ev = await exhibition(first.repo, DAY1);
  first.faux.setResponses([afternoonPlan(ev)]);
  const turn = await first.session.prompt("周六下午想看展");
  assert.equal(turn.kind, "itinerary");
  const mainId = first.session.sessionId as string;
  assert.ok(mainId);

  const runs = await sessions.listRunsBySession("u-test", mainId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "completed");
  const storedTurn = (JSON.parse(runs[0].result as string) as { turn: PlannerTurn }).turn;
  assert.equal(storedTurn.kind, "itinerary");
  const messages = await messageRecords(sessions, mainId);
  assert.equal(messages.length, 2); // user prompt + assistant 行程
  assert.ok(messages.every((m) => m.runId === runs[0].runId));
  const pointer = await sessions.getCurrentItinerary("u-test", mainId);
  assert.ok(pointer);
  assert.equal(pointer.record.recordId, messages[1].recordId);
  await first.session.close();

  const second = await makePersistent(t, [], {
    sessions,
    repository: first.repo,
    sessionId: mainId,
  });
  assert.equal(second.session.sessionId, mainId);
  assert.deepEqual(second.session.itinerary, first.session.itinerary);
  assert.deepEqual(second.session.constraints, first.session.constraints);
  const restored = second.session.agent.state.messages;
  assert.equal(restored[0].role, "system");
  assert.ok(asText(restored).includes("周六下午想看展")); // 原始消息已恢复
  assert.ok(asText(restored[0]).includes(ev.id)); // 已确认行程注入 system section
  assert.equal(restored.filter((m) => m.role === "system").length, 1);
});

test("reopen restores checkpoint, kept tail and post-checkpoint messages", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session, repo, faux } = await makePersistent(t, [], {
    sessions,
    compaction: LOOSE,
  });
  const sid = session.sessionId as string;
  // 在会话外用仓库直接播种 6 条消息（模拟更早的进程写下的历史）。
  const w = await mustAcquire(sessions, "u-test", sid);
  const pad = "x".repeat(400);
  for (const seed of [
    userMessage(`seed-1 ${pad}`),
    assistantMessage(`a1 ${pad}`),
    userMessage(`seed-2 ${pad}`),
    assistantMessage(`a2 ${pad}`),
    userMessage("seed-3 短提问"),
    assistantMessage("a3 短回答"),
  ]) {
    await sessions.appendMessage(w, "u-test", sid, { payload: { message: seed } });
  }
  await sessions.releaseLease(w, "u-test", sid);

  const compacted = await session.compact();
  assert.deepEqual(compacted, { applied: true });
  const checkpoints = await compactionRecords(sessions, sid);
  assert.equal(checkpoints.length, 1);
  const boundary = JSON.parse(checkpoints[0].payload) as {
    first_kept_message_seq: number;
    source_through_message_seq: number;
  };
  assert.equal(boundary.source_through_message_seq, 6);
  assert.ok(boundary.first_kept_message_seq > 1 && boundary.first_kept_message_seq <= 6);

  const ctx = session.agent.state.messages;
  assert.equal(ctx[0].role, "system");
  assert.equal(ctx[1].role, "user");
  assert.ok(asText(ctx[1]).includes("摘要")); // 合成摘要消息
  assert.ok(asText(ctx).includes("seed-3")); // 检查点前保留的尾部
  assert.ok(!asText(ctx).includes("seed-1"));

  const ev = await exhibition(repo, DAY1);
  faux.setResponses([afternoonPlan(ev)]);
  const turn = await session.prompt("压缩后再排一个");
  assert.equal(turn.kind, "itinerary");
  await session.close();

  const reopened = await makePersistent(t, [], { sessions, sessionId: sid });
  const ctx2 = reopened.session.agent.state.messages;
  assert.ok(asText(ctx2[1]).includes("摘要")); // 打开时重放到最新检查点
  assert.ok(asText(ctx2).includes("压缩后再排一个")); // 检查点后的新消息也在
  assert.equal((await compactionRecords(sessions, sid)).length, 1);
  assert.equal((await messageRecords(sessions, sid)).length, 8);
});

test("two consecutive compactions keep monotonic boundaries and latest wins", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session, repo, faux } = await makePersistent(t, [], {
    sessions,
    compaction: LOOSE,
  });
  const sid = session.sessionId as string;
  const w = await mustAcquire(sessions, "u-test", sid);
  const pad = "x".repeat(500);
  for (let i = 1; i <= 4; i++) {
    await sessions.appendMessage(w, "u-test", sid, {
      payload: { message: userMessage(`u${i} ${pad}`) },
    });
    await sessions.appendMessage(w, "u-test", sid, {
      payload: { message: assistantMessage(`a${i} ${pad}`) },
    });
  }
  await sessions.releaseLease(w, "u-test", sid);

  assert.deepEqual(await session.compact(), { applied: true });
  const ev = await exhibition(repo, DAY1);
  faux.setResponses([afternoonPlan(ev)]);
  const turn = await session.prompt("再来一轮");
  assert.equal(turn.kind, "itinerary");
  assert.deepEqual(await session.compact(), { applied: true });

  const checkpoints = await compactionRecords(sessions, sid);
  assert.equal(checkpoints.length, 2);
  const [c1, c2] = checkpoints.map(
    (r) =>
      JSON.parse(r.payload) as {
        first_kept_message_seq: number;
        source_through_message_seq: number;
      },
  );
  assert.equal(c1.source_through_message_seq, 8);
  assert.equal(c2.source_through_message_seq, 10);
  assert.ok(c2.first_kept_message_seq > c1.first_kept_message_seq);
  const latest = await sessions.latestCompaction("u-test", sid);
  assert.equal(latest?.record.recordId, checkpoints[1].recordId);
});

test("cross-user session open is rejected; unknown session id is rejected", async (t) => {
  const sessions = openMemoryRepo(t);
  const first = await makePersistent(t, [], { sessions, userId: "u-one" });
  const sid = first.session.sessionId as string;
  const dead = () => {
    throw new Error("should not stream");
  };
  await assert.rejects(
    createPersistentPlanner({
      config: CONFIG,
      repository: first.repo,
      sessions,
      userId: "u-two",
      sessionId: sid,
      streamFn: dead,
    }),
    (error: unknown) => isSessionError(error, "not_found"),
  );
  await assert.rejects(
    createPersistentPlanner({
      config: CONFIG,
      repository: first.repo,
      sessions,
      userId: "u-one",
      sessionId: "sess-missing",
      streamFn: dead,
    }),
    (error: unknown) => isSessionError(error, "not_found"),
  );
});

test("no sessionId opens a fresh main conversation each time; title is stored", async (t) => {
  const sessions = openMemoryRepo(t);
  const a = await makePersistent(t, [], { sessions, title: "周六看展" });
  const b = await makePersistent(t, [], { sessions });
  assert.ok(a.session.sessionId);
  assert.notEqual(a.session.sessionId, b.session.sessionId);
  const rows = await sessions.listSessions("u-test");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((s) => s.kind === "main" && s.parentSessionId === null));
  const titled = await sessions.getSession("u-test", a.session.sessionId as string);
  assert.equal(titled?.title, "周六看展");
  const untitled = await sessions.getSession("u-test", b.session.sessionId as string);
  assert.equal(untitled?.title, null);
});

test("parentRunId/replyToSessionId land on the child run; rootRunId follows the parent", async (t) => {
  const sessions = openMemoryRepo(t);
  const parent = await makePersistent(t, [], { sessions });
  const parentSid = parent.session.sessionId as string;
  const ev = await exhibition(parent.repo, DAY1);
  parent.faux.setResponses([afternoonPlan(ev)]);
  assert.equal((await parent.session.prompt("父轮安排")).kind, "itinerary");
  const parentRun = (await sessions.listRunsBySession("u-test", parentSid)).at(-1);
  assert.ok(parentRun);

  const writer = await mustAcquire(sessions, "u-test", parentSid);
  const child = await sessions.createChildSession(writer, "u-test", {
    parentSessionId: parentSid,
    title: "子任务",
  });
  await sessions.releaseLease(writer, "u-test", parentSid);

  const childPlanner = await makePersistent(t, [], {
    sessions,
    repository: parent.repo,
    sessionId: child.sessionId,
    parentRunId: parentRun.runId,
    replyToSessionId: parentSid,
    depth: 1,
  });
  childPlanner.faux.setResponses([fauxAssistantMessage('{"type":"clarify","question":"q"}')]);
  assert.equal((await childPlanner.session.prompt("子任务一轮")).kind, "clarification");
  const childRun = (await sessions.listRunsBySession("u-test", child.sessionId)).at(-1);
  assert.ok(childRun);
  assert.equal(childRun.parentRunId, parentRun.runId);
  assert.equal(childRun.replyToSessionId, parentSid);
  assert.equal(childRun.rootRunId, parentRun.rootRunId);
});

// ---- 每轮写路径 ----

test("message persistence excludes system/summary; corrections share one run", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session, repo, faux } = await makePersistent(t, [], { sessions });
  const ev = await exhibition(repo, DAY1);
  faux.setResponses([
    fauxAssistantMessage(
      envelope(
        {
          date: DAY1,
          summary: "bad",
          stops: [{ event_id: "evt_nope", arrive_at: "13:00", leave_at: "14:00", reason: "r" }],
        },
        { date: DAY1 },
      ),
    ),
    afternoonPlan(ev),
  ]);
  const turn = await session.prompt("纠正一次");
  assert.equal(turn.kind, "itinerary");
  const sid = session.sessionId as string;
  const runs = await sessions.listRunsBySession("u-test", sid);
  assert.equal(runs.length, 1); // 首轮 + 纠正 共用一个 run
  assert.equal(runs[0].status, "completed");
  const messages = await messageRecords(sessions, sid);
  assert.equal(messages.length, 4); // u, a(bad), u(纠正), a(good)
  const roles = messages.map((m) => parseStoredMessagePayload(m.payload, "t").message.role);
  assert.deepEqual(roles, ["user", "assistant", "user", "assistant"]);
});

test("requestId replays return the stored turn without another model call", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session, repo, faux } = await makePersistent(t, [], { sessions });
  const ev = await exhibition(repo, DAY1);
  faux.setResponses([afternoonPlan(ev)]);
  const first = await session.prompt("安排", { requestId: "req-1" });
  assert.equal(first.kind, "itinerary");
  const calls = faux.state.callCount;
  const replay = await session.prompt("安排", { requestId: "req-1" });
  assert.equal(faux.state.callCount, calls); // 没再打模型
  assert.equal(replay.kind, "itinerary");
  const sid = session.sessionId as string;
  assert.equal((await messageRecords(sessions, sid)).length, 2);
  assert.equal((await sessions.listRunsBySession("u-test", sid)).length, 1);

  const fresh = await session.prompt("安排", { requestId: "req-2" });
  assert.equal(fresh.kind, "error"); // 队列已空 → 新 key 正常进入新一轮
  assert.ok(faux.state.callCount > calls);
});

test("busy session rejects a second prompt and manual compact", async (t) => {
  const slow = createFauxCore({ tokensPerSecond: 25 });
  slow.setResponses([fauxAssistantMessage("x".repeat(3_000))]);
  const sessions = openMemoryRepo(t);
  const { session } = await makePersistent(t, [], { sessions, streamFn: slowStream(slow) });
  const pending = session.prompt("慢慢想");
  await until(() => slow.state.callCount > 0, "model call");
  const second = await session.prompt("插队");
  assert.equal(second.kind, "error");
  if (second.kind === "error") assert.match(second.message, /仍在处理中/);
  const compactWhileBusy = await session.compact();
  assert.equal(compactWhileBusy.applied, false);
  assert.match(compactWhileBusy.error ?? "", /仍在处理中/);
  session.cancel();
  const done = await pending;
  assert.equal(done.kind, "error");
  const run = (await sessions.listRunsBySession("u-test", session.sessionId as string)).at(-1);
  assert.equal(run?.status, "cancelled");
  assert.equal(session.busy, false);
});

// ---- 恢复补全 ----

test("reopen closes an interrupted tool batch instead of re-executing it", async (t) => {
  const sessions = openMemoryRepo(t);
  const seeded = await makePersistent(t, [], { sessions });
  const sid = seeded.session.sessionId as string;
  const w = await mustAcquire(sessions, "u-test", sid);
  await sessions.appendMessage(w, "u-test", sid, {
    payload: { message: userMessage("帮我查展览") },
  });
  await sessions.appendMessage(w, "u-test", sid, {
    payload: {
      message: assistantMessage("查询中", {
        stopReason: "toolUse",
        toolCalls: [{ id: "call-1" }, { id: "call-2" }],
      }),
    },
  });
  await sessions.appendMessage(w, "u-test", sid, {
    payload: { message: toolResultMessage("call-1", { text: "[]" }) },
  });
  await sessions.releaseLease(w, "u-test", sid);

  const { session, repo, faux } = await makePersistent(t, [], { sessions, sessionId: sid });
  const messages = await messageRecords(sessions, sid);
  assert.equal(messages.length, 4); // 打开时补上了 call-2 的中断 toolResult
  const tail = parseStoredMessagePayload(messages[3].payload, "t").message;
  assert.equal(tail.role, "toolResult");
  if (tail.role === "toolResult") {
    assert.equal(tail.toolCallId, "call-2");
    assert.equal(tail.isError, true);
  }
  const ev = await exhibition(repo, DAY1);
  faux.setResponses([afternoonPlan(ev)]);
  const turn = await session.prompt("继续安排");
  assert.equal(turn.kind, "itinerary");
  assert.equal(session.toolCalls.length, 0); // call-1/call-2 只是历史，不再执行
});

test("a run left running by a crashed writer is marked failed on open", async (t) => {
  const sessions = openMemoryRepo(t);
  const seeded = await makePersistent(t, [], { sessions });
  const sid = seeded.session.sessionId as string;
  const w = await mustAcquire(sessions, "u-test", sid);
  const dead = await sessions.createRun(w, "u-test", {
    sessionId: sid,
    input: { text: "上一轮崩了" },
    startImmediately: true,
  });
  await sessions.releaseLease(w, "u-test", sid);
  const { session: reopened } = await makePersistent(t, [], { sessions, sessionId: sid });
  const run = await sessions.getRun("u-test", dead.runId);
  assert.equal(run?.status, "failed");
  assert.match(run?.error ?? "", /中断/);
  await reopened.close();
});

// ---- 计划指针 ----

test("commit failure keeps the previous itinerary and does not burn corrections", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session, repo, faux } = await makePersistent(t, [], { sessions });
  const ev = await exhibition(repo, DAY1);
  faux.setResponses([afternoonPlan(ev)]);
  (sessions as { commitValidatedPlan: SessionRepository["commitValidatedPlan"] }).commitValidatedPlan =
    async () => {
      throw new Error("commitValidatedPlan down");
    };
  const turn = await session.prompt("安排");
  assert.equal(turn.kind, "error");
  if (turn.kind === "error") assert.match(turn.message, /写入会话库失败/);
  assert.equal(session.itinerary, undefined);
  assert.equal(faux.state.callCount, 1); // 数据库失败不触发纠正重试
  assert.equal(
    await sessions.getCurrentItinerary("u-test", session.sessionId as string),
    undefined,
  );
});

test("failed corrections keep the previously committed itinerary", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session, repo, faux } = await makePersistent(t, [], { sessions });
  const ev = await exhibition(repo, DAY1);
  faux.setResponses([afternoonPlan(ev)]);
  const first = await session.prompt("第一轮");
  assert.equal(first.kind, "itinerary");
  const committed = session.itinerary;
  const bad = envelope(
    {
      date: DAY1,
      summary: "s",
      stops: [{ event_id: "evt_nope", arrive_at: "13:00", leave_at: "14:00", reason: "r" }],
    },
    { date: DAY1 },
  );
  faux.appendResponses([
    fauxAssistantMessage(bad),
    fauxAssistantMessage(bad),
    fauxAssistantMessage(bad),
  ]);
  const second = await session.prompt("改一个不存在的活动");
  assert.equal(second.kind, "error");
  assert.deepEqual(session.itinerary, committed);
  const pointer = await sessions.getCurrentItinerary("u-test", session.sessionId as string);
  assert.deepEqual(pointer?.plan.itinerary, committed);
});

test("close releases the lease and further prompts are refused", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session } = await makePersistent(t, [], { sessions });
  const sid = session.sessionId as string;
  await session.close();
  const turn = await session.prompt("关了还说");
  assert.equal(turn.kind, "error");
  if (turn.kind === "error") assert.match(turn.message, /已关闭/);
  const w = await sessions.acquireLease("u-test", sid, "closer-check", 1_000);
  assert.ok(w, "close 后租约必须已释放");
  await sessions.releaseLease(w, "u-test", sid);
  const { session: next } = await makePersistent(
    t,
    [fauxAssistantMessage('{"type":"clarify","question":"q"}')],
    { sessions, sessionId: sid },
  );
  const reopened = await next.prompt("新一轮");
  assert.equal(reopened.kind, "clarification");
});

test("a bare checkpoint write does not advance last_activity_at", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session } = await makePersistent(t, [], { sessions });
  const sid = session.sessionId as string;
  const w = await mustAcquire(sessions, "u-test", sid);
  await sessions.appendMessage(w, "u-test", sid, {
    payload: { message: userMessage("hi") },
  });
  const before = (await sessions.getSession("u-test", sid))?.lastActivityAt;
  await sessions.appendCompaction(w, "u-test", sid, {
    payload: {
      summary: "纯检查点",
      source_through_message_seq: 1,
      first_kept_message_seq: 2,
    },
  });
  const after = (await sessions.getSession("u-test", sid))?.lastActivityAt;
  assert.equal(after, before);
  await sessions.releaseLease(w, "u-test", sid);
});

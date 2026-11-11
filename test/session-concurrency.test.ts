import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { SessionRepository } from "../src/session/repository.ts";
import { DAY1, afternoonPlan, envelope, exhibition, makePersistent } from "./e2e-fixture.ts";
import {
  TINY,
  compactionRecords,
  messageRecords,
  slowStream,
  until,
} from "./persistent-fixture.ts";
import { fakeClock, openMemoryRepo } from "./session-fixture.ts";

/**
 * 任务04 端到端验收（二）：租约竞争/心跳/丢失、工具循环内自动压缩、
 * 检查点写失败、取消。faux 模型 + 会话 SQLite（:memory:）。
 */

// ---- 租约 / 多实例 ----

test("two planners alternate on one session; a held lease rejects the rival", async (t) => {
  const sessions = openMemoryRepo(t);
  const aCore = createFauxCore({ tokensPerSecond: 80 });
  const a = await makePersistent(t, [], {
    sessions,
    userId: "u-share",
    streamFn: slowStream(aCore),
  });
  const ev = await exhibition(a.repo, DAY1);
  aCore.setResponses([afternoonPlan(ev), fauxAssistantMessage("x".repeat(3_000))]);
  const turnA = await a.session.prompt("A 的第一轮");
  assert.equal(turnA.kind, "itinerary");

  const b = await makePersistent(t, [], { sessions, userId: "u-share", repository: a.repo });
  assert.equal(b.session.sessionId, a.session.sessionId);
  let sawA = false;
  b.faux.setResponses([
    (context) => {
      sawA = JSON.stringify(context.messages).includes("A 的第一轮");
      return fauxAssistantMessage('{"type":"clarify","question":"B 看到 A 的上下文"}');
    },
  ]);
  const turnB = await b.session.prompt("B 接手");
  assert.equal(turnB.kind, "clarification");
  assert.ok(sawA, "B 的请求上下文应包含 A 已落库的消息");
  const sid = a.session.sessionId as string;
  assert.equal((await messageRecords(sessions, sid, "u-share")).length, 4);

  // 竞争：A 持租约跑慢请求时，B 的 prompt 礼貌报错而不是覆盖。
  const pending = a.session.prompt("A 慢轮");
  await until(() => aCore.state.callCount > 1, "A 慢请求开始");
  const denied = await b.session.prompt("B 抢");
  assert.equal(denied.kind, "error");
  if (denied.kind === "error") assert.match(denied.message, /另一写者|租约/);
  a.session.cancel();
  await pending;
});

test("lease heartbeat renews during a slow turn and releases when idle", async (t) => {
  const sessions = openMemoryRepo(t);
  let renews = 0;
  const original = sessions.renewLease.bind(sessions);
  (sessions as { renewLease: SessionRepository["renewLease"] }).renewLease = async (...args) => {
    renews += 1;
    return original(...args);
  };
  const slow = createFauxCore({ tokensPerSecond: 150 });
  const padded = envelope(
    { date: DAY1, summary: `s${" ".repeat(1_500)}`, stops: [] },
    { date: DAY1 },
  );
  slow.setResponses([fauxAssistantMessage(padded)]);
  const { session } = await makePersistent(t, [], {
    sessions,
    streamFn: slowStream(slow),
    leaseTtlMs: 300,
    leaseRenewMs: 60,
  });
  const turn = await session.prompt("一轮跨多次续租");
  assert.equal(turn.kind, "itinerary");
  assert.ok(renews >= 2, `租约应续期多次，实际 ${renews} 次`);
  const w = await sessions.acquireLease("u-test", session.sessionId as string, "other", 1_000);
  assert.ok(w, "空闲后租约必须已释放");
  await sessions.releaseLease(w, "u-test", session.sessionId as string);
});

test("lease loss mid-run aborts, reports terminal-state failure, next owner repairs", async (t) => {
  const clock = fakeClock();
  const sessions = openMemoryRepo(t, clock.now);
  const slow = createFauxCore({ tokensPerSecond: 25 });
  slow.setResponses([fauxAssistantMessage("z".repeat(3_000))]);
  const { session } = await makePersistent(t, [], {
    sessions,
    streamFn: slowStream(slow),
    leaseTtlMs: 300,
    leaseRenewMs: 50,
  });
  const sid = session.sessionId as string;
  const pending = session.prompt("跑到一半租约过期");
  await until(() => slow.state.callCount > 0, "model call started");
  clock.advance(60_000); // 租约过期；下一次续期失败 → abort + 禁写
  const turn = await pending;
  assert.equal(turn.kind, "error");
  if (turn.kind === "error") assert.match(turn.message, /租约|终态写入失败|abort/i);
  const stale = (await sessions.listRunsBySession("u-test", sid)).at(-1);
  assert.ok(stale && stale.status === "running", "终态写不进时 run 仍 running");
  await session.close();
  const repair = await makePersistent(
    t,
    [fauxAssistantMessage('{"type":"clarify","question":"q"}')],
    { sessions },
  );
  const repaired = (await sessions.listRunsBySession("u-test", sid)).at(-1);
  assert.equal(repaired?.status, "failed", "下一个写者打开时标记修复死 run");
  await repair.session.close();
});

// ---- 压缩边界 ----

test("auto-compaction fires inside a tool loop and persists a checkpoint", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session, repo, faux, summary } = await makePersistent(t, [], {
    sessions,
    config: TINY,
  });
  const ev = await exhibition(repo, DAY1);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("search_events", { date: DAY1 })], {
      stopReason: "toolUse",
    }),
    afternoonPlan(ev),
  ]);
  const turn = await session.prompt("有什么活动可以玩");
  assert.equal(turn.kind, "itinerary");
  assert.ok(summary && summary.calls() >= 1, "工具循环内应触发一次摘要请求");
  const checkpoints = await compactionRecords(sessions, session.sessionId as string);
  assert.equal(checkpoints.length, 1);
  const payload = JSON.parse(checkpoints[0].payload) as {
    source_through_message_seq: number;
    first_kept_message_seq: number;
  };
  // 检查点在最终 assistant 之前写入：through=3（u,a(toolUse),toolResult）。
  assert.equal(payload.source_through_message_seq, 3);
  assert.ok(payload.first_kept_message_seq >= 2);
  assert.equal((await messageRecords(sessions, session.sessionId as string)).length, 4);
});

test("failed checkpoint persistence ends the turn without switching context", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session, repo, faux } = await makePersistent(t, [], { sessions, config: TINY });
  const ev = await exhibition(repo, DAY1);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("search_events", { date: DAY1 })], {
      stopReason: "toolUse",
    }),
    afternoonPlan(ev),
  ]);
  (sessions as { appendCompaction: SessionRepository["appendCompaction"] }).appendCompaction =
    async () => {
      throw new Error("appendCompaction down");
    };
  const turn = await session.prompt("触发一次会失败的压缩");
  assert.equal(turn.kind, "error");
  if (turn.kind === "error") assert.match(turn.message, /down|abort|压缩/i);
  assert.equal((await compactionRecords(sessions, session.sessionId as string)).length, 0);
  // 上下文未切换：原始 toolResult 仍在有效上下文，没被摘要替换。
  const ctx = session.agent.state.messages;
  assert.ok(ctx.some((m) => m.role === "toolResult"));
});

// ---- 取消 ----

test("cancel during a normal model request ends busy and marks the run cancelled", async (t) => {
  const slow = createFauxCore({ tokensPerSecond: 25 });
  slow.setResponses([fauxAssistantMessage("x".repeat(3_000))]);
  const sessions = openMemoryRepo(t);
  const { session } = await makePersistent(t, [], { sessions, streamFn: slowStream(slow) });
  const pending = session.prompt("取消我");
  await until(() => slow.state.callCount > 0, "model call");
  session.cancel();
  const turn = await pending;
  assert.equal(turn.kind, "error");
  assert.equal(session.busy, false);
  const run = (await sessions.listRunsBySession("u-test", session.sessionId as string)).at(-1);
  assert.equal(run?.status, "cancelled");
  assert.equal(run?.cancelRequested, true);
});

test("cancel during a compaction summary aborts it; no checkpoint is written", async (t) => {
  const sessions = openMemoryRepo(t);
  const main = createFauxCore({});
  const slowSummary = createFauxCore({ tokensPerSecond: 25 });
  slowSummary.setResponses([fauxAssistantMessage("s".repeat(3_000))]);
  const { session, repo } = await makePersistent(t, [], {
    sessions,
    config: TINY,
    streamFn: slowStream(main, slowSummary),
  });
  const ev = await exhibition(repo, DAY1);
  main.setResponses([
    fauxAssistantMessage([fauxToolCall("search_events", { date: DAY1 })], {
      stopReason: "toolUse",
    }),
    afternoonPlan(ev),
  ]);
  const pending = session.prompt("触发压缩再取消");
  await until(() => slowSummary.state.callCount > 0, "summary started");
  session.cancel();
  const turn = await pending;
  assert.equal(turn.kind, "error");
  assert.equal((await compactionRecords(sessions, session.sessionId as string)).length, 0);
  const run = (await sessions.listRunsBySession("u-test", session.sessionId as string)).at(-1);
  assert.equal(run?.status, "cancelled");
});

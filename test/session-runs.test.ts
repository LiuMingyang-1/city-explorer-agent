import assert from "node:assert/strict";
import { test } from "node:test";
import { isSessionError } from "../src/session/types.ts";
import {
  fakeClock,
  makeUser,
  mustAcquire,
  openMemoryRepo,
  userMessage,
} from "./session-fixture.ts";

test("runs are created queued by default or running atomically, root points to self", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-run");
  const writer = await mustAcquire(repo, "u-run", main.sessionId);

  const queued = await repo.createRun(writer, "u-run", {
    sessionId: main.sessionId,
    input: { task: "第一轮" },
  });
  assert.equal(queued.status, "queued");
  assert.equal(queued.startedAt, null);
  assert.equal(queued.rootRunId, queued.runId); // 根 run 指自身
  assert.equal(queued.cancelRequested, false);
  assert.equal(queued.deliveredAt, null);
  assert.deepEqual(JSON.parse(queued.input), { task: "第一轮" });

  const running = await repo.createRun(writer, "u-run", {
    sessionId: main.sessionId,
    input: { task: "立即跑" },
    startImmediately: true,
  });
  assert.equal(running.status, "running");
  assert.ok(running.startedAt);

  // input 必须可 JSON 序列化。
  await assert.rejects(
    repo.createRun(writer, "u-run", { sessionId: main.sessionId, input: undefined }),
    (e) => isSessionError(e, "invalid_payload"),
  );
});

test("recursive hierarchy: children inherit root; listRunsByParent walks level by level", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-tree-run");
  const writer = await mustAcquire(repo, "u-tree-run", main.sessionId);
  const child = await repo.createChildSession(writer, "u-tree-run", {
    parentSessionId: main.sessionId,
  });
  const childWriter = await mustAcquire(repo, "u-tree-run", child.sessionId, "w-c");
  const grand = await repo.createChildSession(writer, "u-tree-run", {
    parentSessionId: main.sessionId,
  });
  const grandWriter = await mustAcquire(repo, "u-tree-run", grand.sessionId, "w-g");

  const root = await repo.createRun(writer, "u-tree-run", {
    sessionId: main.sessionId,
    input: { task: "root" },
  });
  const kid = await repo.createRun(childWriter, "u-tree-run", {
    sessionId: child.sessionId,
    input: { task: "child" },
    parentRunId: root.runId,
    replyToSessionId: main.sessionId,
  });
  assert.equal(kid.parentRunId, root.runId);
  assert.equal(kid.rootRunId, root.runId); // 继承父的根
  assert.equal(kid.replyToSessionId, main.sessionId);

  const grandkid = await repo.createRun(grandWriter, "u-tree-run", {
    sessionId: grand.sessionId,
    input: { task: "grandchild" },
    parentRunId: kid.runId,
  });
  assert.equal(grandkid.rootRunId, root.runId); // 多级递归同根

  // 逐层查询，不硬编码层数。
  assert.deepEqual(
    (await repo.listRunsByParent("u-tree-run", root.runId)).map((r) => r.runId),
    [kid.runId],
  );
  assert.deepEqual(
    (await repo.listRunsByParent("u-tree-run", kid.runId)).map((r) => r.runId),
    [grandkid.runId],
  );
  assert.equal((await repo.listRunsBySession("u-tree-run", main.sessionId)).length, 1);
  assert.equal((await repo.listRunsByUser("u-tree-run")).length, 3);
  await assert.rejects(repo.listRunsByParent("u-tree-run", "missing"), (e) =>
    isSessionError(e, "not_found"),
  );
});

test("cross-user parent/reply_to injections are refused", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-x");
  const { main: foreign } = await makeUser(repo, "u-y");
  const writerX = await mustAcquire(repo, "u-x", main.sessionId);
  const writerY = await mustAcquire(repo, "u-y", foreign.sessionId, "w-y");
  const foreignRun = await repo.createRun(writerY, "u-y", {
    sessionId: foreign.sessionId,
    input: {},
  });

  await assert.rejects(
    repo.createRun(writerX, "u-x", {
      sessionId: main.sessionId,
      input: {},
      parentRunId: foreignRun.runId,
    }),
    (e) => isSessionError(e, "cross_user"),
  );
  await assert.rejects(
    repo.createRun(writerX, "u-x", {
      sessionId: main.sessionId,
      input: {},
      replyToSessionId: foreign.sessionId,
    }),
    (e) => isSessionError(e, "cross_user"),
  );
  // 会话归属也校验：u-x 不能在 u-y 的会话建 run（租约也不在手上）。
  await assert.rejects(
    repo.createRun(writerX, "u-x", { sessionId: foreign.sessionId, input: {} }),
    (e) => isSessionError(e, "cross_user"),
  );
});

test("run transitions require the lease of the run's session and legal states", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-st");
  const writer = await mustAcquire(repo, "u-st", main.sessionId);
  const run = await repo.createRun(writer, "u-st", {
    sessionId: main.sessionId,
    input: {},
  });

  await repo.startRun(writer, "u-st", run.runId);
  assert.equal((await repo.getRun("u-st", run.runId))?.status, "running");
  await assert.rejects(repo.startRun(writer, "u-st", run.runId), (e) =>
    isSessionError(e, "invalid_state"),
  );

  // 别的会话租约管不到本 run（即便同一用户）。
  const child = await repo.createChildSession(writer, "u-st", { parentSessionId: main.sessionId });
  const childWriter = await mustAcquire(repo, "u-st", child.sessionId, "w-c");
  await assert.rejects(repo.finishRun(childWriter, "u-st", run.runId, { status: "completed" }), (e) =>
    isSessionError(e, "lease_lost"),
  );

  await repo.finishRun(writer, "u-st", run.runId, {
    status: "completed",
    result: { itinerary: "完成" },
  });
  const done = (await repo.getRun("u-st", run.runId))!;
  assert.equal(done.status, "completed");
  assert.deepEqual(JSON.parse(done.result!), { itinerary: "完成" });
  assert.ok(done.finishedAt);

  // 终态不可相互覆盖。
  await assert.rejects(
    repo.finishRun(writer, "u-st", run.runId, { status: "failed", error: "x" }),
    (e) => isSessionError(e, "invalid_state"),
  );
  await assert.rejects(repo.startRun(writer, "u-st", run.runId), (e) =>
    isSessionError(e, "invalid_state"),
  );
  assert.equal(await repo.requestCancelRun(writer, "u-st", run.runId), false);
});

test("cancel is a flag honored via cancelled terminal state; history is kept", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-cancel");
  const writer = await mustAcquire(repo, "u-cancel", main.sessionId);
  const run = await repo.createRun(writer, "u-cancel", {
    sessionId: main.sessionId,
    input: {},
    startImmediately: true,
  });

  // 未请求取消时不能以 cancelled 终态结束。
  await assert.rejects(
    repo.finishRun(writer, "u-cancel", run.runId, { status: "cancelled" }),
    (e) => isSessionError(e, "invalid_state"),
  );

  assert.equal(await repo.requestCancelRun(writer, "u-cancel", run.runId), true);
  assert.equal((await repo.getRun("u-cancel", run.runId))?.cancelRequested, true);
  // 请求置位后可按 cancelled 终态结束；行保留。
  await repo.finishRun(writer, "u-cancel", run.runId, { status: "cancelled" });
  const cancelled = (await repo.getRun("u-cancel", run.runId))!;
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.finishedAt);
  // cancelled 也不能被 finish 覆盖。
  await assert.rejects(
    repo.finishRun(writer, "u-cancel", run.runId, { status: "completed" }),
    (e) => isSessionError(e, "invalid_state"),
  );

  // failed 终态存 error。
  const failed = await repo.createRun(writer, "u-cancel", {
    sessionId: main.sessionId,
    input: {},
    startImmediately: true,
  });
  await repo.finishRun(writer, "u-cancel", failed.runId, {
    status: "failed",
    error: "模型超时",
  });
  assert.equal((await repo.getRun("u-cancel", failed.runId))?.error, "模型超时");
  await assert.rejects(
    repo.finishRun(writer, "u-cancel", failed.runId, { status: "failed", error: "再来" }),
    (e) => isSessionError(e, "invalid_state"),
  );
});

test("run progression advances last_activity_at like real interaction", async (t) => {
  const clock = fakeClock();
  const repo = openMemoryRepo(t, clock.now);
  const { main } = await makeUser(repo, "u-runact");
  const writer = await mustAcquire(repo, "u-runact", main.sessionId, "w-1", 60_000);
  await repo.appendMessage(writer, "u-runact", main.sessionId, {
    payload: { message: userMessage("hi") },
  });
  const activity = (await repo.getSession("u-runact", main.sessionId))!.lastActivityAt;

  clock.advance(5_000);
  const run = await repo.createRun(writer, "u-runact", {
    sessionId: main.sessionId,
    input: {},
  });
  assert.ok((await repo.getSession("u-runact", main.sessionId))!.lastActivityAt > activity);

  clock.advance(5_000);
  await repo.finishRun(writer, "u-runact", run.runId, { status: "completed" });
  const latest = (await repo.getSession("u-runact", main.sessionId))!.lastActivityAt;
  assert.ok(latest > activity);
});

test("cross-user run reads are refused or hidden", async (t) => {
  const repo = openMemoryRepo(t);
  const { main } = await makeUser(repo, "u-rr");
  const writer = await mustAcquire(repo, "u-rr", main.sessionId);
  const run = await repo.createRun(writer, "u-rr", { sessionId: main.sessionId, input: {} });
  await makeUser(repo, "u-ss");

  assert.equal(await repo.getRun("u-ss", run.runId), undefined);
  await assert.rejects(repo.listRunsBySession("u-ss", main.sessionId), (e) =>
    isSessionError(e, "not_found"),
  );
  await assert.rejects(repo.listRunsByParent("u-ss", run.runId), (e) =>
    isSessionError(e, "not_found"),
  );
  await assert.rejects(repo.startRun(writer, "u-ss", run.runId), (e) =>
    isSessionError(e, "cross_user"),
  );
  assert.deepEqual(await repo.listRunsByUser("u-ss"), []);
});

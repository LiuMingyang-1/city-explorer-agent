import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { PlannerSession, PlannerTurn } from "../src/agent/session.ts";
import type { EventRepository } from "../src/data/repository.ts";
import type { SessionRepository } from "../src/session/repository.ts";
import {
  DAY1,
  afternoonPlan,
  envelope,
  exhibition,
  makePersistent,
  makeRepo,
  stopsAt,
} from "./e2e-fixture.ts";
import { asText, until } from "./persistent-fixture.ts";
import { fakeClock, makeUser, mustAcquire, openMemoryRepo } from "./session-fixture.ts";

/**
 * 运行时状态一致性加固回归：
 * 1) 在途操作的异步链（Agent 事件回调 / 验证读取）内调用 close() 必须明确拒绝——
 *    等待自己收尾会死锁，跳过等待会提前释放租约留下 running run；
 * 2) plan 提交是线性化点：commit 事务完成后迟到的 cancel/close 不得把
 *    成功轮次抹成 cancelled（指针已推进、结果可重放）；
 * 3) child 会话的候选规划从自身最新成功 run 的产出恢复（不设正式指针），
 *    失败/取消/追问轮不覆盖旧候选，main 的指针恢复逻辑不变。
 */

const settled = <T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> =>
  promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );

async function lastRun(sessions: SessionRepository, userId: string, sessionId: string) {
  return (await sessions.listRunsBySession(userId, sessionId)).at(-1);
}

function storedTurn(run: { result: string | null } | undefined): PlannerTurn | undefined {
  return (JSON.parse(run?.result ?? "null") as { turn?: PlannerTurn } | null)?.turn;
}

/** 建用户 + main + child，返回 child 会话 ID（main 用于指针不变断言）。 */
async function makeChild(t: import("node:test").TestContext, sessions: SessionRepository) {
  const userId = "u-child";
  const { main } = await makeUser(sessions, userId);
  const writer = await mustAcquire(sessions, userId, main.sessionId);
  const child = await sessions.createChildSession(writer, userId, {
    parentSessionId: main.sessionId,
  });
  await sessions.releaseLease(writer, userId, main.sessionId);
  return { userId, main, child };
}

// ---- 1) 操作异步链内 close() 明确拒绝 ----

test("close() inside a validation read rejects; the turn completes and no lease is released early", async (t) => {
  const sessions = openMemoryRepo(t);
  const events = await makeRepo(t);
  let session!: PlannerSession;
  let innerClose: PromiseSettledResult<void> | undefined;
  const wrapped: EventRepository = {
    search: (input) => events.search(input),
    getByIds: async (ids) => {
      // 在 performTurn 的验证读取（op 异步链）内尝试关闭整个会话。
      innerClose ??= await settled(session.close());
      return events.getByIds(ids);
    },
    close: () => events.close(),
  };
  const created = await makePersistent(t, [], { sessions, repository: wrapped });
  session = created.session;
  const ev = await exhibition(events, DAY1);
  created.faux.setResponses([afternoonPlan(ev)]);

  const turn = await session.prompt("安排展览");
  assert.equal(turn.kind, "itinerary", "内部 close 被拒后本轮仍应正常完成");
  assert.equal(innerClose?.status, "rejected", "op 链内 close() 必须明确拒绝");
  if (innerClose?.status === "rejected") {
    assert.match(String(innerClose.reason), /异步链|cancel|外部/);
  }
  const run = await lastRun(sessions, "u-test", session.sessionId as string);
  assert.equal(run?.status, "completed", "租约不得被提前释放，run 必须正常收尾");
  assert.ok(await sessions.getCurrentItinerary("u-test", session.sessionId as string));
  assert.equal(session.busy, false);

  // 外部调用方依旧能正常关闭（共享收尾 Promise），关后拒绝新工作。
  await session.close();
  const refused = await session.prompt("关了还说");
  assert.equal(refused.kind, "error");
  if (refused.kind === "error") assert.match(refused.message, /已关闭/);
});

test("close() awaited inside an agent event callback rejects instead of deadlocking", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session, repo, faux } = await makePersistent(t, [], { sessions });
  const ev = await exhibition(repo, DAY1);
  faux.setResponses([afternoonPlan(ev)]);

  let innerClose: PromiseSettledResult<void> | undefined;
  let fired = false;
  const unsubscribe = session.agent.subscribe(async (event) => {
    // message_end 回调被 Agent 的 run Promise await：这里 await close()
    // 在旧实现里会等待 waitForIdle → 回调等 Agent、Agent 等回调，死锁。
    if (event.type !== "message_end" || fired) return;
    fired = true;
    innerClose = await settled(session.close());
  });

  const turn = await session.prompt("安排展览");
  unsubscribe();
  assert.equal(turn.kind, "itinerary", "回调内 close 被拒后本轮仍应正常完成");
  assert.equal(innerClose?.status, "rejected", "事件回调内 close() 必须明确拒绝");
  const run = await lastRun(sessions, "u-test", session.sessionId as string);
  assert.equal(run?.status, "completed");
  await session.close();
});

// ---- 2) 提交线性化点：迟到 cancel/close 不得抹掉已提交轮次 ----

/** 包一层 commitValidatedPlan：真实事务先完成，Promise 延迟放行以制造迟到取消。 */
function gateCommit(sessions: SessionRepository) {
  const original = sessions.commitValidatedPlan.bind(sessions);
  let armed = false;
  let entered = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessions.commitValidatedPlan = async (writer, userId, sessionId, recordId, plan) => {
    await original(writer, userId, sessionId, recordId, plan); // 真实 SQLite 事务已提交
    if (armed) {
      entered = true;
      await gate; // 但 Promise 延迟 resolve：cancel/close 落在这条缝里
    }
  };
  return {
    arm() {
      armed = true;
    },
    entered: () => entered,
    release: () => release(),
  };
}

test("a committed plan survives a late cancel: run completes, pointer moved, replay returns the itinerary", async (t) => {
  const sessions = openMemoryRepo(t);
  const gated = gateCommit(sessions);
  const { session, repo, faux } = await makePersistent(t, [], { sessions });
  const ev = await exhibition(repo, DAY1);
  faux.setResponses([afternoonPlan(ev)]);
  const first = await session.prompt("安排展览");
  assert.equal(first.kind, "itinerary");
  const sid = session.sessionId as string;
  const before = await sessions.getCurrentItinerary("u-test", sid);
  assert.ok(before);

  // 第二轮合法候选：约束只报 date，继承上一轮的 13:00–18:00。
  faux.setResponses([
    fauxAssistantMessage(
      envelope(
        { date: DAY1, summary: "换时段", stops: [stopsAt(ev.id)("15:30", "17:00")] },
        { date: DAY1 },
      ),
    ),
  ]);
  gated.arm();
  const pending = session.prompt("改到傍晚", { requestId: "req-late-cancel" });
  await until(gated.entered, "plan commit transaction done, promise held");
  session.cancel(); // 事务已提交后的迟到取消
  gated.release();
  const turn = await pending;

  // 已提交的结果是成功：turn 如实返回 itinerary，run 记 completed，
  // 指针前进，同 requestId 重放拿回成功结果而不是"已取消"。
  assert.equal(turn.kind, "itinerary");
  const run = await lastRun(sessions, "u-test", sid);
  assert.equal(run?.status, "completed", "已提交轮次不得被迟到取消抹成 cancelled");
  assert.equal(storedTurn(run)?.kind, "itinerary");
  const after = await sessions.getCurrentItinerary("u-test", sid);
  assert.notEqual(after?.record.recordId, before.record.recordId, "提交已生效，指针应前进");
  assert.equal(session.itinerary?.stops[0]?.arrive_at, "15:30");

  const replay = await session.prompt("改到傍晚", { requestId: "req-late-cancel" });
  assert.equal(replay.kind, "itinerary", "重放应返回已提交的成功结果");
});

test("a committed plan survives a late close: the turn completes before shutdown finishes", async (t) => {
  const sessions = openMemoryRepo(t);
  const gated = gateCommit(sessions);
  const { session, repo, faux } = await makePersistent(t, [], { sessions });
  const ev = await exhibition(repo, DAY1);
  faux.setResponses([afternoonPlan(ev)]);
  const first = await session.prompt("安排展览");
  assert.equal(first.kind, "itinerary");
  const sid = session.sessionId as string;

  faux.setResponses([
    fauxAssistantMessage(
      envelope(
        { date: DAY1, summary: "换时段", stops: [stopsAt(ev.id)("15:30", "17:00")] },
        { date: DAY1 },
      ),
    ),
  ]);
  gated.arm();
  const pending = session.prompt("改到傍晚");
  await until(gated.entered, "plan commit transaction done, promise held");
  const closing = session.close(); // 事务已提交后的迟到关闭
  gated.release();
  const turn = await pending;
  await closing;

  assert.equal(turn.kind, "itinerary");
  const run = await lastRun(sessions, "u-test", sid);
  assert.equal(run?.status, "completed");
  assert.ok(await sessions.getCurrentItinerary("u-test", sid));
});

// ---- 3) child 候选从自身最新成功 run 恢复 ----

test("child sessions restore their latest candidate across rounds and instances; main untouched", async (t) => {
  const clock = fakeClock();
  const sessions = openMemoryRepo(t, clock.now);
  const { userId, main, child } = await makeChild(t, sessions);

  // 实例 A：首轮候选带 13:00–18:00 窗口。
  const a = await makePersistent(t, [], { sessions, userId, sessionId: child.sessionId });
  const ev = await exhibition(a.repo, DAY1);
  a.faux.setResponses([afternoonPlan(ev)]);
  const first = await a.session.prompt("子任务：下午看展");
  assert.equal(first.kind, "itinerary");
  assert.equal(a.session.constraints?.availableStart, "13:00");
  await a.session.close();

  // 实例 B（关闭重开）：候选约束与行程从自身成功 run 恢复，注入上下文
  // 但标注为"候选"而不是 main 的正式已确认状态。
  clock.advance(1_000);
  const b = await makePersistent(t, [], { sessions, userId, sessionId: child.sessionId });
  assert.equal(b.session.constraints?.availableStart, "13:00", "child 重开应恢复候选约束");
  assert.equal(b.session.constraints?.availableEnd, "18:00");
  assert.ok(b.session.itinerary, "候选行程同样恢复");
  const systemText = asText(b.session.agent.state.messages);
  assert.match(systemText, /候选/, "child 上下文应注入候选状态");
  assert.doesNotMatch(systemText, /已确认的规划状态|权威来源/, "child 不得标为正式");

  // B 第二轮：补丁显式改 availableStart=14:00 → 最新候选变为 14:00–18:00。
  clock.advance(1_000);
  b.faux.setResponses([
    fauxAssistantMessage(
      envelope(
        { date: DAY1, summary: "s", stops: [stopsAt(ev.id)("14:30", "15:30")] },
        { date: DAY1, availableStart: "14:00" },
      ),
    ),
  ]);
  const second = await b.session.prompt("改从下午两点开始");
  assert.equal(second.kind, "itinerary");
  if (second.kind === "itinerary") assert.equal(second.constraints.availableStart, "14:00");

  // B 第三轮：省略时段 + 13:30 候选 → 按最新候选 14:00–18:00 拒绝；
  // 若误恢复首轮 13:00 或全部丢弃，该候选会被放行。纠正后通过。
  clock.advance(1_000);
  b.faux.setResponses([
    fauxAssistantMessage(
      envelope(
        { date: DAY1, summary: "bad", stops: [stopsAt(ev.id)("13:30", "14:30")] },
        { date: DAY1 },
      ),
    ),
    fauxAssistantMessage(
      envelope(
        { date: DAY1, summary: "fix", stops: [stopsAt(ev.id)("15:00", "16:00")] },
        { date: DAY1 },
      ),
    ),
  ]);
  const third = await b.session.prompt("再往前提一点");
  assert.equal(third.kind, "itinerary", "纠正后的合法候选应通过");
  if (third.kind === "itinerary") {
    assert.equal(third.itinerary.stops[0]?.arrive_at, "15:00");
    assert.equal(third.constraints.availableStart, "14:00", "漏报字段继承最新候选");
  }
  assert.equal(b.session.itinerary?.stops[0]?.arrive_at, "15:00", "被拒候选不得污染候选行程");

  // child 始终不维护正式指针，main 未被触碰。
  const childRow = await sessions.getSession(userId, child.sessionId);
  assert.equal(childRow?.currentItineraryRecordId, null);
  assert.equal(await sessions.getCurrentItinerary(userId, child.sessionId), undefined);
  const mainRow = await sessions.getSession(userId, main.sessionId);
  assert.equal(mainRow?.currentItineraryRecordId, null);
  await b.session.close();
});

test("a failed child run never overwrites the previous candidate", async (t) => {
  const clock = fakeClock();
  const sessions = openMemoryRepo(t, clock.now);
  const { userId, child } = await makeChild(t, sessions);

  // 实例 A：成功候选 13:00–18:00。
  const a = await makePersistent(t, [], { sessions, userId, sessionId: child.sessionId });
  const ev = await exhibition(a.repo, DAY1);
  a.faux.setResponses([afternoonPlan(ev)]);
  assert.equal((await a.session.prompt("下午看展")).kind, "itinerary");
  await a.session.close();

  // 实例 B：模型无可用响应 → error turn → failed run。
  clock.advance(1_000);
  const b = await makePersistent(t, [], { sessions, userId, sessionId: child.sessionId });
  b.faux.setResponses([]);
  clock.advance(1_000);
  const failed = await b.session.prompt("这一轮会失败");
  assert.equal(failed.kind, "error");
  assert.equal((await lastRun(sessions, userId, child.sessionId))?.status, "failed");
  await b.session.close();

  // 实例 C：恢复仍来自 A 的成功候选，省略时段照常继承。
  clock.advance(1_000);
  const c = await makePersistent(t, [], { sessions, userId, sessionId: child.sessionId });
  assert.equal(c.session.constraints?.availableStart, "13:00", "失败 run 不得覆盖候选");
  assert.equal(c.session.constraints?.availableEnd, "18:00");
  c.faux.setResponses([
    fauxAssistantMessage(
      envelope(
        { date: DAY1, summary: "s", stops: [stopsAt(ev.id)("15:00", "16:00")] },
        { date: DAY1 },
      ),
    ),
  ]);
  clock.advance(1_000);
  const turn = await c.session.prompt("换个时段");
  assert.equal(turn.kind, "itinerary");
  await c.session.close();
});

test("main sessions keep the confirmed-pointer section and pointer restore", async (t) => {
  const sessions = openMemoryRepo(t);
  const { session, repo, faux } = await makePersistent(t, [], { sessions });
  const ev = await exhibition(repo, DAY1);
  faux.setResponses([afternoonPlan(ev)]);
  assert.equal((await session.prompt("安排展览")).kind, "itinerary");
  await session.close();

  const reopened = await makePersistent(t, [], { sessions });
  assert.equal(reopened.session.constraints?.availableStart, "13:00");
  const systemText = asText(reopened.session.agent.state.messages);
  assert.match(systemText, /已确认的规划状态/, "main 上下文注入正式已确认状态");
  assert.doesNotMatch(systemText, /候选行程/);
});

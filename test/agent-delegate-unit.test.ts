import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  DELEGATE_TASK_TOOL,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  SubagentSemaphore,
  createDelegateTaskTool,
} from "../src/agent/delegate.ts";
import type {
  ChildPlannerHandle,
  DelegateTaskDetails,
  DelegateTaskToolOptions,
  DelegateTurnContext,
  SpawnChildPlanner,
} from "../src/agent/delegate.ts";
import type { PlannerTurn } from "../src/agent/session.ts";
import type { EventRepository } from "../src/data/repository.ts";
import type { Event } from "../src/data/types.ts";
import type { SessionRepository } from "../src/session/repository.ts";
import type { LeaseWriter, Run } from "../src/session/types.ts";
import { makeUser, mustAcquire, openMemoryRepo } from "./session-fixture.ts";

/**
 * delegate_task 编排核心的离线单元测试：
 * 真实 SessionRepository(:memory:) + 桩 EventRepository + 假 ChildPlannerHandle。
 */

const USER = "u-delegate";
const DAY = "2026-11-15";

function fakeEvent(id: string, overrides: Partial<Event> = {}): Event {
  return {
    id,
    title: `活动${id}`,
    description: "desc",
    category: "展览",
    venueName: `场馆${id}`,
    address: "addr",
    latitude: 31.1,
    longitude: 121.4,
    startAt: `${DAY}T13:00`,
    endAt: `${DAY}T18:00`,
    suggestedDurationMinutes: 90,
    budgetMin: 5000,
    budgetMax: 12000,
    currency: "CNY",
    budgetNote: "含特展票",
    guideUrl: null,
    thumbnailUrl: null,
    imageUrls: [],
    ...overrides,
  };
}

/** 桩活动库：只关心 getByIds 的入参与返回。 */
function stubEvents(events: Event[]): { repository: EventRepository; calls: string[][] } {
  const byId = new Map(events.map((e) => [e.id, e]));
  const calls: string[][] = [];
  return {
    calls,
    repository: {
      search: async () => events,
      getByIds: async (ids) => {
        calls.push([...ids]);
        return new Map(ids.flatMap((id) => (byId.has(id) ? [[id, byId.get(id)!]] : [])));
      },
      close: () => {},
    },
  };
}

interface FakeChild extends ChildPlannerHandle {
  prompts: Array<{ text: string; options?: { location?: { lat: number; lng: number } } }>;
  cancels: number;
  closes: number;
  /** 手动放行挂起的 prompt（测试可控时序）。 */
  release?: (turn: PlannerTurn) => void;
}

/** prompt 行为由 impl 决定；返回挂起 Promise 时可经 release 或 cancel 放行。 */
function fakeChild(
  impl: (child: FakeChild) => Promise<PlannerTurn> | PlannerTurn,
): FakeChild {
  const child: FakeChild = {
    prompts: [],
    cancels: 0,
    closes: 0,
    prompt(text, options) {
      this.prompts.push({ text, options });
      return Promise.resolve(impl(this));
    },
    cancel() {
      this.cancels += 1;
      this.release?.({ kind: "error", message: "child aborted" });
    },
    async close() {
      this.closes += 1;
    },
  };
  return child;
}

/** prompt 挂起直到 release()/cancel() 的子 Agent。 */
function hangingChild(): FakeChild {
  return fakeChild(
    (self) =>
      new Promise<PlannerTurn>((resolve) => {
        self.release = resolve;
      }),
  );
}

function itineraryTurn(...eventIds: string[]): PlannerTurn {
  return {
    kind: "itinerary",
    constraints: { date: DAY, availableStart: "13:00", availableEnd: "18:00" },
    itinerary: {
      date: DAY,
      summary: "候选行程",
      stops: eventIds.map((event_id) => ({
        event_id,
        arrive_at: "13:00",
        leave_at: "14:30",
        reason: "r",
      })),
    },
  };
}

/** 建用户 + 父对话 + 父租约 + 父 run；spawnChild 的 run 树校验需要真实父 run。 */
async function parentFixture(t: TestContext) {
  const sessions = openMemoryRepo(t);
  const { main } = await makeUser(sessions, USER);
  const writer = await mustAcquire(sessions, USER, main.sessionId);
  const parentRun = await sessions.createRun(writer, USER, {
    sessionId: main.sessionId,
    input: { text: "parent" },
    startImmediately: true,
  });
  return { sessions, main, writer, parentRun };
}

interface CtxProbe {
  ctx: DelegateTurnContext;
  leaseFailures: unknown[];
}

function makeCtx(
  base: { writer: LeaseWriter; sessionId: string; runId: string },
  overrides: Partial<DelegateTurnContext> = {},
): CtxProbe {
  const leaseFailures: unknown[] = [];
  const ctx: DelegateTurnContext = {
    userId: USER,
    sessionId: base.sessionId,
    runId: base.runId,
    writer: base.writer,
    depth: 0,
    failParentLease: (error) => {
      leaseFailures.push(error);
    },
    ...overrides,
  };
  return { ctx, leaseFailures };
}

function payloadOf(result: AgentToolResult<DelegateTaskDetails>): DelegateTaskDetails {
  assert.equal(result.content.length, 1);
  const content = result.content[0];
  assert.equal(content.type, "text");
  return JSON.parse((content as { text: string }).text) as DelegateTaskDetails;
}

/** 在 spawnChild 内建真实子 run（需要子会话租约），返回 runId 供断言。 */
function spawnWithChildRun(
  sessions: SessionRepository,
  child: FakeChild,
  spawned: Array<Parameters<SpawnChildPlanner>[0]>,
  runs: Run[],
): SpawnChildPlanner {
  return async (input) => {
    spawned.push(input);
    const writer = await sessions.acquireLease(input.userId, input.sessionId, "child-1", 60_000);
    assert.ok(writer);
    const run = await sessions.createRun(writer, input.userId, {
      sessionId: input.sessionId,
      input: { text: "child task" },
      parentRunId: input.parentRunId,
      replyToSessionId: input.replyToSessionId,
      startImmediately: true,
    });
    runs.push(run);
    return child;
  };
}

// 缺省 sessions 仓库的占位：不触库的前置校验用例走它，触库用例都覆盖 sessions。
const openMemoryRepoStub = { close() {} } as unknown as SessionRepository;

function makeTool(overrides: Partial<DelegateTaskToolOptions> = {}) {
  return createDelegateTaskTool({
    getContext: () => undefined,
    repository: stubEvents([]).repository,
    sessions: openMemoryRepoStub,
    spawnChild: async () => {
      throw new Error("unused");
    },
    ...overrides,
  });
}

// ---- SubagentSemaphore ----

test("SubagentSemaphore grants up to the limit then queues FIFO", async () => {
  const sem = new SubagentSemaphore(1);
  const order: string[] = [];
  const r1 = await sem.acquire();
  assert.equal(sem.running, 1);
  let resolved2 = false;
  const p2 = sem.acquire().then((release) => {
    resolved2 = true;
    order.push("p2");
    return release;
  });
  const p3 = sem.acquire().then((release) => {
    order.push("p3");
    return release;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved2, false);
  assert.equal(sem.waiting, 2);

  r1();
  const r2 = await p2;
  assert.equal(sem.waiting, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["p2"]);

  r2();
  const r3 = await p3;
  assert.deepEqual(order, ["p2", "p3"]);
  r3();
  assert.equal(sem.running, 0);
});

test("SubagentSemaphore release is idempotent", async () => {
  const sem = new SubagentSemaphore(1);
  const release = await sem.acquire();
  release();
  release();
  assert.equal(sem.running, 0);
  // 重复释放不放大容量：第二个 acquire 拿的是唯一槽位，第三个仍须排队。
  const r2 = await sem.acquire();
  let r3resolved = false;
  const p3 = sem.acquire().then((r) => {
    r3resolved = true;
    return r;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r3resolved, false);
  r2();
  (await p3)();
});

test("SubagentSemaphore abort during queue leaves the slot untouched", async () => {
  const sem = new SubagentSemaphore(1);
  const r1 = await sem.acquire();
  const controller = new AbortController();
  const waiting = sem.acquire(controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sem.waiting, 1);

  controller.abort(new Error("用户取消"));
  await assert.rejects(waiting, /用户取消/);
  assert.equal(sem.waiting, 0);
  assert.equal(sem.running, 1); // 不占槽

  // 已 abort 的 signal 直接拒绝、不进队。
  await assert.rejects(sem.acquire(controller.signal), /用户取消/);
  assert.equal(sem.waiting, 0);

  r1();
  const r2 = await sem.acquire();
  assert.equal(sem.running, 1);
  r2();
});

test("SubagentSemaphore rejects non-positive capacity", () => {
  assert.throws(() => new SubagentSemaphore(0), /正整数/);
  assert.throws(() => new SubagentSemaphore(1.5), /正整数/);
});

// ---- createDelegateTaskTool：前置校验 ----

test("delegate_task fails without a dispatch context", async (t) => {
  const tool = makeTool();
  assert.equal(tool.name, DELEGATE_TASK_TOOL);
  const result = await tool.execute("c1", { task: "看看展" });
  assert.equal(result.isError, true);
  const payload = payloadOf(result);
  assert.equal(payload.status, "failed");
  assert.equal(payload.sessionId, null);
  assert.match(payload.error ?? "", /可派发的持久运行上下文/);
});

test("delegate_task rejects empty task and depth at the cap", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const { ctx } = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { depth: DEFAULT_MAX_SUBAGENT_DEPTH },
  );
  const tool = makeTool({ getContext: () => ctx, sessions });

  const empty = await tool.execute("c2", { task: "   " });
  assert.equal(empty.isError, true);
  assert.match(payloadOf(empty).error ?? "", /task 不能为空/);

  const deep = await tool.execute("c3", { task: "x" });
  assert.equal(deep.isError, true);
  assert.match(payloadOf(deep).error ?? "", /递归深度上限/);
});

// ---- createDelegateTaskTool：成功路径 ----

test("delegate_task dispatches a child and returns itinerary + events meta", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const events = [fakeEvent("evt_a"), fakeEvent("evt_b")];
  const { repository, calls } = stubEvents(events);
  const child = fakeChild(() => itineraryTurn("evt_a", "evt_b", "evt_a", "evt_missing"));
  const spawned: Array<Parameters<SpawnChildPlanner>[0]> = [];
  const runs: Run[] = [];
  const { ctx, leaseFailures } = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { location: { lat: 31.2, lng: 121.5 } },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository,
    sessions,
    spawnChild: spawnWithChildRun(sessions, child, spawned, runs),
  });

  const result = await tool.execute("c4", { task: "  周六下午西岸看展  ", title: " 西岸看展 " });
  assert.equal(result.isError, false);
  const payload = payloadOf(result);

  // 子会话真实落库：kind=child、parent=父对话、title trim 后写入。
  assert.equal(payload.status, "completed");
  assert.equal(payload.kind, "itinerary");
  const childSession = await sessions.getSession(USER, payload.sessionId!);
  assert.ok(childSession);
  assert.equal(childSession.kind, "child");
  assert.equal(childSession.parentSessionId, main.sessionId);
  assert.equal(childSession.title, "西岸看展");

  // spawnChild 收到完整派发参数（depth+1、父 run/会话指针）。
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0], {
    userId: USER,
    sessionId: childSession.sessionId,
    parentRunId: parentRun.runId,
    replyToSessionId: main.sessionId,
    depth: 1,
  });

  // 子 run 树字段齐备 → 工具回传的 runId 即该 run。
  assert.equal(runs.length, 1);
  assert.equal(payload.runId, runs[0].runId);
  assert.equal(runs[0].parentRunId, parentRun.runId);
  assert.equal(runs[0].replyToSessionId, main.sessionId);
  assert.equal(runs[0].rootRunId, parentRun.runId);

  // task trim 后透传；父 location 原样透传。
  assert.equal(child.prompts.length, 1);
  assert.equal(child.prompts[0].text, "周六下午西岸看展");
  assert.deepEqual(child.prompts[0].options, { location: { lat: 31.2, lng: 121.5 } });
  assert.equal(child.cancels, 0);
  assert.equal(child.closes, 1);
  assert.equal(leaseFailures.length, 0);

  // event_id 去重保序后批量取详情；缺失 id 被过滤，只留精简元信息。
  assert.deepEqual(calls, [["evt_a", "evt_b", "evt_missing"]]);
  assert.equal(payload.itinerary?.stops.length, 4);
  assert.deepEqual(payload.constraints, { date: DAY, availableStart: "13:00", availableEnd: "18:00" });
  assert.equal(payload.events?.length, 2);
  assert.deepEqual(
    payload.events?.map((e) => e.id),
    ["evt_a", "evt_b"],
  );
  assert.deepEqual(Object.keys(payload.events![0]).sort(), [
    "budgetMax",
    "budgetMin",
    "budgetNote",
    "category",
    "currency",
    "endAt",
    "id",
    "startAt",
    "suggestedDurationMinutes",
    "title",
    "venueName",
  ]);
  assert.equal(payload.events![0].suggestedDurationMinutes, 90);
});

test("delegate_task forwards a clarification turn without error", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const child = fakeChild(() => ({ kind: "clarification", question: "上午还是下午？" }));
  const { ctx } = makeCtx({ writer, sessionId: main.sessionId, runId: parentRun.runId });
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]).repository,
    sessions,
    spawnChild: async () => child,
  });
  const result = await tool.execute("c5", { task: "帮我看展" });
  assert.equal(result.isError, false);
  const payload = payloadOf(result);
  assert.equal(payload.status, "completed");
  assert.equal(payload.kind, "clarification");
  assert.equal(payload.question, "上午还是下午？");
  assert.equal(child.prompts.length, 1);
  assert.deepEqual(child.prompts[0].options, {}); // 无 location 时传空 options
  assert.equal(child.closes, 1);
});

test("delegate_task maps a child error turn to failed + isError", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const child = fakeChild(() => ({ kind: "error", message: "模型没有给出回复" }));
  const { ctx } = makeCtx({ writer, sessionId: main.sessionId, runId: parentRun.runId });
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]).repository,
    sessions,
    spawnChild: async () => child,
  });
  const result = await tool.execute("c6", { task: "x" });
  assert.equal(result.isError, true);
  const payload = payloadOf(result);
  assert.equal(payload.status, "failed");
  assert.match(payload.error ?? "", /模型没有给出回复/);
  assert.ok(payload.sessionId);
  assert.equal(child.closes, 1);
});

// ---- 取消 / 超时 / 并发 ----

test("delegate_task local timeout cancels and closes the child", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const child = hangingChild();
  const { ctx } = makeCtx({ writer, sessionId: main.sessionId, runId: parentRun.runId });
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]).repository,
    sessions,
    spawnChild: async () => child,
    timeoutMs: 60,
  });
  const result = await tool.execute("c7", { task: "x" });
  assert.equal(result.isError, true);
  const payload = payloadOf(result);
  assert.equal(payload.status, "cancelled");
  assert.match(payload.error ?? "", /^子任务执行超时（\d+s）$/);
  assert.ok(payload.sessionId);
  assert.equal(child.cancels, 1);
  assert.equal(child.closes, 1);
});

test("delegate_task parent abort cancels and closes the child", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const child = hangingChild();
  const { ctx } = makeCtx({ writer, sessionId: main.sessionId, runId: parentRun.runId });
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]).repository,
    sessions,
    spawnChild: async () => child,
    timeoutMs: 60_000,
  });
  const parent = new AbortController();
  const pending = tool.execute("c8", { task: "x" }, parent.signal);
  setTimeout(() => parent.abort(), 20);
  const result = await pending;
  assert.equal(result.isError, true);
  const payload = payloadOf(result);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.error, "父请求已取消");
  assert.equal(child.cancels, 1);
  assert.equal(child.closes, 1);
});

test("delegate_task queues on the semaphore and a queued timeout leaves no slot", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const semaphore = new SubagentSemaphore(1);
  const slow = hangingChild();
  const fast = fakeChild(() => itineraryTurn("evt_a"));
  const { repository } = stubEvents([fakeEvent("evt_a")]);
  const { ctx } = makeCtx({ writer, sessionId: main.sessionId, runId: parentRun.runId });
  const spawn: SpawnChildPlanner = async () => slow;

  const first = createDelegateTaskTool({
    getContext: () => ctx,
    repository,
    sessions,
    spawnChild: spawn,
    semaphore,
    timeoutMs: 5_000,
  }).execute("c9", { task: "first" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(semaphore.running, 1);

  // 第二个调用在队列中等到自己的超时 → cancelled、不占槽、不建子会话。
  const second = await createDelegateTaskTool({
    getContext: () => ctx,
    repository,
    sessions,
    spawnChild: async () => fast,
    semaphore,
    timeoutMs: 40,
  }).execute("c10", { task: "second" });
  assert.equal(second.isError, true);
  const queued = payloadOf(second);
  assert.equal(queued.status, "cancelled");
  assert.match(queued.error ?? "", /子任务执行超时/);
  assert.equal(queued.sessionId, null);
  assert.equal(semaphore.waiting, 0);

  slow.release?.(itineraryTurn("evt_a"));
  const done = await first;
  assert.equal(done.isError, false);
  assert.equal(payloadOf(done).status, "completed");
  assert.equal(semaphore.running, 0);
  assert.equal(slow.closes, 1);
});

// ---- 父租约分流 ----

test("delegate_task lease_lost/archived triggers failParentLease and rethrows", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const stale: LeaseWriter = { owner: "other-owner", epoch: 99 };
  const { ctx, leaseFailures } = makeCtx({ writer: stale, sessionId: main.sessionId, runId: parentRun.runId });
  let spawnCalls = 0;
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]).repository,
    sessions,
    spawnChild: async () => {
      spawnCalls += 1;
      return fakeChild(() => itineraryTurn());
    },
  });
  await assert.rejects(tool.execute("c11", { task: "x" }), /租约/);
  assert.equal(leaseFailures.length, 1);
  assert.equal(spawnCalls, 0);
  assert.ok(writer); // 父真实租约未被触碰
});

test("delegate_task non-lease session errors do not touch failParentLease", async (t) => {
  const sessions = openMemoryRepo(t);
  await makeUser(sessions, USER);
  // 指向不存在的父会话 → not_found（非 lease_lost/archived）。
  const { ctx, leaseFailures } = makeCtx({
    writer: { owner: "w", epoch: 1 },
    sessionId: "no-such-session",
    runId: "no-such-run",
  });
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]).repository,
    sessions,
    spawnChild: async () => fakeChild(() => itineraryTurn()),
  });
  const result = await tool.execute("c12", { task: "x" });
  assert.equal(result.isError, true);
  const payload = payloadOf(result);
  assert.equal(payload.status, "failed");
  assert.equal(payload.sessionId, null);
  assert.equal(leaseFailures.length, 0);
});

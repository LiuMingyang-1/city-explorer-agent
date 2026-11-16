import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { SubagentSemaphore, createDelegateTaskTool } from "../src/agent/delegate.ts";
import type {
  ChildPlannerHandle,
  DelegateTaskDetails,
  DelegateTurnContext,
  SpawnChildPlanner,
} from "../src/agent/delegate.ts";
import type {
  PlannerProcessEvent,
  SubagentDoneEvent,
  SubagentSpawnedEvent,
  ToolCallEvent,
} from "../src/agent/progress.ts";
import { stageProgress, toolCallEvent } from "../src/agent/progress.ts";
import type { PlannerTurn } from "../src/agent/session.ts";
import type { EventRepository } from "../src/data/repository.ts";
import type { Event } from "../src/data/types.ts";
import type { SessionRepository } from "../src/session/repository.ts";
import type { LeaseWriter, Run } from "../src/session/types.ts";
import { makeUser, mustAcquire, openMemoryRepo } from "./session-fixture.ts";

/**
 * I39-2：delegate_task 生命周期过程事件发射的针对性测试（docs/issue-39/coordination.md §7）。
 * 真实 SessionRepository(:memory:) + 桩 EventRepository + 可控 FakeChild：
 * spawned/done 恒 1:1、字段与回传父模型的 DelegateTaskDetails 同源、
 * child_run_status 如实抄录持久化终态（running 不伪装）、子过程事件盖章
 * 透传而 stage 不透传、sink 抛错不影响业务、createChildSession 之前的
 * 失败不产生任何事件。
 */

const USER = "u-delegate-progress";
const DAY = "2026-11-15";

function fakeEvent(id: string): Event {
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
    budgetNote: null,
    guideUrl: null,
    thumbnailUrl: null,
    imageUrls: [],
  };
}

/** 桩活动库：只关心 getByIds；getByIds 可替换为抛错实现测异常分支。 */
function stubEvents(events: Event[], getByIds?: EventRepository["getByIds"]): EventRepository {
  const byId = new Map(events.map((e) => [e.id, e]));
  return {
    search: async () => events,
    getByIds:
      getByIds ??
      (async (ids) => new Map(ids.flatMap((id) => (byId.has(id) ? [[id, byId.get(id)!]] : [])))),
    close: () => {},
  };
}

type ChildPromptOptions = Parameters<ChildPlannerHandle["prompt"]>[1];

interface FakeChild extends ChildPlannerHandle {
  prompts: Array<{ text: string; options?: ChildPromptOptions }>;
  cancels: number;
  closes: number;
  /** 手动放行挂起的 prompt（测试可控时序）。 */
  release?: (turn: PlannerTurn) => void;
}

/** prompt 行为由 impl 决定（拿到 options 可发子过程事件）；closeImpl 可注入收尾失败/延迟。 */
function fakeChild(
  impl: (self: FakeChild, options?: ChildPromptOptions) => Promise<PlannerTurn> | PlannerTurn,
  closeImpl?: () => Promise<void> | void,
): FakeChild {
  const child: FakeChild = {
    prompts: [],
    cancels: 0,
    closes: 0,
    prompt(text, options) {
      this.prompts.push({ text, options });
      return Promise.resolve(impl(this, options));
    },
    cancel() {
      this.cancels += 1;
      this.release?.({ kind: "error", message: "child aborted" });
    },
    async close() {
      this.closes += 1;
      await closeImpl?.();
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

function makeCtx(
  base: { writer: LeaseWriter; sessionId: string; runId: string },
  overrides: Partial<DelegateTurnContext> = {},
): DelegateTurnContext {
  return {
    userId: USER,
    sessionId: base.sessionId,
    runId: base.runId,
    writer: base.writer,
    depth: 0,
    failParentLease: () => {},
    ...overrides,
  };
}

function payloadOf(result: AgentToolResult<DelegateTaskDetails>): DelegateTaskDetails {
  assert.equal(result.content.length, 1);
  const content = result.content[0];
  assert.equal(content.type, "text");
  return JSON.parse((content as { text: string }).text) as DelegateTaskDetails;
}

interface ChildRunRef {
  writer: LeaseWriter;
  run: Run;
}

/** 在 spawnChild 内建真实子 run（需要子会话租约），ref 供 impl 持久化终态与断言。 */
function spawnWithChildRun(
  sessions: SessionRepository,
  child: FakeChild,
  childRuns: ChildRunRef[],
): SpawnChildPlanner {
  return async (input) => {
    const writer = await sessions.acquireLease(input.userId, input.sessionId, "child-1", 60_000);
    assert.ok(writer);
    const run = await sessions.createRun(writer, input.userId, {
      sessionId: input.sessionId,
      input: { text: "child task" },
      parentRunId: input.parentRunId,
      replyToSessionId: input.replyToSessionId,
      startImmediately: true,
    });
    childRuns.push({ writer, run });
    return child;
  };
}

function asSpawned(event: PlannerProcessEvent): SubagentSpawnedEvent {
  assert.equal(event.type, "subagent_spawned");
  return event as SubagentSpawnedEvent;
}

function asDone(event: PlannerProcessEvent): SubagentDoneEvent {
  assert.equal(event.type, "subagent_done");
  return event as SubagentDoneEvent;
}

/** 全部事件 message 恒非空单行（旧前端逐帧覆盖的兼容硬约定）。 */
function assertMessagesWellFormed(events: PlannerProcessEvent[]): void {
  for (const event of events) {
    assert.ok(event.message.length > 0, `${event.type} message 必须非空`);
    assert.ok(!event.message.includes("\n"), `${event.type} message 必须单行`);
  }
}

// ---- spawned/done 配对与同源 ----

test("delegate progress: success emits spawned then done, fields same-source as details", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const childRuns: ChildRunRef[] = [];
  const events: PlannerProcessEvent[] = [];
  const child = fakeChild(async () => {
    // 真实编排：子 run 在 prompt 返回前持久化终态。
    const { writer: w, run } = childRuns[0];
    await sessions.finishRun(w, USER, run.runId, { status: "completed", result: { ok: true } });
    return itineraryTurn("evt_a");
  });
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    {
      onProgress: (e) => events.push(e),
      planIdForToolCall: (id) => (id === "tc-b" ? "B" : undefined),
    },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([fakeEvent("evt_a")]),
    sessions,
    spawnChild: spawnWithChildRun(sessions, child, childRuns),
  });

  const result = await tool.execute("tc-b", {
    task: "  周六下午大雁塔看展  ",
    title: " 看展方案 ",
  });
  assert.equal(result.isError, false);
  const payload = payloadOf(result);
  assert.equal(payload.status, "completed");
  assert.equal(payload.kind, "itinerary");

  assert.equal(events.length, 2);
  const spawned = asSpawned(events[0]);
  const done = asDone(events[1]);

  // spawned：分身入场（createChildSession 落库 id），plan_id 与父 stage 同源。
  assert.equal(spawned.subagent_id, payload.sessionId);
  assert.equal(spawned.plan_id, "B");
  assert.equal(spawned.parent_run_id, parentRun.runId);
  assert.equal(spawned.title, "看展方案");
  assert.equal(spawned.task_summary, "周六下午大雁塔看展");
  assert.ok(spawned.message.includes("看展方案"));

  // done：与 DelegateTaskDetails 同源；child_run_* 为 DB 持久化终态。
  assert.equal(done.subagent_id, spawned.subagent_id);
  assert.equal(done.title, spawned.title); // 契约必填 title，与 spawned 同源
  assert.equal(done.plan_id, "B");
  assert.equal(done.status, payload.status);
  assert.equal(done.kind, "itinerary");
  assert.equal(done.stops_count, payload.itinerary?.stops.length);
  assert.equal(done.summary, payload.itinerary?.summary);
  assert.equal(done.child_run_id, payload.runId);
  assert.equal(done.child_run_id, childRuns[0].run.runId);
  assert.equal(done.child_run_status, "completed");
  assertMessagesWellFormed(events);
});

test("delegate progress: clarification done, plan_id null when unmapped, title falls back to task", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const childRuns: ChildRunRef[] = [];
  const events: PlannerProcessEvent[] = [];
  const child = fakeChild(() => ({ kind: "clarification", question: "上午还是下午？" }));
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    {
      onProgress: (e) => events.push(e),
      planIdForToolCall: () => undefined,
    },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]),
    sessions,
    spawnChild: spawnWithChildRun(sessions, child, childRuns),
  });

  const result = await tool.execute("tc-unmapped", { task: "帮我安排看展" });
  const payload = payloadOf(result);
  assert.equal(payload.status, "completed");
  assert.equal(payload.kind, "clarification");

  assert.equal(events.length, 2);
  const spawned = asSpawned(events[0]);
  const done = asDone(events[1]);
  assert.equal(spawned.plan_id, null);
  assert.equal(spawned.title, "帮我安排看展"); // 无 title 时取 task 裁剪
  assert.equal(done.title, spawned.title);
  assert.equal(done.plan_id, null);
  assert.equal(done.status, "completed");
  assert.equal(done.kind, "clarification");
  assert.equal(done.stops_count, null);
  assert.equal(done.summary, payload.question);
  // 竞态如实呈现：父视角 completed，但子 run 尚未持久化终态 → running，不伪装。
  assert.equal(done.child_run_id, childRuns[0].run.runId);
  assert.equal(done.child_run_status, "running");
  assertMessagesWellFormed(events);
});

// ---- 失败路径的发射保证 ----

test("delegate progress: spawnChild failure still pairs spawned with exactly one failed done", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const events: PlannerProcessEvent[] = [];
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { onProgress: (e) => events.push(e) },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]),
    sessions,
    spawnChild: async () => {
      throw new Error("打开子会话失败");
    },
  });

  const result = await tool.execute("tc", { task: "x" });
  const payload = payloadOf(result);
  assert.equal(payload.status, "failed");
  assert.equal(payload.runId, null); // spawnChild 未建 run → 查无为 null

  assert.equal(events.length, 2);
  const spawned = asSpawned(events[0]);
  const done = asDone(events[1]);
  assert.equal(spawned.subagent_id, payload.sessionId); // 入场事件已在失败前发出
  assert.equal(done.subagent_id, spawned.subagent_id);
  assert.equal(done.title, spawned.title);
  assert.equal(done.status, "failed");
  assert.equal(done.kind, undefined);
  assert.equal(done.stops_count, null);
  assert.equal(done.summary, payload.error);
  assert.match(done.summary, /^启动子任务失败：打开子会话失败$/);
  assert.equal(done.child_run_id, null);
  assert.equal(done.child_run_status, null);
  assertMessagesWellFormed(events);
});

test("delegate progress: spawnChild that already created a run reports its real persisted state", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const childRuns: ChildRunRef[] = [];
  const events: PlannerProcessEvent[] = [];
  // 实现方先建子 run 再抛错：DB 留下 running 半成品——done/details 如实回填。
  const spawn: SpawnChildPlanner = async (input) => {
    const w = await sessions.acquireLease(input.userId, input.sessionId, "child-1", 60_000);
    assert.ok(w);
    const run = await sessions.createRun(w, input.userId, {
      sessionId: input.sessionId,
      input: { text: "child task" },
      parentRunId: input.parentRunId,
      replyToSessionId: input.replyToSessionId,
      startImmediately: true,
    });
    childRuns.push({ writer: w, run });
    throw new Error("子 Planner 初始化失败");
  };
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { onProgress: (e) => events.push(e) },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]),
    sessions,
    spawnChild: spawn,
  });

  const result = await tool.execute("tc", { task: "x" });
  const payload = payloadOf(result);
  assert.equal(payload.status, "failed");
  assert.equal(payload.runId, childRuns[0].run.runId); // 半成品 run 如实回传父模型

  assert.equal(events.length, 2);
  const spawned = asSpawned(events[0]);
  const done = asDone(events[1]);
  assert.equal(done.subagent_id, spawned.subagent_id);
  assert.equal(done.title, spawned.title);
  assert.equal(done.status, "failed");
  assert.match(done.summary, /^启动子任务失败：子 Planner 初始化失败$/);
  assert.equal(done.child_run_id, childRuns[0].run.runId);
  assert.equal(done.child_run_status, "running"); // DB 权威，不伪造终态
  const persisted = await sessions.getRun(USER, childRuns[0].run.runId);
  assert.equal(persisted?.status, "running");
  assertMessagesWellFormed(events);
});

test("delegate progress: abort during spawn then spawnChild throws keeps failed semantics", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const events: PlannerProcessEvent[] = [];
  // combined 在启动期已 abort、spawnChild 随后抛错：status 维持既有父模型
  // 语义 failed（旧实现同样不在该分支区分 abort），done 与 details 同源。
  const spawn: SpawnChildPlanner = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    throw new Error("启动依赖不可用");
  };
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { onProgress: (e) => events.push(e) },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]),
    sessions,
    spawnChild: spawn,
    timeoutMs: 60_000,
  });

  const parent = new AbortController();
  const pending = tool.execute("tc", { task: "x" }, parent.signal);
  setTimeout(() => parent.abort(), 10);
  const result = await pending;
  const payload = payloadOf(result);
  assert.equal(payload.status, "failed");
  assert.match(payload.error ?? "", /^启动子任务失败：启动依赖不可用$/);

  assert.equal(events.length, 2);
  const done = asDone(events[1]);
  assert.equal(done.status, "failed");
  assert.equal(done.summary, payload.error);
  assert.equal(done.child_run_id, null);
  assert.equal(done.child_run_status, null);
  assertMessagesWellFormed(events);
});

test("delegate progress: prompt error turn -> failed done, divergent persisted run status stays honest", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const childRuns: ChildRunRef[] = [];
  const events: PlannerProcessEvent[] = [];
  const child = fakeChild(async () => {
    // 子 run 已持久化 cancelled，但父视角按 error turn 回 failed——两态分歧如实呈现。
    const { writer: w, run } = childRuns[0];
    await sessions.requestCancelRun(w, USER, run.runId);
    await sessions.finishRun(w, USER, run.runId, { status: "cancelled", error: "子侧取消" });
    return { kind: "error", message: "子规划模型失败" };
  });
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { onProgress: (e) => events.push(e) },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]),
    sessions,
    spawnChild: spawnWithChildRun(sessions, child, childRuns),
  });

  const result = await tool.execute("tc", { task: "x" });
  const payload = payloadOf(result);
  assert.equal(payload.status, "failed");

  assert.equal(events.length, 2);
  const done = asDone(events[1]);
  assert.equal(done.status, "failed");
  assert.equal(done.summary, "子规划模型失败");
  assert.equal(done.child_run_id, childRuns[0].run.runId);
  assert.equal(done.child_run_status, "cancelled");
  assertMessagesWellFormed(events);
});

// ---- 取消 / 超时 ----

test("delegate progress: child timeout pairs cancelled done and never disguises running run", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const childRuns: ChildRunRef[] = [];
  const events: PlannerProcessEvent[] = [];
  const child = hangingChild();
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { onProgress: (e) => events.push(e) },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]),
    sessions,
    spawnChild: spawnWithChildRun(sessions, child, childRuns),
    timeoutMs: 60,
  });

  const result = await tool.execute("tc", { task: "x" });
  const payload = payloadOf(result);
  assert.equal(payload.status, "cancelled");
  assert.equal(child.cancels, 1);
  assert.equal(child.closes, 1);

  assert.equal(events.length, 2);
  const done = asDone(events[1]);
  assert.equal(done.status, "cancelled");
  assert.equal(done.summary, payload.error); // cancelError() 同源
  assert.match(done.summary, /^子任务执行超时（\d+s）$/);
  // DB 权威：子 run 未被任何人持久化终态 → running 如实抄录。
  assert.equal(done.child_run_id, childRuns[0].run.runId);
  assert.equal(done.child_run_status, "running");
  const persisted = await sessions.getRun(USER, childRuns[0].run.runId);
  assert.equal(persisted?.status, "running");
  assertMessagesWellFormed(events);
});

test("delegate progress: parent abort pairs cancelled done", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const childRuns: ChildRunRef[] = [];
  const events: PlannerProcessEvent[] = [];
  const child = hangingChild();
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { onProgress: (e) => events.push(e) },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]),
    sessions,
    spawnChild: spawnWithChildRun(sessions, child, childRuns),
    timeoutMs: 60_000,
  });

  const parent = new AbortController();
  const pending = tool.execute("tc", { task: "x" }, parent.signal);
  setTimeout(() => parent.abort(), 20);
  const result = await pending;
  const payload = payloadOf(result);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.error, "父请求已取消");

  assert.equal(events.length, 2);
  const done = asDone(events[1]);
  assert.equal(done.status, "cancelled");
  assert.equal(done.summary, "父请求已取消");
  assert.equal(done.child_run_id, childRuns[0].run.runId);
  assert.equal(done.child_run_status, "running");
  assertMessagesWellFormed(events);
});

// ---- 入场前失败不造事件 ----

test("delegate progress: pre-dispatch failures emit no spawned/done", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const events: PlannerProcessEvent[] = [];
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { onProgress: (e) => events.push(e) },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]),
    sessions,
    spawnChild: async () => fakeChild(() => itineraryTurn()),
  });

  const empty = await tool.execute("tc", { task: "   " });
  assert.equal(payloadOf(empty).status, "failed");
  assert.equal(events.length, 0);

  const deepCtx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { onProgress: (e) => events.push(e), depth: 1 },
  );
  const deepTool = createDelegateTaskTool({
    getContext: () => deepCtx,
    repository: stubEvents([]),
    sessions,
    spawnChild: async () => fakeChild(() => itineraryTurn()),
  });
  const deep = await deepTool.execute("tc", { task: "x" });
  assert.equal(payloadOf(deep).status, "failed");
  assert.equal(events.length, 0);

  const noCtxTool = createDelegateTaskTool({
    getContext: () => undefined,
    repository: stubEvents([]),
    sessions,
    spawnChild: async () => fakeChild(() => itineraryTurn()),
  });
  const noCtx = await noCtxTool.execute("tc", { task: "x" });
  assert.equal(payloadOf(noCtx).status, "failed");
  assert.equal(events.length, 0);
});

test("delegate progress: createChildSession failure emits nothing", async (t) => {
  const sessions = openMemoryRepo(t);
  await makeUser(sessions, USER);
  const events: PlannerProcessEvent[] = [];
  const ctx = makeCtx(
    { writer: { owner: "w", epoch: 1 }, sessionId: "no-such-session", runId: "no-such-run" },
    { onProgress: (e) => events.push(e) },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]),
    sessions,
    spawnChild: async () => fakeChild(() => itineraryTurn()),
  });
  const result = await tool.execute("tc", { task: "x" });
  assert.equal(payloadOf(result).status, "failed");
  assert.equal(events.length, 0);
});

test("delegate progress: semaphore-queued timeout contributes no events", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const semaphore = new SubagentSemaphore(1);
  const events: PlannerProcessEvent[] = [];
  const slow = hangingChild();
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { onProgress: (e) => events.push(e) },
  );
  const first = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([fakeEvent("evt_a")]),
    sessions,
    spawnChild: async () => slow,
    semaphore,
    timeoutMs: 5_000,
  }).execute("tc-1", { task: "first" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(semaphore.running, 1);
  assert.equal(events.length, 1); // 第一单已入场

  const second = await createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]),
    sessions,
    spawnChild: async () => fakeChild(() => itineraryTurn()),
    semaphore,
    timeoutMs: 40,
  }).execute("tc-2", { task: "second" });
  const queued = payloadOf(second);
  assert.equal(queued.status, "cancelled");
  assert.equal(queued.sessionId, null);
  assert.equal(events.length, 1); // 排队取消未入场，不造 spawned/done

  slow.release?.(itineraryTurn("evt_a"));
  const done1 = await first;
  assert.equal(done1.isError, false);
  assert.equal(events.length, 2); // 第一单终了补齐 done
  assert.equal(asDone(events[1]).subagent_id, asSpawned(events[0]).subagent_id);
});

// ---- 透传盖章与 stage 边界 ----

test("delegate progress: child events forwarded stamped; stage events never leak", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const childRuns: ChildRunRef[] = [];
  const events: PlannerProcessEvent[] = [];
  const child = fakeChild((_self, options) => {
    options?.onProgress?.(stageProgress("searching_events", []));
    options?.onProgress?.(stageProgress("exploring_plans", ["A"]));
    options?.onProgress?.(
      toolCallEvent({
        toolCallId: "ct1",
        name: "search_events",
        args: { date: DAY, category: "展览" },
        result: { details: { count: 3 } },
        isError: false,
      }),
    );
    return itineraryTurn("evt_a");
  });
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { onProgress: (e) => events.push(e) },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([fakeEvent("evt_a")]),
    sessions,
    spawnChild: spawnWithChildRun(sessions, child, childRuns),
  });

  const result = await tool.execute("tc", { task: "x" });
  assert.equal(result.isError, false);

  // spawned → 盖章 tool_call → done；两条子 stage 不透传（不污染父轮 stage 序列）。
  assert.equal(events.length, 3);
  const spawned = asSpawned(events[0]);
  assert.equal(events[1].type, "tool_call");
  const forwarded = events[1] as ToolCallEvent;
  assert.equal(forwarded.subagent_id, spawned.subagent_id);
  assert.equal(forwarded.tool_call_id, "ct1");
  assert.equal(forwarded.result_count, 3);
  asDone(events[2]);
  assert.ok(events.every((e) => e.type !== "stage" && e.type !== undefined));
  assertMessagesWellFormed(events);
});

// ---- 观察者边界与异常分支 ----

test("delegate progress: throwing sink does not affect dispatch", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const child = fakeChild(() => itineraryTurn("evt_a"));
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    {
      onProgress: () => {
        throw new Error("sink boom");
      },
    },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([fakeEvent("evt_a")]),
    sessions,
    spawnChild: async () => child,
  });
  const result = await tool.execute("tc", { task: "x" });
  assert.equal(result.isError, false);
  assert.equal(payloadOf(result).status, "completed");
  assert.equal(child.closes, 1);
});

// ---- close 纳入终局决策（I39-R P2）----

test("delegate progress: close rejection downgrades completed to failed, done same-source", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const childRuns: ChildRunRef[] = [];
  const events: PlannerProcessEvent[] = [];
  const child = fakeChild(
    async () => {
      const { writer: w, run } = childRuns[0];
      await sessions.finishRun(w, USER, run.runId, { status: "completed" });
      return itineraryTurn("evt_a");
    },
    () => {
      throw new Error("心跳释放失败");
    },
  );
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { onProgress: (e) => events.push(e) },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([fakeEvent("evt_a")]),
    sessions,
    spawnChild: spawnWithChildRun(sessions, child, childRuns),
  });

  // close 纳入结果决策：返回结构化 failed（而非 completed details 之后又 tool error）。
  const result = await tool.execute("tc", { task: "x" });
  const payload = payloadOf(result);
  assert.equal(result.isError, true);
  assert.equal(payload.status, "failed");
  assert.match(payload.error ?? "", /^子任务收尾失败：心跳释放失败$/);
  assert.equal(child.closes, 1);

  // 唯一 done 与最终 details 同源；child_run_status 仍为 DB 权威 completed。
  assert.equal(events.length, 2);
  const done = asDone(events[1]);
  assert.equal(done.status, payload.status);
  assert.equal(done.summary, payload.error);
  assert.equal(done.child_run_id, payload.runId);
  assert.equal(done.child_run_id, childRuns[0].run.runId);
  assert.equal(done.child_run_status, "completed");
  assertMessagesWellFormed(events);
});

test("delegate progress: close rejection keeps prior failed/cancelled reasons", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const events: PlannerProcessEvent[] = [];

  // 已有失败路径：error turn + close 拒绝 → 保留首要原因不被 close 错误覆盖。
  const failing = fakeChild(
    () => ({ kind: "error", message: "子规划模型失败" }),
    () => {
      throw new Error("close boom");
    },
  );
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { onProgress: (e) => events.push(e) },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([]),
    sessions,
    spawnChild: async () => failing,
  });
  const result = await tool.execute("tc", { task: "x" });
  const payload = payloadOf(result);
  assert.equal(payload.status, "failed");
  assert.equal(payload.error, "子规划模型失败");
  assert.equal(failing.closes, 1);
  const done = asDone(events[1]);
  assert.equal(done.status, "failed");
  assert.equal(done.summary, "子规划模型失败");

  // 取消路径：超时 + close 拒绝 → 仍 cancelled、保留超时文案。
  events.length = 0;
  const hanging = fakeChild(
    (self) =>
      new Promise<PlannerTurn>((resolve) => {
        self.release = resolve;
      }),
    () => {
      throw new Error("close boom");
    },
  );
  const ctx2 = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { onProgress: (e) => events.push(e) },
  );
  const timeoutTool = createDelegateTaskTool({
    getContext: () => ctx2,
    repository: stubEvents([]),
    sessions,
    spawnChild: async () => hanging,
    timeoutMs: 60,
  });
  const cancelResult = await timeoutTool.execute("tc2", { task: "x" });
  const cancelPayload = payloadOf(cancelResult);
  assert.equal(cancelPayload.status, "cancelled");
  assert.match(cancelPayload.error ?? "", /子任务执行超时/);
  const cancelDone = asDone(events[1]);
  assert.equal(cancelDone.status, "cancelled");
  assert.equal(cancelDone.summary, cancelPayload.error);
});

test("delegate progress: abort during close does not downgrade produced result", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const events: PlannerProcessEvent[] = [];
  const parent = new AbortController();
  // cleanup 期间 abort 属"迟到"（与 runtime 终态线性化一致）：
  // 已产出 completed 不被抹成 cancelled。
  const child = fakeChild(
    () => itineraryTurn("evt_a"),
    async () => {
      parent.abort();
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  );
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { onProgress: (e) => events.push(e) },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([fakeEvent("evt_a")]),
    sessions,
    spawnChild: async () => child,
  });
  const result = await tool.execute("tc", { task: "x" }, parent.signal);
  const payload = payloadOf(result);
  assert.equal(payload.status, "completed");
  const done = asDone(events[1]);
  assert.equal(done.status, "completed");
  assert.equal(done.kind, "itinerary");
});

test("delegate progress: stale child callback after prompt settles is not forwarded", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const events: PlannerProcessEvent[] = [];
  let staleSink: ((e: PlannerProcessEvent) => void) | undefined;
  const child = fakeChild((_self, options) => {
    staleSink = options?.onProgress;
    options?.onProgress?.(
      toolCallEvent({
        toolCallId: "ct1",
        name: "search_events",
        args: { date: DAY },
        result: { details: { count: 1 } },
        isError: false,
      }),
    );
    return itineraryTurn("evt_a");
  });
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { onProgress: (e) => events.push(e) },
  );
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository: stubEvents([fakeEvent("evt_a")]),
    sessions,
    spawnChild: async () => child,
  });
  const result = await tool.execute("tc", { task: "x" });
  assert.equal(result.isError, false);
  assert.deepEqual(
    events.map((e) => e.type),
    ["subagent_spawned", "tool_call", "subagent_done"],
  );

  // prompt 落定后回调视为过期：悬挂子事件（close 内或更晚）不透传父 sink。
  staleSink?.(
    toolCallEvent({
      toolCallId: "ct2",
      name: "search_events",
      args: { date: DAY },
      isError: false,
    }),
  );
  staleSink?.({ type: "tool_call" } as PlannerProcessEvent);
  assert.equal(events.length, 3);
  assertMessagesWellFormed(events);
});

test("delegate progress: unexpected exception after spawn becomes one failed result+done", async (t) => {
  const { sessions, main, writer, parentRun } = await parentFixture(t);
  const childRuns: ChildRunRef[] = [];
  const events: PlannerProcessEvent[] = [];
  const child = fakeChild(async () => {
    // 子 run 已持久化 completed；父侧组装元信息时异常——分歧如实呈现。
    const { writer: w, run } = childRuns[0];
    await sessions.finishRun(w, USER, run.runId, { status: "completed" });
    return itineraryTurn("evt_a");
  });
  const ctx = makeCtx(
    { writer, sessionId: main.sessionId, runId: parentRun.runId },
    { onProgress: (e) => events.push(e) },
  );
  const repository = stubEvents([], async () => {
    throw new Error("db boom");
  });
  const tool = createDelegateTaskTool({
    getContext: () => ctx,
    repository,
    sessions,
    spawnChild: spawnWithChildRun(sessions, child, childRuns),
  });

  // spawn 之后不再上抛：收编为结构化 failed 结果，done 与 details 恒同源。
  const result = await tool.execute("tc", { task: "x" });
  const payload = payloadOf(result);
  assert.equal(result.isError, true);
  assert.equal(payload.status, "failed");
  assert.match(payload.error ?? "", /^子任务派发异常：db boom$/);
  assert.equal(child.closes, 1);

  assert.equal(events.length, 2);
  const spawned = asSpawned(events[0]);
  const done = asDone(events[1]);
  assert.equal(done.subagent_id, spawned.subagent_id);
  assert.equal(done.status, payload.status);
  assert.equal(done.summary, payload.error);
  assert.equal(done.child_run_id, payload.runId);
  assert.equal(done.child_run_id, childRuns[0].run.runId);
  assert.equal(done.child_run_status, "completed");
  assertMessagesWellFormed(events);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
  getCurrentSystemMessage,
  getCurrentTools,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import type { AssistantMessage, SystemMessage } from "@earendil-works/pi-ai";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type {
  FauxResponseFactory,
  FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import {
  DELEGATE_TASK_TOOL,
  getDefaultSubagentSemaphore,
} from "../src/agent/delegate.ts";
import type { SubagentSemaphore } from "../src/agent/delegate.ts";
import { createPersistentPlanner } from "../src/agent/session.ts";
import { SEARCH_EVENTS_TOOL } from "../src/agent/tools.ts";
import { createChatService } from "../src/web/service.ts";
import type { ExplorerConfig } from "../src/config.ts";
import type { EventRepository } from "../src/data/repository.ts";
import type { Event } from "../src/data/types.ts";
import type { SessionRepository } from "../src/session/repository.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";
import type { MessagePayload } from "../src/session/types.ts";
import {
  BASE,
  CONFIG,
  DAY1,
  envelope,
  isDistillRequest,
  isSummaryRequest,
  makeRepo,
} from "./e2e-fixture.ts";
import { messageRecords, sleep, until } from "./persistent-fixture.ts";

/**
 * createPersistentPlanner 子 Agent 编排全链路集成测试
 * （docs/architecture/orchestration.md §7 第 8–11 条不变量）。
 *
 * 全部离线：真实 :memory: SessionRepository + 真实种子 EventRepository +
 * 真实 createPersistentPlanner（delegate_task 接线）+ faux streamFn。
 * 请求路由按 TranscriptContext 精确分流、无竞态：
 * - 蒸馏旁路：首条 user 消息以 <memory> 开头；
 * - 摘要旁路：user 消息含 <conversation>；
 * - 父 Agent：system 的 toolsAdded 含 delegate_task 声明；
 * - child Agent（depth=1 无该工具）：按首条 user 消息（= task 文本）区分。
 */

const USER = "u-delegate-e2e";
const LOCATION = { lat: 34.27, lng: 108.95 };
const MEMORY_DOC = "## 用户\n- 常居西安\n\n## 偏好\n- 爱看展\n\n## 足迹\n";
const DISTILL_DOC =
  "## 用户\n- 常居西安\n\n## 偏好\n- 爱看展\n\n## 足迹\n- 2026-11-14 看展市集一日行\n";

const TASK_A = "2026-11-14 下午文艺看展方向：13:00 起两场美术馆展览";
const TASK_B = "2026-11-14 下午市集与书店签售方向：白天市集、晚间签售";

// ---- 请求捕获与分流 ----

interface RouteCapture {
  route: "parent" | "child" | "distill" | "summary";
  childKey?: string;
  /** 该请求实际可用的全部工具名（transcript 重放后）。 */
  toolNames: string[];
  /** 重放后的系统提示全文（content + sections）。 */
  systemText: string;
  location?: string | null;
  memory?: string | null;
  firstUser: string;
}

function firstUserText(context: { messages: Array<{ role?: string; content?: unknown }> }): string {
  const first = context.messages.find((m) => m.role === "user");
  const content = first?.content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

function capture(
  route: RouteCapture["route"],
  context: { messages: AgentMessage[] },
  childKey?: string,
): RouteCapture {
  const system = getCurrentSystemMessage(context.messages) as SystemMessage | undefined;
  return {
    route,
    childKey,
    toolNames: getCurrentTools(context.messages).map((tool) => tool.name),
    systemText: system ? getSystemMessageText(system) : "",
    location: system?.sections?.["location_context"],
    memory: system?.sections?.["memory_context"],
    firstUser: firstUserText(context),
  };
}

/** 每个请求都回同一条响应的 streamFn（蒸馏/摘要旁路用）。 */
function cannedResponse(step: FauxResponseStep): StreamFn {
  return (model, context, options) => {
    const core = createFauxCore({});
    core.setResponses([step]);
    return core.streamSimple(model, context, options);
  };
}

/** 脚本化队列 streamFn：响应按请求次序消费；calls 记命中次数。 */
function scripted(steps: FauxResponseStep[]): { streamFn: StreamFn; calls: () => number } {
  const core = createFauxCore({});
  core.setResponses(steps);
  let calls = 0;
  return {
    calls: () => calls,
    streamFn: (model, context, options) => {
      calls += 1;
      return core.streamSimple(model, context, options);
    },
  };
}

/**
 * 子任务执行重叠观测：包一层 step，进入时 +1、返回前 -1。
 * 两个 child 真实并行 ⇒ peak 到 2；信号量串行 ⇒ peak 恒为 1。
 */
function overlapTracker(delayMs = 60) {
  let active = 0;
  let peak = 0;
  return {
    peak: () => peak,
    wrap(step: FauxResponseStep): FauxResponseFactory {
      return async (context, streamOptions, state, model) => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await sleep(delayMs);
          return typeof step === "function"
            ? await step(context, streamOptions, state, model)
            : step;
        } finally {
          active -= 1;
        }
      };
    },
  };
}

/**
 * 挂起的子任务响应：永不自发完成；abort（父取消或子任务超时触发的
 * childPlanner.cancel()）即刻 reject，让 child turn 以错误收场。
 */
const hangingChildStep: FauxResponseFactory = (_context, streamOptions) =>
  new Promise<AssistantMessage>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("挂起的子任务流未被中止")), 15_000);
    streamOptions?.signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        const reason: unknown = streamOptions.signal?.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason ?? "aborted")));
      },
      { once: true },
    );
  });

interface OrchestratedRoutes {
  parent: StreamFn;
  /** childKey → 该 child 的脚本化 streamFn。 */
  children: Record<string, StreamFn>;
  /** 按 child 的首条 user 消息（task 文本）路由到 childKey。 */
  classifyChild: (firstUser: string) => string;
  distill?: StreamFn;
  summary?: StreamFn;
  /** 命中 parent/child 的请求逐条推入。 */
  seen?: RouteCapture[];
  /** 蒸馏请求计数（child close 不该触发蒸馏）。 */
  onDistill?: () => void;
}

/** 编排分流 streamFn：父子/各 child/旁路请求精确路由，互不消耗响应队列。 */
function orchestratedStream(routes: OrchestratedRoutes): StreamFn {
  const distill = routes.distill ?? cannedResponse(fauxAssistantMessage("UNCHANGED"));
  const summary =
    routes.summary ??
    cannedResponse(fauxAssistantMessage("## 摘要\n- 已确认约束与行程要点已保留"));
  return (model, context, options) => {
    if (isDistillRequest(context)) {
      routes.onDistill?.();
      return distill(model, context, options);
    }
    if (isSummaryRequest(context)) return summary(model, context, options);
    const tools = getCurrentTools(context.messages).map((tool) => tool.name);
    if (tools.includes(DELEGATE_TASK_TOOL)) {
      routes.seen?.push(capture("parent", context));
      return routes.parent(model, context, options);
    }
    const key = routes.classifyChild(firstUserText(context));
    const stream = routes.children[key];
    assert.ok(stream, `未配置的 child 路由："${key}"（task 文本不含分类关键词）`);
    routes.seen?.push(capture("child", context, key));
    return stream(model, context, options);
  };
}

// ---- fixture ----

async function openSessions(t: TestContext): Promise<SessionRepository> {
  const sessions = createSqliteSessionRepository(":memory:");
  t.after(() => sessions.close());
  await sessions.createUser({ userId: USER });
  return sessions;
}

async function seedMemory(sessions: SessionRepository): Promise<void> {
  await sessions.putUserMemory(USER, {
    content: MEMORY_DOC,
    sourceSessionId: null,
    throughMessageSeq: 0,
  });
}

/** 按标题片段取种子活动；缺失即失败（防种子模板漂移静默错用）。 */
async function eventOn(
  repository: EventRepository,
  category: string,
  titlePart: string,
): Promise<Event> {
  const found = (await repository.search({ date: DAY1, category })).find((event) =>
    event.title.includes(titlePart),
  );
  assert.ok(found, `种子活动缺失：${DAY1}/${category}/${titlePart}`);
  return found;
}

async function openPlanner(
  t: TestContext,
  options: {
    sessions: SessionRepository;
    repository: EventRepository;
    streamFn: StreamFn;
    config?: ExplorerConfig;
    subagentSemaphore?: SubagentSemaphore;
    subagentTimeoutMs?: number;
    maxSubagentDepth?: number;
  },
) {
  const planner = await createPersistentPlanner({
    config: options.config ?? CONFIG,
    repository: options.repository,
    sessions: options.sessions,
    userId: USER,
    streamFn: options.streamFn,
    currentDate: BASE,
    subagentSemaphore: options.subagentSemaphore,
    subagentTimeoutMs: options.subagentTimeoutMs,
    maxSubagentDepth: options.maxSubagentDepth,
  });
  t.after(() => planner.close());
  return planner;
}

/** 会话库中已落库消息（去 payload 包装）。 */
async function storedMessages(
  sessions: SessionRepository,
  sessionId: string,
): Promise<AgentMessage[]> {
  const records = await messageRecords(sessions, sessionId, USER);
  return records.map((record) => (JSON.parse(record.payload) as MessagePayload).message);
}

/** 会话内指定工具名的已落库 toolResult 消息。 */
function toolResultsOf(messages: AgentMessage[], toolName: string) {
  return messages.filter(
    (m): m is Extract<AgentMessage, { role: "toolResult" }> =>
      m.role === "toolResult" && m.toolName === toolName,
  );
}

/** assistant 消息内的 toolCall 名集合。 */
function toolCallNamesOf(message: AgentMessage): string[] {
  if (message.role !== "assistant") return [];
  return (message.content ?? [])
    .filter((block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall")
    .map((block) => block.name);
}

/** 取消等待兜底：防止编排回归把测试挂死（正常路径远快于此时限）。 */
async function awaitTurn<T>(pending: Promise<T>): Promise<T> {
  return Promise.race([
    pending,
    sleep(10_000).then(() => {
      throw new Error("prompt 未在时限内收尾（疑似编排死锁）");
    }),
  ]);
}

const delegateCalls = (task: string, title: string): AssistantMessage =>
  fauxAssistantMessage([fauxToolCall(DELEGATE_TASK_TOOL, { task, title })], {
    stopReason: "toolUse",
  });

/** until 的 async 版：轮询库内状态直到落定（5s 兜底防测试挂死）。 */
async function untilAsync(cond: () => Promise<boolean>, what: string): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > 5_000) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// ---- §7.8 & §7.11：同轮并行派发成功合成行程 ----

test("同轮并行派发：两个 child 各成候选、父合成落指针；run 树/隔离/蒸馏语义齐备", async (t) => {
  const repository = await makeRepo(t);
  const sessions = await openSessions(t);
  await seedMemory(sessions);
  const evA1 = await eventOn(repository, "展览", "时间的形状");
  const evA2 = await eventOn(repository, "展览", "江南织物考");
  const evB1 = await eventOn(repository, "市集", "独立出版");
  const evB2 = await eventOn(repository, "书店活动", "江边日记");

  const tracker = overlapTracker();
  const childA = scripted([
    tracker.wrap(
      fauxAssistantMessage([fauxToolCall(SEARCH_EVENTS_TOOL, { date: DAY1, category: "展览" })], {
        stopReason: "toolUse",
      }),
    ),
    tracker.wrap(
      fauxAssistantMessage(
        envelope(
          {
            date: DAY1,
            summary: "下午看展线",
            stops: [
              { event_id: evA1.id, arrive_at: "13:00", leave_at: "14:30", reason: "主展" },
              { event_id: evA2.id, arrive_at: "15:00", leave_at: "16:00", reason: "织物展" },
            ],
          },
          { date: DAY1, availableStart: "13:00", availableEnd: "18:00" },
        ),
      ),
    ),
  ]);
  const childB = scripted([
    tracker.wrap(
      fauxAssistantMessage([fauxToolCall(SEARCH_EVENTS_TOOL, { date: DAY1, category: "市集" })], {
        stopReason: "toolUse",
      }),
    ),
    tracker.wrap(
      fauxAssistantMessage(
        envelope(
          {
            date: DAY1,
            summary: "市集+签售",
            stops: [
              { event_id: evB1.id, arrive_at: "12:30", leave_at: "14:00", reason: "市集" },
              { event_id: evB2.id, arrive_at: "19:00", leave_at: "20:30", reason: "签售" },
            ],
          },
          { date: DAY1, availableStart: "12:00", availableEnd: "21:00" },
        ),
      ),
    ),
  ]);
  const parent = scripted([
    fauxAssistantMessage(
      [
        fauxToolCall(DELEGATE_TASK_TOOL, { task: TASK_A, title: "下午看展方案" }),
        fauxToolCall(DELEGATE_TASK_TOOL, { task: TASK_B, title: "市集书店方案" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      envelope(
        {
          date: DAY1,
          summary: "看展+市集+签售一日行",
          stops: [
            { event_id: evA1.id, arrive_at: "13:00", leave_at: "14:30", reason: "主展" },
            { event_id: evB1.id, arrive_at: "15:00", leave_at: "16:30", reason: "市集" },
            { event_id: evB2.id, arrive_at: "19:00", leave_at: "20:30", reason: "签售" },
          ],
        },
        { date: DAY1, availableStart: "13:00", availableEnd: "21:00" },
      ),
    ),
  ]);

  let distillCalls = 0;
  const seen: RouteCapture[] = [];
  const streamFn = orchestratedStream({
    parent: parent.streamFn,
    children: { a: childA.streamFn, b: childB.streamFn },
    classifyChild: (text) => (text.includes("市集") ? "b" : "a"),
    seen,
    onDistill: () => {
      distillCalls += 1;
    },
    distill: cannedResponse(fauxAssistantMessage(DISTILL_DOC)),
  });

  const planner = await openPlanner(t, { sessions, repository, streamFn });
  const parentSessionId = planner.sessionId as string;
  const turn = await planner.prompt("周六白天看展，傍晚逛市集晚上听签售", {
    location: LOCATION,
  });
  assert.equal(turn.kind, "itinerary");
  if (turn.kind === "itinerary") assert.equal(turn.itinerary.stops.length, 3);

  // 父挂 delegate_task 与派发节；两个 child 真实并行（重叠峰值 2）。
  const parentReq = seen.find((cap) => cap.route === "parent");
  assert.ok(parentReq?.toolNames.includes(DELEGATE_TASK_TOOL));
  assert.match(parentReq?.systemText ?? "", /子任务委派/);
  assert.equal(tracker.peak(), 2, "同轮两个 delegate_task 应真实并行执行");

  // 两个 kind='child' 会话：父指针、title、无正式行程指针。
  const children = (await sessions.listSessions(USER)).filter((s) => s.kind === "child");
  assert.equal(children.length, 2);
  const byTitle = new Map(children.map((s) => [s.title, s]));
  const childASession = byTitle.get("下午看展方案");
  const childBSession = byTitle.get("市集书店方案");
  assert.ok(childASession && childBSession);
  for (const child of [childASession, childBSession]) {
    assert.equal(child.parentSessionId, parentSessionId);
    assert.equal(child.currentItineraryRecordId, null);
    assert.equal(child.leaseOwner, null, "execute 结束时 child 租约应已释放");
  }

  // child 首请求：继承 location_context（父本轮透传坐标）与 memory_context；
  // 工具声明与系统提示均不含 delegate_task（depth=1 到顶）。
  for (const key of ["a", "b"] as const) {
    const reqs = seen.filter((cap) => cap.route === "child" && cap.childKey === key);
    assert.ok(reqs.length >= 2, `child ${key} 应至少两次模型请求`);
    assert.deepEqual(reqs[0].toolNames, [SEARCH_EVENTS_TOOL]);
    assert.doesNotMatch(reqs[0].systemText, /delegate_task|子任务委派/);
    assert.match(reqs[0].location ?? "", /34\.27000/);
    assert.match(reqs[0].location ?? "", /108\.95000/);
    assert.match(reqs[0].memory ?? "", /常居西安/);
  }

  // run 树：父子 run 关联齐备、终态正确、deliveredAt 恒 NULL。
  const parentRuns = await sessions.listRunsBySession(USER, parentSessionId);
  assert.equal(parentRuns.length, 1);
  const parentRun = parentRuns[0];
  assert.equal(parentRun.status, "completed");
  const childRuns = await sessions.listRunsByParent(USER, parentRun.runId);
  assert.equal(childRuns.length, 2);
  for (const run of childRuns) {
    assert.equal(run.parentRunId, parentRun.runId);
    assert.equal(run.replyToSessionId, parentSessionId);
    assert.equal(run.rootRunId, parentRun.runId);
    assert.equal(run.status, "completed");
    assert.equal(run.deliveredAt, null);
    // 位置透传随 child run 的 input 快照落库。
    assert.deepEqual(JSON.parse(run.input).location, LOCATION);
  }

  // child 各自真实调过 search_events；父会话消息表零 child 内部消息（严格隔离）。
  for (const child of [childASession, childBSession]) {
    const childMessages = await storedMessages(sessions, child.sessionId);
    assert.ok(
      toolResultsOf(childMessages, SEARCH_EVENTS_TOOL).length >= 1,
      "child 会话应有 search_events toolResult",
    );
  }
  const parentMessages = await storedMessages(sessions, parentSessionId);
  for (const message of parentMessages) {
    if (message.role === "toolResult") assert.notEqual(message.toolName, SEARCH_EVENTS_TOOL);
    for (const name of toolCallNamesOf(message)) assert.notEqual(name, SEARCH_EVENTS_TOOL);
  }
  // 父收到的两个 delegate_task toolResult：constraints/itinerary/events 元信息齐备。
  const delegateResults = toolResultsOf(parentMessages, DELEGATE_TASK_TOOL);
  assert.equal(delegateResults.length, 2);
  for (const result of delegateResults) {
    assert.equal(result.isError, false);
    const detail = JSON.parse(
      (result.content[0] as { type: "text"; text: string }).text,
    ) as Record<string, unknown>;
    assert.equal(detail.status, "completed");
    assert.equal(detail.kind, "itinerary");
    assert.equal((detail.constraints as { date?: string }).date, DAY1);
    assert.ok(((detail.itinerary as { stops?: unknown[] }).stops?.length ?? 0) >= 1);
    const events = detail.events as Array<Record<string, unknown>>;
    assert.ok(events.length >= 1);
    assert.ok(events.every((e) => e.id && e.startAt && e.suggestedDurationMinutes));
  }
  // 父工具轨迹：两次 delegate_task、零 search_events。
  assert.equal(
    planner.toolCalls.filter((call) => call.toolName === DELEGATE_TASK_TOOL).length,
    2,
  );
  assert.equal(
    planner.toolCalls.filter((call) => call.toolName === SEARCH_EVENTS_TOOL).length,
    0,
  );

  // 父行程指针已推进到合并方案；child 会话不持指针（已断言 null）。
  const current = await sessions.getCurrentItinerary(USER, parentSessionId);
  assert.ok(current);
  assert.equal(current.plan.itinerary.stops.length, 3);
  assert.equal(current.plan.itinerary.stops[0].event_id, evA1.id);

  // 父 close：确认方案触发蒸馏、新文档落 user_memory；两个 child close 全程零蒸馏。
  await planner.close();
  const memory = await sessions.getUserMemory(USER);
  assert.equal(distillCalls, 1);
  assert.ok(memory?.content.includes("看展市集一日行"));
  assert.equal(memory?.sourceSessionId, parentSessionId);
});

// ---- §7.9：child 失败与子任务超时降级 ----

test("子任务超时：child run cancelled、toolResult isError+超时文案、父降级 search_events 完成规划", async (t) => {
  const repository = await makeRepo(t);
  const sessions = await openSessions(t);
  const ev = await eventOn(repository, "展览", "时间的形状");

  const child = scripted([hangingChildStep]);
  const parent = scripted([
    delegateCalls("慢速子任务", "慢速子任务"),
    fauxAssistantMessage(
      [fauxToolCall(SEARCH_EVENTS_TOOL, { date: DAY1, category: "展览" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      envelope(
        {
          date: DAY1,
          summary: "超时后自行规划",
          stops: [{ event_id: ev.id, arrive_at: "13:00", leave_at: "14:30", reason: "降级" }],
        },
        { date: DAY1, availableStart: "13:00", availableEnd: "18:00" },
      ),
    ),
  ]);
  const seen: RouteCapture[] = [];
  const streamFn = orchestratedStream({
    parent: parent.streamFn,
    children: { only: child.streamFn },
    classifyChild: () => "only",
    seen,
  });
  const planner = await openPlanner(t, {
    sessions,
    repository,
    streamFn,
    subagentTimeoutMs: 40,
  });
  const turn = await planner.prompt("周六下午出去转转");
  assert.equal(turn.kind, "itinerary", "父轮应降级完成而非被拖死");

  // 父工具轨迹：delegate_task 报错 → search_events 兜底成功。
  const dispatched = planner.toolCalls.find((call) => call.toolName === DELEGATE_TASK_TOOL);
  assert.ok(dispatched);
  assert.equal(dispatched.isError, true);
  assert.ok(
    planner.toolCalls.some((call) => call.toolName === SEARCH_EVENTS_TOOL && !call.isError),
  );

  // 落库的 delegate toolResult：isError + "子任务执行超时" 文案。
  const parentMessages = await storedMessages(sessions, planner.sessionId as string);
  const results = toolResultsOf(parentMessages, DELEGATE_TASK_TOOL);
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
  const timedOut = JSON.parse(
    (results[0].content[0] as { type: "text"; text: string }).text,
  ) as Record<string, unknown>;
  assert.equal(timedOut.status, "cancelled");
  assert.match(timedOut.error as string, /子任务执行超时/);

  // child run 终态 cancelled、租约已释放。
  const childSession = (await sessions.listSessions(USER)).find((s) => s.kind === "child");
  assert.ok(childSession);
  assert.equal(childSession.leaseOwner, null);
  const childRuns = await sessions.listRunsBySession(USER, childSession.sessionId);
  assert.equal(childRuns.length, 1);
  assert.equal(childRuns[0].status, "cancelled");
  const parentRun = (await sessions.listRunsBySession(USER, planner.sessionId as string))[0];
  assert.equal(parentRun.status, "completed");
});

test("child 校验耗尽返回 error turn：child run failed、toolResult failed+isError、父轮不被拖死", async (t) => {
  const repository = await makeRepo(t);
  const sessions = await openSessions(t);
  const ev = await eventOn(repository, "展览", "时间的形状");

  // child 连续给出非契约文本：maxCorrections 耗尽 → error turn。
  const child = scripted([
    fauxAssistantMessage("还没想好"),
    fauxAssistantMessage("再等等"),
    fauxAssistantMessage("想不出来"),
  ]);
  const parent = scripted([
    delegateCalls("产出总是不合法的子任务", "失败子任务"),
    fauxAssistantMessage(
      [fauxToolCall(SEARCH_EVENTS_TOOL, { date: DAY1, category: "展览" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      envelope(
        {
          date: DAY1,
          summary: "失败后自行规划",
          stops: [{ event_id: ev.id, arrive_at: "13:00", leave_at: "14:30", reason: "降级" }],
        },
        { date: DAY1, availableStart: "13:00", availableEnd: "18:00" },
      ),
    ),
  ]);
  const streamFn = orchestratedStream({
    parent: parent.streamFn,
    children: { only: child.streamFn },
    classifyChild: () => "only",
  });
  const planner = await openPlanner(t, { sessions, repository, streamFn });
  const turn = await planner.prompt("周六下午出去转转");
  assert.equal(turn.kind, "itinerary");

  const parentMessages = await storedMessages(sessions, planner.sessionId as string);
  const results = toolResultsOf(parentMessages, DELEGATE_TASK_TOOL);
  assert.equal(results.length, 1);
  assert.equal(results[0].isError, true);
  const failed = JSON.parse(
    (results[0].content[0] as { type: "text"; text: string }).text,
  ) as Record<string, unknown>;
  assert.equal(failed.status, "failed");
  assert.match(failed.error as string, /回复格式不符|未通过校验/);

  const childSession = (await sessions.listSessions(USER)).find((s) => s.kind === "child");
  assert.ok(childSession);
  assert.equal(childSession.leaseOwner, null);
  const childRuns = await sessions.listRunsBySession(USER, childSession.sessionId);
  assert.equal(childRuns.length, 1);
  assert.equal(childRuns[0].status, "failed");
});

// ---- §7.11：父取消级联 ----

test("父取消级联中止在途 child：父子 run 均 cancelled、租约全释放", async (t) => {
  const repository = await makeRepo(t);
  const sessions = await openSessions(t);
  const child = scripted([hangingChildStep]);
  const parent = scripted([
    delegateCalls("会被父取消的子任务", "将取消的子任务"),
    fauxAssistantMessage('{"type":"clarify","question":"不应到达"}'),
  ]);
  const seen: RouteCapture[] = [];
  const streamFn = orchestratedStream({
    parent: parent.streamFn,
    children: { only: child.streamFn },
    classifyChild: () => "only",
    seen,
  });
  const planner = await openPlanner(t, { sessions, repository, streamFn });
  const pending = planner.prompt("帮我并行看两条线");
  await until(() => seen.some((cap) => cap.route === "child"), "子任务请求已发出");
  planner.cancel();
  const turn = await awaitTurn(pending);
  assert.equal(turn.kind, "error");

  const parentRun = (await sessions.listRunsBySession(USER, planner.sessionId as string))[0];
  assert.equal(parentRun.status, "cancelled");
  const childSession = (await sessions.listSessions(USER)).find((s) => s.kind === "child");
  assert.ok(childSession);
  const childRuns = await sessions.listRunsBySession(USER, childSession.sessionId);
  assert.equal(childRuns.length, 1);
  assert.equal(childRuns[0].status, "cancelled");
  assert.equal(childRuns[0].parentRunId, parentRun.runId);

  const parentRow = await sessions.getSession(USER, planner.sessionId as string);
  assert.equal(parentRow?.leaseOwner, null);
  assert.equal(childSession.leaseOwner, null);
});

// ---- §7.10：信号量限流排队 ----

test("信号量定容：subagentMaxConcurrent=1 时同轮派发严格串行、排队无死锁", async (t) => {
  const repository = await makeRepo(t);
  const sessions = await openSessions(t);
  const evA1 = await eventOn(repository, "展览", "时间的形状");
  const evB1 = await eventOn(repository, "市集", "独立出版");

  // 进程级默认池按容量分池：容量 1 与默认 8 是两个独立信号量（定容修复点）。
  assert.notEqual(getDefaultSubagentSemaphore(1), getDefaultSubagentSemaphore());

  const tracker = overlapTracker();
  const childA = scripted([
    tracker.wrap(
      fauxAssistantMessage([fauxToolCall(SEARCH_EVENTS_TOOL, { date: DAY1, category: "展览" })], {
        stopReason: "toolUse",
      }),
    ),
    tracker.wrap(
      fauxAssistantMessage(
        envelope(
          {
            date: DAY1,
            summary: "看展线",
            stops: [{ event_id: evA1.id, arrive_at: "13:00", leave_at: "14:30", reason: "r" }],
          },
          { date: DAY1, availableStart: "13:00", availableEnd: "18:00" },
        ),
      ),
    ),
  ]);
  const childB = scripted([
    tracker.wrap(
      fauxAssistantMessage([fauxToolCall(SEARCH_EVENTS_TOOL, { date: DAY1, category: "市集" })], {
        stopReason: "toolUse",
      }),
    ),
    tracker.wrap(
      fauxAssistantMessage(
        envelope(
          {
            date: DAY1,
            summary: "市集线",
            stops: [{ event_id: evB1.id, arrive_at: "13:00", leave_at: "14:30", reason: "r" }],
          },
          { date: DAY1, availableStart: "13:00", availableEnd: "18:00" },
        ),
      ),
    ),
  ]);
  const parent = scripted([
    fauxAssistantMessage(
      [
        fauxToolCall(DELEGATE_TASK_TOOL, { task: TASK_A, title: "看展子任务" }),
        fauxToolCall(DELEGATE_TASK_TOOL, { task: TASK_B, title: "市集子任务" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      envelope(
        {
          date: DAY1,
          summary: "合并",
          stops: [
            { event_id: evA1.id, arrive_at: "13:00", leave_at: "14:30", reason: "r" },
            { event_id: evB1.id, arrive_at: "15:00", leave_at: "16:30", reason: "r" },
          ],
        },
        { date: DAY1, availableStart: "13:00", availableEnd: "18:00" },
      ),
    ),
  ]);
  const streamFn = orchestratedStream({
    parent: parent.streamFn,
    children: { a: childA.streamFn, b: childB.streamFn },
    classifyChild: (text) => (text.includes("市集") ? "b" : "a"),
  });
  const planner = await openPlanner(t, {
    sessions,
    repository,
    streamFn,
    config: { ...CONFIG, subagentMaxConcurrent: 1 },
  });
  const turn = await awaitTurn(planner.prompt("两路并行看看"));
  assert.equal(turn.kind, "itinerary");
  assert.equal(tracker.peak(), 1, "容量 1 时子任务执行重叠峰值必须严格为 1");

  // 两个 child 排队依次完成，无死锁。
  const children = (await sessions.listSessions(USER)).filter((s) => s.kind === "child");
  assert.equal(children.length, 2);
  const childRuns = (
    await Promise.all(children.map((c) => sessions.listRunsBySession(USER, c.sessionId)))
  ).flat();
  assert.equal(childRuns.length, 2);
  for (const run of childRuns) assert.equal(run.status, "completed");
});

// ---- §7.11 固化：WebChatService.shutdown() 级联取消真实在途 child ----

test("shutdown 级联：在途 child 被取消，父子 run 落 cancelled、双租约即释放（关库安全）", async (t) => {
  const repository = await makeRepo(t);
  const sessions = await openSessions(t);

  // child 流挂起：进入时置标（证明在流式等待），仅 abort 才返回。
  let childStreaming = false;
  const hanging: FauxResponseFactory = (context, streamOptions, state, model) => {
    childStreaming = true;
    return hangingChildStep(context, streamOptions, state, model);
  };
  const child = scripted([hanging]);
  const parent = scripted([
    delegateCalls("慢速看展子任务", "慢速看展子任务"),
    fauxAssistantMessage('{"type":"clarify","question":"不应到达"}'),
  ]);
  const streamFn = orchestratedStream({
    parent: parent.streamFn,
    children: { only: child.streamFn },
    classifyChild: () => "only",
  });
  const service = createChatService({
    config: CONFIG,
    repository,
    sessions,
    streamFn,
    currentDate: BASE,
  });

  // 即发即挂 outcome，防 shutdown 后 reject 先于断言变成 unhandled。
  const sendOutcome = service
    .send(USER, "周六下午出去转转", { location: LOCATION })
    .then(
      () => null,
      (error: unknown) => error,
    );

  // 等 child 会话与 running 状态的 child run 落库、且 child 流真实挂起。
  let parentSessionId = "";
  let childSessionId = "";
  await untilAsync(async () => {
    if (!childStreaming) return false;
    const all = await sessions.listSessions(USER);
    const mains = all.filter((s) => s.kind === "main");
    const kids = all.filter((s) => s.kind === "child");
    if (mains.length !== 1 || kids.length !== 1) return false;
    const parentRuns = await sessions.listRunsBySession(USER, mains[0].sessionId);
    const childRuns = await sessions.listRunsBySession(USER, kids[0].sessionId);
    if (
      !parentRuns.some((r) => r.status === "running") ||
      !childRuns.some((r) => r.status === "running")
    ) {
      return false;
    }
    parentSessionId = mains[0].sessionId;
    childSessionId = kids[0].sessionId;
    return true;
  }, "child 会话与 running run 落库、child 流式挂起");

  // shutdown 级联取消在途 send（含 child）并等 settle+close 全部完成。
  await Promise.race([
    service.shutdown(),
    sleep(10_000).then(() => {
      throw new Error("shutdown 未在时限内收尾（疑似级联死锁）");
    }),
  ]);

  // send Promise 以中止错误结束。
  const sendError = await sendOutcome;
  assert.ok(sendError instanceof Error);
  assert.equal(sendError.name, "AbortError");

  // shutdown() 返回这一刻（不额外 sleep）：父子 run 均已落终态 cancelled，
  // 两会话写租约完全释放——其他 owner 立即可 acquireLease，证明关库安全。
  const parentRun = (await sessions.listRunsBySession(USER, parentSessionId)).at(-1);
  assert.equal(parentRun?.status, "cancelled");
  const childRun = (await sessions.listRunsBySession(USER, childSessionId)).at(-1);
  assert.equal(childRun?.status, "cancelled");
  assert.equal(childRun?.parentRunId, parentRun?.runId);
  for (const sid of [parentSessionId, childSessionId]) {
    const writer = await sessions.acquireLease(USER, sid, `probe-${sid}`, 60_000);
    assert.ok(writer, `${sid} 的写租约应在 shutdown() 返回时已释放`);
    await sessions.releaseLease(writer, USER, sid);
  }
});

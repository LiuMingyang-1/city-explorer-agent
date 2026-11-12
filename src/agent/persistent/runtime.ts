import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentEvent,
  AgentMessage,
  PrepareRequestContext,
} from "@earendil-works/pi-agent-core";
import type { PrepareRequest } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, type SystemMessage } from "@earendil-works/pi-ai";
import { projectHistory, type Checkpoint } from "../../compaction/checkpoint.ts";
import { compact, type CompactionOptions, type CompactionResult } from "../../compaction/compact.ts";
import { createUsageBaseline, type UsageBaseline } from "../../compaction/tokens.ts";
import { distillMemory } from "../../memory/distill.ts";
import { closeInterrupted } from "../interrupted.ts";
import type { SessionRepository } from "../../session/repository.ts";
import type {
  CompactionPayload,
  LeaseWriter,
  Run,
  SessionKind,
  ValidatedPlan,
} from "../../session/types.ts";
import { SessionRepositoryError } from "../../session/types.ts";
import { abortedTurn } from "../session.ts";
import type {
  PlannerCompactOutcome,
  PlannerPromptOptions,
  PlannerRuntime,
  PlannerSession,
  PlannerTurn,
  ValidatedPlanCommit,
} from "../session.ts";
import { runtimeSystemMessage, type LocationContext } from "./context.ts";
import { RawHistory } from "./history.ts";
import { LeaseGuard } from "./lease.ts";
import {
  errorText,
  findRunByRequestId,
  latestCandidatePlan,
  replayedTurn,
  requestInputLocation,
  requestInputText,
  settleRun,
} from "./runs.ts";

/**
 * 本轮可派发上下文（delegate_task 编排接缝）：runPrompt 建好 run 后由
 * onActiveTurnChange 回调交给 dispatch 上下文槽；finally 清空时回调
 * undefined。槽为空说明当前不在可派发的持久运行上下文中。
 */
export interface ActiveDispatchTurn {
  userId: string;
  sessionId: string;
  runId: string;
  /** 本轮持有的会话写租约（建 child 会话、写子 run 用它证明树归属）。 */
  writer: LeaseWriter;
  /** 父会话当前生效位置（本轮透传优先，否则 reload 恢复的最近位置）。 */
  location?: { lat: number; lng: number };
  /** 编排递归深度：对话 = 0，子任务 = 1。 */
  depth: number;
  /** 父会话写租约已失效（lease_lost/archived）时中止父轮，不空跑浪费 token。 */
  failParentLease: (error: unknown) => void;
}

export interface PersistentRuntimeOptions {
  agent: Agent;
  /** 回调宿主：performTurn 执行纠正循环、restorePlan 恢复已确认规划。 */
  planner: PlannerSession;
  sessions: SessionRepository;
  userId: string;
  /** 缺省新建一条 kind='main' 对话会话；显式给定时必须属于该用户且 active（main/child 均可）。 */
  sessionId?: string;
  /** 新建对话时的会话标题（仅未传 sessionId 时生效）。 */
  title?: string;
  /** 编排入参：本运行器所建 run 的父 run（child 任务派发时透传）。 */
  parentRunId?: string;
  /** 编排入参：结果回投目标会话，随 run 记录落库（本期同步派发仅存档）。 */
  replyToSessionId?: string;
  /** 编排递归深度：对话 = 0、child 任务 = 1；缺省 0。 */
  depth?: number;
  /** close 机会蒸馏的无方案保底门槛（新增 user 消息条数）；缺省走 distill.ts 的默认。 */
  memoryMinUserMessages?: number;
  /**
   * runPrompt 派发上下文回调：建 run 成功置位、收尾清空；
   * delegate_task 用它读取父 run/租约/位置/深度并级联父租约失败。
   */
  onActiveTurnChange?: (active: ActiveDispatchTurn | undefined) => void;
  leaseOwner?: string;
  /** 写租约 TTL；默认 30_000ms。 */
  leaseTtlMs?: number;
  /** 心跳间隔；缺省 leaseTtlMs/3。 */
  leaseRenewMs?: number;
  compaction: CompactionOptions;
  /**
   * 位置锚点解析：本轮带 location 时把坐标翻成语义锚点文案（就近场馆）；
   * 缺省或抛错都降级为无锚点，绝不影响本轮。
   */
  resolveLocationAnchor?: (lat: number, lng: number) => Promise<string | undefined>;
  /** close 机会蒸馏的单请求输入上限（字符）；缺省走 distill.ts 的默认。 */
  memoryInputChars?: number;
  /** close 机会蒸馏的硬超时（毫秒）；缺省 90_000。 */
  memoryDistillTimeoutMs?: number;
  /**
   * close 机会蒸馏后台执行：不阻塞 close（web send 的响应路径）。同用户
   * 的多次触发进每用户串行尾随队列：在途时排入队尾等前序完成后顺次执行，
   * 不丢末轮、不并发写 user_memory 游标。
   * 缺省 false（同步）——进程即将退出的调用方（CLI）应同步蒸完。
   */
  detachDistill?: boolean;
}

/** close 机会蒸馏的默认硬超时：须覆盖单次较大输入请求的时延。 */
const DEFAULT_DISTILL_TIMEOUT_MS = 90_000;

/**
 * 每用户串行尾随蒸馏队列：detachDistill 的 close 触发按 userId 串行排水。
 * 同 sessionId 在排队期间合并为最新一次；不同 sessionId 按插入序各蒸
 * 一轮——既避免对话末轮被静默漏蒸，也消除同一用户跨对话并发
 * putUserMemory 的游标覆盖竞态。job 出队先于执行：运行期间同会话再次
 * close 会重新入队补跑一轮，末轮蒸馏不丢。
 */
interface DistillQueueState {
  running: boolean;
  pending: Map<string, () => Promise<void>>;
}
const distillQueues = new Map<string, DistillQueueState>();

function enqueueDistill(userId: string, sessionId: string, job: () => Promise<void>): void {
  let state = distillQueues.get(userId);
  if (state === undefined) {
    state = { running: false, pending: new Map() };
    distillQueues.set(userId, state);
  }
  // 同 sessionId 合并为最新一次：先删再置，把它移到队尾，严格保持
  // close 的先后顺序（否则 A → B → A' 会按 A 的旧位置执行成 A' → B）。
  state.pending.delete(sessionId);
  state.pending.set(sessionId, job);
  if (state.running) return;
  state.running = true;
  void drainDistillQueue(userId, state);
}

async function drainDistillQueue(userId: string, state: DistillQueueState): Promise<void> {
  try {
    while (state.pending.size > 0) {
      const [sessionId, job] = state.pending.entries().next().value as [
        string,
        () => Promise<void>,
      ];
      state.pending.delete(sessionId);
      await job();
    }
  } finally {
    // job 自身已兜底不抛；万一抛出且队列尚有新任务，重启排水不丢。
    state.running = false;
    if (state.pending.size === 0) {
      distillQueues.delete(userId);
    } else {
      state.running = true;
      void drainDistillQueue(userId, state);
    }
  }
}

/**
 * 持久化运行时：把 PlannerSession 的内存纠正循环接到 SQLite 会话仓库上。
 *
 * - 本地 busy 互斥 + 每轮 DB 租约（epoch fencing，见 LeaseGuard）：两个实例
 *   轮流写不会让旧内存覆盖新记录——每轮先 acquire、再增量重载最新
 *   上下文与规划指针。
 * - raw/检查点/上下文投影见 RawHistory 与 context.ts；meta 维护
 *   消息对象→record_id/message_seq 映射（compact 依赖对象同一性）。
 * - message_end 逐条落库；写失败进 LeaseGuard 闩锁（abort + 禁写），
 *   不让 Pi 吞掉订阅异常继续跑出"成功"轮次。
 * - prepareRequest 前挂压缩；appendCompaction 成功才切 agent.state.messages。
 *   交回循环的上下文必须是独立数组（消息对象引用共享）：Pi 循环与
 *   message_end 事件都会向各自数组追加，共享数组会让同一消息写两遍。
 * - prompt/compact 的整轮（含验证/纠正/run 收尾）记录在 inFlight；
 *   close 取消并等它完成再退订钩子、停心跳、释放租约。
 */
export class PersistentRuntime implements PlannerRuntime {
  private readonly agent: Agent;
  private readonly planner: PlannerSession;
  private readonly repo: SessionRepository;
  private readonly userId: string;
  private readonly requestedSessionId?: string;
  private readonly title?: string;
  private readonly parentRunId?: string;
  private readonly replyToSessionId?: string;
  private readonly depth: number;
  private readonly owner: string;
  private readonly compaction: CompactionOptions;
  private readonly resolveLocationAnchor?: PersistentRuntimeOptions["resolveLocationAnchor"];
  private readonly memoryInputChars?: number;
  private readonly memoryMinUserMessages?: number;
  private readonly memoryDistillTimeoutMs: number;
  private readonly detachDistill: boolean;
  private readonly onActiveTurnChange?: PersistentRuntimeOptions["onActiveTurnChange"];
  private readonly guard: LeaseGuard;

  private sessionIdValue = "";
  /** 会话类型：main 才维护行程指针；child 只留消息与 run（候选不落指针）。 */
  private sessionKind: SessionKind = "main";
  private baseSystem: SystemMessage | undefined;
  /** 已确认规划（仅 main；DB 指针为准）；渲染进 system section，不落 raw。 */
  private persistedPlan: ValidatedPlan | undefined;
  /**
   * child 候选规划（仅 child）：本会话最新成功 run 的 itinerary 产出，
   * 经 run 结果持久化而非行程指针；渲染进 system section 但标注候选，
   * 不落 raw、不冒充 main 的正式状态。
   */
  private candidatePlan: ValidatedPlan | undefined;
  /**
   * 用户最近位置（含锚点）：渲染进 system section，不落 raw、不进消息表。
   * 跨实例/请求沿用靠"location 已落地 run 中 message_seq 最大者"持久化——
   * reload 每次从会话库恢复（与 DB 一致，含另一实例的提交）；本轮
   * 透传新位置时在租约内覆盖并随新 run 的 input 快照落库。锚点不入
   * 快照，恢复时按当前活动库重解。
   */
  private locationContext?: LocationContext;
  /**
   * 用户长期记忆文档（user_memory.content）：用户级数据，与会话类型无关，
   * main/child 注入同一份；渲染进 system section，不落 raw、不进消息表。
   * 每次 reload 重读（含另一实例在 close 时蒸馏的新版）。
   */
  private memoryText: string | undefined;
  private readonly history = new RawHistory();
  private checkpoint: Checkpoint | undefined;
  private readonly baseline: UsageBaseline = createUsageBaseline();

  private busyFlag = false;
  private closed = false;
  private controller: AbortController | undefined;
  private cancelRequested = false;
  private cancelReason: string | undefined;
  private activeRunId: string | undefined;
  /** 本轮第一条 user 消息携带的请求级幂等键。 */
  private pendingDedupeKey: string | undefined;
  /**
   * 本轮是否已完成 plan 提交（线性化点）：repo 返回时标注+指针已同
   * 事务落库，此后到达的 cancel/close 不能再把成功结果抹成 cancelled。
   */
  private turnCommitted = false;
  /** 在途整轮操作（prompt/compact 全程，含验证/纠正/settleRun）；close 等它收尾。 */
  private inFlight: Promise<unknown> | undefined;
  /** 在途操作的异步上下文标记：close 据此识别并拒绝 op（含 Agent 事件回调）链内的调用。 */
  private readonly opScope = new AsyncLocalStorage<symbol>();
  private opToken: symbol | undefined;
  /** close 幂等句柄：并发 close 都 await 同一个收尾 Promise。 */
  private closing: Promise<void> | undefined;

  private unsubscribe: (() => void) | undefined;
  private prevPrepareRequest: PrepareRequest | undefined;

  constructor(options: PersistentRuntimeOptions) {
    this.agent = options.agent;
    this.planner = options.planner;
    this.repo = options.sessions;
    this.userId = options.userId;
    this.requestedSessionId = options.sessionId;
    this.title = options.title;
    this.parentRunId = options.parentRunId;
    this.replyToSessionId = options.replyToSessionId;
    this.depth = options.depth ?? 0;
    this.owner = options.leaseOwner ?? `planner-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.compaction = options.compaction;
    this.resolveLocationAnchor = options.resolveLocationAnchor;
    this.memoryInputChars = options.memoryInputChars;
    this.memoryMinUserMessages = options.memoryMinUserMessages;
    this.memoryDistillTimeoutMs =
      options.memoryDistillTimeoutMs ?? DEFAULT_DISTILL_TIMEOUT_MS;
    this.onActiveTurnChange = options.onActiveTurnChange;
    this.detachDistill = options.detachDistill ?? false;
    const ttlMs = options.leaseTtlMs ?? 30_000;
    this.guard = new LeaseGuard({
      repo: options.sessions,
      userId: options.userId,
      sessionId: () => this.sessionIdValue,
      owner: this.owner,
      ttlMs,
      renewMs: options.leaseRenewMs ?? Math.max(50, Math.floor(ttlMs / 3)),
      // 租约失效/写失败：闩锁已在 guard 内置位，这里中止在途运行。
      onDead: () => this.agent.abort(),
    });
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  get busy(): boolean {
    return this.busyFlag || this.agent.state.isStreaming;
  }

  /** 打开会话：校验归属 → 租约内恢复/补全 → 挂持久化订阅与压缩钩子。 */
  async open(): Promise<void> {
    await this.resolveSession();
    this.baseSystem = getCurrentSystemMessage(this.agent.state.messages);
    // 恢复路径可能写库（中断补全、死 run 标记），同样在租约内进行。
    await this.guard.run(() => this.reload());
    this.unsubscribe = this.agent.subscribe((event) => this.onAgentEvent(event));
    this.prevPrepareRequest = this.agent.prepareRequest;
    this.agent.prepareRequest = (request, signal) => this.onPrepareRequest(request, signal);
  }

  private async resolveSession(): Promise<void> {
    if (this.requestedSessionId !== undefined) {
      // 显式会话：main 与 child 都允许打开（编排层要开 child 会话）。
      const session = await this.repo.getSession(this.userId, this.requestedSessionId);
      if (!session) {
        throw new SessionRepositoryError(
          "not_found",
          `会话 ${this.requestedSessionId} 不存在或不属于用户 ${this.userId}`,
        );
      }
      if (session.status !== "active") {
        throw new SessionRepositoryError("archived", `会话 ${session.sessionId} 已归档，不能打开`);
      }
      this.sessionIdValue = session.sessionId;
      this.sessionKind = session.kind;
      return;
    }
    // 未指定会话：幂等建用户 + 懒建一条新对话（每次访问即新对话；
    // 跨对话连续性由 user_memory 承担）。
    await this.repo.createUser({ userId: this.userId });
    const created = await this.repo.createConversation(
      this.userId,
      this.title !== undefined ? { title: this.title } : undefined,
    );
    this.sessionIdValue = created.sessionId;
    this.sessionKind = created.kind;
  }

  // ---- 恢复 / 增量重载（调用方须持租约） ----

  private async reload(): Promise<void> {
    const writer = this.guard.current;
    if (!writer) throw new Error("reload 必须在会话写租约内执行");
    // 1) 进程崩溃/租约易主遗留的非终态 run：标 failed，不留永远 running。
    const runs = await this.repo.listRunsBySession(this.userId, this.sessionIdValue);
    for (const run of runs) {
      if (run.status === "running" || run.status === "queued") {
        await this.guard.guarded((w) =>
          this.repo.finishRun(w, this.userId, run.runId, {
            status: "failed",
            error: "运行被中断：上一写者崩溃或租约丢失",
          }),
        );
      }
    }
    // 2) 增量加载新消息（每条 payload 只解析一次）。
    const fresh = await this.repo.listMessagesFrom(
      this.userId,
      this.sessionIdValue,
      this.history.maxMessageSeq + 1,
    );
    for (const record of fresh) this.history.indexStored(record);
    // 3) 尾部未完结工具批次：补 isError 的 toolResult，不重跑工具。
    for (const message of closeInterrupted(this.history.raw)) {
      const record = await this.guard.guarded((w) =>
        this.repo.appendMessage(w, this.userId, this.sessionIdValue, {
          payload: { message },
        }),
      );
      this.history.indexLive(message, record);
    }
    // 4) 最新合法检查点（仓库已按写入前缀校验；非法记录此处抛 corrupt）。
    const latest = await this.repo.latestCompaction(this.userId, this.sessionIdValue);
    this.checkpoint = latest
      ? {
          summary: latest.payload.summary,
          timestamp: Date.parse(latest.record.createdAt),
          firstKept: this.history.ordinalFor(latest.payload.first_kept_message_seq),
        }
      : undefined;
    // 5) 规划状态：main 以 DB 行程指针为准（含另一实例的提交）；
    //    child 不维护指针，只从自身最新成功 run 的产出恢复候选。
    if (this.sessionKind === "main") {
      const current = await this.repo.getCurrentItinerary(this.userId, this.sessionIdValue);
      this.persistedPlan = current?.plan;
      this.planner.restorePlan(current?.plan);
    } else {
      this.candidatePlan = latestCandidatePlan(runs, this.history.maxSeqByRun());
      this.planner.restorePlan(this.candidatePlan);
    }
    // 6) 用户最近位置：input 带 location 且已落库消息的 run 中，
    //    message_seq 最大者即最近上报（message_seq 由仓库事务内单调
    //    分配，与墙上时间无关）；本轮透传的新位置在 reload 之后由
    //    runPrompt 覆盖，并随新 run 的 input 落库。
    this.locationContext = await this.persistedLocation(runs);
    // 7) 用户长期记忆：用户级读不需要写者凭证；读失败与其他恢复读一致，
    //    原样抛出结束本轮恢复。
    this.memoryText = (await this.repo.getUserMemory(this.userId))?.content;
    // 8) 重建有效上下文：system 由当前配置重建，摘要 + 保留尾部用 raw 同对象。
    this.applyContext();
    this.baseline.clear();
  }

  /**
   * 用当前 system/checkpoint/raw 重建 agent 可见上下文（agent 空闲时调用）。
   * 返回新投影数组：可以交回 Pi 循环，绝不能回传 agent.state.messages
   * 的内部数组（循环与 message_end 追加都会写它）。
   */
  private applyContext(): AgentMessage[] {
    const messages = projectHistory(
      this.history.raw,
      this.checkpoint,
      runtimeSystemMessage(
        this.baseSystem,
        this.sessionKind === "child" ? this.candidatePlan : this.persistedPlan,
        this.sessionKind === "child" ? "candidate" : "confirmed",
        this.locationContext,
        this.memoryText,
      ),
    );
    this.agent.state.messages = messages;
    return messages;
  }

  // ---- Agent 事件与压缩钩子 ----

  private async onAgentEvent(event: AgentEvent): Promise<void> {
    if (event.type !== "message_end") return;
    const message = event.message;
    // system/注入状态消息不落库；摘要消息不经事件流，天然不会被写。
    if (message.role === "system") return;
    // 租约持有期间（含取消/关闭收尾中的解绑）仍如实落库；
    // 无租约（op 外或已 release）的事件不是本会话写路径，跳过。
    if (!this.guard.current) return;
    if (this.guard.failure) throw this.guard.failure;
    let dedupeKey: string | undefined;
    if (message.role === "user" && this.pendingDedupeKey !== undefined) {
      dedupeKey = this.pendingDedupeKey;
      this.pendingDedupeKey = undefined;
    }
    // 订阅异常不能被 Pi 吞掉后继续成功：guarded 上闩 + abort + 原样抛出。
    const record = await this.guard.guarded((w) =>
      this.repo.appendMessage(w, this.userId, this.sessionIdValue, {
        payload: { message },
        runId: this.activeRunId,
        dedupeKey,
      }),
    );
    this.history.indexLive(message, record);
    this.baseline.observe(message, this.agent.state.messages, this.agent.state.model);
  }

  private onPrepareRequest: PrepareRequest = async (
    request: PrepareRequestContext,
    signal?: AbortSignal,
  ) => {
    if (this.closed || !this.guard.current) return undefined;
    if (this.guard.failure) throw this.guard.failure;
    const result = await compact({
      agent: this.agent,
      model: request.model,
      messages: request.context.messages,
      raw: this.history.raw,
      checkpoint: this.checkpoint,
      baseline: this.baseline,
      options: this.compaction,
      manual: false,
      signal,
    });
    if (!result) return undefined;
    // 先落库再切上下文：appendCompaction 失败会抛错结束本轮，内存保持原样。
    this.checkpoint = await this.persistCheckpoint(result, request);
    this.baseline.clear();
    // applyContext 返回独立数组（消息对象仍是 raw 同引用）：
    // 循环向它追加、事件向 state.messages 追加，两数组不得共享。
    return { context: { ...request.context, messages: this.applyContext() } };
  };

  /** compact 结果 → CompactionPayload 落库；raw 序号 ↔ message_seq 在此换算。 */
  private async persistCheckpoint(
    result: CompactionResult,
    request: PrepareRequestContext,
  ): Promise<Checkpoint> {
    const firstKeptSeq =
      result.firstKept <= this.history.raw.length
        ? (this.history.messageSeqOf(this.history.raw[result.firstKept - 1]) as number)
        : this.history.maxMessageSeq + 1;
    const payload: CompactionPayload = {
      summary: result.summary,
      source_through_message_seq: this.history.maxMessageSeq,
      first_kept_message_seq: firstKeptSeq,
      tokens_before: result.tokensBefore,
      tokens_after: result.tokensAfter,
      model_ref: `${request.model.provider}/${request.model.id}`,
      usage: result.usage,
    };
    await this.guard.guarded((w) =>
      this.repo.appendCompaction(w, this.userId, this.sessionIdValue, { payload }),
    );
    return { summary: result.summary, timestamp: result.timestamp, firstKept: result.firstKept };
  }

  // ---- PlannerRuntime ----

  async prompt(text: string, options: PlannerPromptOptions = {}): Promise<PlannerTurn> {
    if (this.closed) return { kind: "error", message: "会话已关闭" };
    if (this.busy) return { kind: "error", message: "上一请求仍在处理中" };
    this.busyFlag = true;
    const controller = new AbortController();
    this.controller = controller;
    this.cancelRequested = false;
    this.cancelReason = undefined;
    this.turnCommitted = false;
    // 整轮（租约+验证+纠正+run 收尾）计入 inFlight：close 等它真正结束。
    const op = this.track(() => this.runPrompt(text, options, controller.signal));
    try {
      return await op;
    } finally {
      this.untrack(op);
      this.busyFlag = false;
      this.controller = undefined;
    }
  }

  private async runPrompt(
    text: string,
    options: PlannerPromptOptions,
    signal: AbortSignal,
  ): Promise<PlannerTurn> {
    try {
      return await this.guard.run(async () => {
        // 每轮先同步 DB 最新上下文、规划指针与最近位置，再处理本轮。
        await this.reload();
        // 同步恢复期间被取消/关闭：不查重放、不建 run、不发模型请求。
        const stopped = abortedTurn(signal);
        if (stopped) return stopped;
        if (options.requestId !== undefined) {
          const prior = await findRunByRequestId(
            this.repo,
            this.userId,
            this.sessionIdValue,
            options.requestId,
          );
          if (prior) {
            // 幂等键绑定同一条输入文本：同键同文本重放；
            // 同键不同文本是调用方错误 → 明确冲突，不建 run 不写消息。
            if (requestInputText(prior) === text) return replayedTurn(prior);
            return {
              kind: "error",
              code: "request_conflict",
              message: `requestId "${options.requestId}" 已用于不同的请求文本`,
            };
          }
        }
        // 本轮透传位置则覆盖恢复值（锚点解析失败降级为无，不毁掉本轮）；
        // 没带 location 时沿用 reload 恢复的最近位置。必须在建 run 前
        // 渲染：performTurn 的首个模型请求就要带上新 section。坐标随本
        // 条 run 的 input 快照落库，成为后续写者/实例的最近位置。
        if (options.location) {
          const { lat, lng } = options.location;
          this.locationContext = { lat, lng, anchor: await this.anchorFor(lat, lng) };
          this.applyContext();
        }
        const run = await this.guard.guarded((w) =>
          this.repo.createRun(w, this.userId, {
            sessionId: this.sessionIdValue,
            input: {
              text,
              requestId: options.requestId ?? null,
              location: options.location ?? null,
            },
            parentRunId: this.parentRunId,
            replyToSessionId: this.replyToSessionId,
            startImmediately: true,
          }),
        );
        this.activeRunId = run.runId;
        // 派发上下文槽置位：delegate_task 本轮可读到父 run/租约/位置/深度。
        this.onActiveTurnChange?.({
          userId: this.userId,
          sessionId: this.sessionIdValue,
          runId: run.runId,
          writer: this.guard.current!,
          location: this.locationContext
            ? { lat: this.locationContext.lat, lng: this.locationContext.lng }
            : undefined,
          depth: this.depth,
          failParentLease: (error) => this.guard.fail(error),
        });
        this.pendingDedupeKey =
          options.requestId !== undefined ? `request:${options.requestId}` : undefined;
        try {
          const turn = await this.planner.performTurn(text, {
            signal,
            onProgress: options.onProgress,
          });
          // 终态线性化点：plan 已提交（main）或本轮产出非 error turn
          // （child 候选/追问）⇒ completed；此后到达的 cancel/close 只是
          // "迟到"，不再把已持久的结果抹成 cancelled。
          const produced = this.turnCommitted || turn.kind !== "error";
          const warning = await settleRun(
            this.repo,
            this.guard.current,
            this.userId,
            this.activeRunId,
            produced ? "completed" : this.cancelRequested ? "cancelled" : "failed",
            turn.kind === "error" ? undefined : { turn },
            turn.kind === "error" ? turn.message : this.cancelReason,
          );
          return warning ? this.withWarning(turn, warning) : turn;
        } catch (error) {
          const warning = await settleRun(
            this.repo,
            this.guard.current,
            this.userId,
            this.activeRunId,
            this.turnCommitted ? "completed" : this.cancelRequested ? "cancelled" : "failed",
            undefined,
            errorText(error),
          );
          return {
            kind: "error",
            message: errorText(error) + (warning ? `（${warning}）` : ""),
          };
        } finally {
          this.activeRunId = undefined;
          this.pendingDedupeKey = undefined;
          this.onActiveTurnChange?.(undefined);
        }
      });
    } catch (error) {
      return { kind: "error", message: errorText(error) };
    }
  }

  /**
   * 会话最近位置：input 带合法 location 且"上报已落地"（该 run 至少有
   * 一条落库消息）的 run 中，取最大 message_seq 者——seq 由仓库在
   * 会话内事务性单调分配，不依赖 created_at/系统时钟（同毫秒、时钟
   * 回拨、并发重启都不会错乱），与 latestCandidatePlan 同序。
   * 没有落库消息的 location run（建 run 后即取消/失败，上报未落地）
   * 不算数，不覆盖更早的已上报位置。锚点不随快照持久化，这里按
   * 当前活动库重解（失败降级为无锚点，不阻塞恢复）。
   */
  private async persistedLocation(runs: Run[]): Promise<LocationContext | undefined> {
    const seqByRun = this.history.maxSeqByRun();
    let best: { seq: number; location: { lat: number; lng: number } } | undefined;
    for (const run of runs) {
      const location = requestInputLocation(run);
      if (location === undefined) continue;
      const seq = seqByRun.get(run.runId);
      if (seq === undefined) continue;
      if (best === undefined || seq > best.seq) best = { seq, location };
    }
    if (best === undefined) return undefined;
    const { lat, lng } = best.location;
    return { lat, lng, anchor: await this.anchorFor(lat, lng) };
  }

  /** 锚点解析的降级封装：未配置 resolver 或解析抛错一律返回 undefined。 */
  private async anchorFor(lat: number, lng: number): Promise<string | undefined> {
    if (!this.resolveLocationAnchor) return undefined;
    try {
      return await this.resolveLocationAnchor(lat, lng);
    } catch {
      return undefined;
    }
  }

  async compact(): Promise<PlannerCompactOutcome> {
    if (this.closed) return { applied: false, error: "会话已关闭" };
    if (this.busy) return { applied: false, error: "上一请求仍在处理中" };
    this.busyFlag = true;
    const controller = new AbortController();
    this.controller = controller;
    this.cancelRequested = false;
    this.cancelReason = undefined;
    const op = this.track(() => this.runCompact(controller.signal));
    try {
      return await op;
    } finally {
      this.untrack(op);
      this.busyFlag = false;
      this.controller = undefined;
    }
  }

  private async runCompact(signal: AbortSignal): Promise<PlannerCompactOutcome> {
    try {
      return await this.guard.run(async () => {
        await this.reload();
        const stopped = abortedTurn(signal);
        if (stopped) return { applied: false, error: stopped.message };
        const run = await this.guard.guarded((w) =>
          this.repo.createRun(w, this.userId, {
            sessionId: this.sessionIdValue,
            input: { kind: "manual_compact" },
            startImmediately: true,
          }),
        );
        this.activeRunId = run.runId;
        let applied = false;
        try {
          const result = await compact({
            agent: this.agent,
            model: this.agent.state.model,
            messages: this.agent.state.messages,
            raw: this.history.raw,
            checkpoint: this.checkpoint,
            baseline: this.baseline,
            options: this.compaction,
            manual: true,
            signal,
          });
          if (result) {
            this.checkpoint = await this.persistCheckpoint(result, {
              context: { messages: this.agent.state.messages },
              model: this.agent.state.model,
              thinkingLevel: this.agent.state.thinkingLevel,
            });
            this.baseline.clear();
            this.applyContext();
            applied = true;
          }
          const warning = await settleRun(
            this.repo,
            this.guard.current,
            this.userId,
            this.activeRunId,
            // 检查点已落库即完成：迟到 cancel/close 不得抹成 cancelled。
            applied ? "completed" : this.cancelRequested ? "cancelled" : "completed",
            { applied },
            this.cancelReason,
          );
          return warning ? { applied, error: warning } : { applied };
        } catch (error) {
          const warning = await settleRun(
            this.repo,
            this.guard.current,
            this.userId,
            this.activeRunId,
            applied ? "completed" : this.cancelRequested ? "cancelled" : "failed",
            undefined,
            errorText(error),
          );
          return {
            applied: false,
            error: errorText(error) + (warning ? `（${warning}）` : ""),
          };
        } finally {
          this.activeRunId = undefined;
        }
      });
    } catch (error) {
      return { applied: false, error: errorText(error) };
    }
  }

  /**
   * 校验通过的回复 → 标注 plan + 推进指针（单事务）；成功才由调用方更新内存。
   * child 会话的合法输出只是会话内候选：不标 plan、不动指针、不影响 main。
   */
  async commitValidatedPlan(commit: ValidatedPlanCommit): Promise<void> {
    if (this.sessionKind !== "main") return;
    const meta = this.history.metaOf(commit.message);
    if (!meta) {
      throw new Error("校验通过的 assistant 回复没有对应的持久化记录");
    }
    const plan: ValidatedPlan = { constraints: commit.constraints, itinerary: commit.itinerary };
    await this.guard.guarded((w) =>
      this.repo.commitValidatedPlan(w, this.userId, this.sessionIdValue, meta.recordId, plan),
    );
    // 提交线性化点：repo 返回时 plan 标注与指针已同一事务落库；
    // 之后到达的 cancel/close 不能再把本轮结果抹成 cancelled。
    this.turnCommitted = true;
    this.persistedPlan = plan;
    // 刷新 system section：下一轮请求即带最新已确认行程。
    this.applyContext();
  }

  cancel(): void {
    if (this.closed) return;
    this.cancelRequested = true;
    this.cancelReason = "请求被取消";
    // reason 透传：performTurn 在验证/提交前的异步边界用它生成取消 turn。
    this.controller?.abort(this.cancelReason);
    this.agent.abort();
  }

  /**
   * 关闭：立即拒新工作并中止在途；等整轮（含验证/纠正/run 收尾）完成
   * 才退订钩子、停心跳、释放租约。并发 close 共享同一个收尾 Promise——
   * 故意不用 async 方法，保证返回值就是同一个 Promise 实例。
   * 在途操作的异步链（Agent 事件回调、验证读取等）内调用 close 会被
   * 明确拒绝：等自己收尾会死锁，跳过等待会提前释放租约。要中止当前
   * 轮次请用 cancel()；close 由该操作之外的调用方执行。
   */
  close(): Promise<void> {
    if (this.opToken !== undefined && this.opScope.getStore() === this.opToken) {
      return Promise.reject(
        new Error(
          "不能在会话操作的异步链内调用 close()：请用 cancel() 中止当前轮，再由操作外调用方 close()",
        ),
      );
    }
    if (!this.closing) {
      this.closed = true;
      this.cancelRequested = true;
      this.cancelReason = "会话关闭";
      this.controller?.abort(this.cancelReason);
      this.agent.abort();
      this.closing = this.finishClose();
    }
    return this.closing;
  }

  private async finishClose(): Promise<void> {
    try {
      // 只服务外部 close（op 链内的 close 已在入口处被拒绝）：等在途整轮
      // 与 Agent 事件回调全部收尾后，再退订、停心跳、放租约。
      await this.inFlight?.catch(() => {});
      await this.agent.waitForIdle().catch(() => {});
    } finally {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.agent.prepareRequest = this.prevPrepareRequest;
      this.prevPrepareRequest = undefined;
      // 收尾机会蒸馏：仅 main 会话、租约闩锁未置位时触发（闩锁 = 写路径已
      // 坏，蒸馏写库同样不会成功）。走 agent.streamFunction 旁路一次性请求，
      // 不依赖已退订的事件钩子；超时兜底不让蒸馏无限挂起。整个调用吞掉所
      // 有异常——蒸馏是机会行为，绝不破坏 close 路径。返回的 outcome 无
      // 需处理：updated/unchanged 已写库推游标，skipped 未达门槛，error
      // 留给下次触发重试。detachDistill 时进每用户串行尾随队列后台执行——
      // 本调用位于 web send 的响应路径上（service.ts 的 send finally 里
      // await planner.close()），阈值命中不再推迟响应；在途期间同会话/同
      // 用户的后续 close 排队等它完成后顺次补蒸，末轮不丢。
      if (this.sessionKind === "main" && this.sessionIdValue !== "" && !this.guard.failure) {
        const sessionId = this.sessionIdValue;
        const distill = async () => {
          await distillMemory({
            agent: this.agent,
            sessions: this.repo,
            userId: this.userId,
            sessionId,
            minNewUserMessages: this.memoryMinUserMessages,
            maxInputChars: this.memoryInputChars,
            signal: AbortSignal.timeout(this.memoryDistillTimeoutMs),
          }).catch(() => {
            // 机会行为：任何蒸馏失败都不影响会话关闭。
          });
        };
        if (this.detachDistill) {
          enqueueDistill(this.userId, sessionId, distill);
        } else {
          await distill();
        }
      }
      await this.guard.release();
    }
  }

  /** 登记在途整轮；AsyncLocalStorage 标记 op 异步链，close 据此拒绝链内调用。 */
  private track<T>(operation: () => Promise<T>): Promise<T> {
    const token = Symbol("op");
    const op = this.opScope.run(token, operation);
    this.inFlight = op;
    this.opToken = token;
    return op;
  }

  private untrack(op: Promise<unknown>): void {
    if (this.inFlight === op) {
      this.inFlight = undefined;
      this.opToken = undefined;
    }
  }

  private withWarning(turn: PlannerTurn, warning: string): PlannerTurn {
    return turn.kind === "error"
      ? { kind: "error", message: `${turn.message}（${warning}）` }
      : { ...turn, warning };
  }
}

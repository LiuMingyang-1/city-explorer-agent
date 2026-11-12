import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { resolveCompactionOptions } from "../compaction/options.ts";
import type { CompactionOptions } from "../compaction/compact.ts";
import type { EventRepository } from "../data/repository.ts";
import type { Event } from "../data/types.ts";
import { mergeConstraints } from "../itinerary/constraints.ts";
import type { Itinerary, PlanningConstraints } from "../itinerary/types.ts";
import { validateItinerary } from "../itinerary/validation.ts";
import type { ValidationIssue, ValidationResult } from "../itinerary/validation.ts";
import type { SessionRepository } from "../session/repository.ts";
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  createDelegateTaskTool,
  getDefaultSubagentSemaphore,
} from "./delegate.ts";
import type { SubagentSemaphore } from "./delegate.ts";
import { createExplorerAgent } from "./explorer-agent.ts";
import type { ExplorerAgentOptions } from "./explorer-agent.ts";
import { PersistentRuntime } from "./persistent/runtime.ts";
import type { ActiveDispatchTurn } from "./persistent/runtime.ts";
export type { ActiveDispatchTurn };
import {
  extractEventIds,
  lastAssistantText,
  parsePlannerResponse,
  PlannerResponseError,
} from "./response.ts";

/** 一轮规划的结果：新行程 / 追问 / 失败（当前行程不变）。 */
export type PlannerTurn =
  | { kind: "itinerary"; itinerary: Itinerary; constraints: PlanningConstraints; warning?: string }
  | { kind: "clarification"; question: string; warning?: string }
  | { kind: "error"; message: string; code?: string };

/** PlannerTurn 的失败分支；abortedTurn 与错误路径返回。 */
export type PlannerErrorTurn = Extract<PlannerTurn, { kind: "error" }>;

/**
 * 取消/关闭信号下统一的 error turn：abort(reason) 的字符串原因透传给
 * 调用方（cancel → "请求被取消"，close → "会话关闭"），其余用通用文案。
 * 每个 async 边界后、每次纠正/提交前都应检查。
 */
export function abortedTurn(signal: AbortSignal): PlannerErrorTurn | undefined {
  if (!signal.aborted) return undefined;
  const reason: unknown = signal.reason;
  return {
    kind: "error",
    message: typeof reason === "string" && reason ? reason : "请求已取消",
  };
}

/** prompt() 的可选参数；requestId 只在持久模式下有意义（请求级幂等键）。 */
export interface PlannerPromptOptions {
  /**
   * 请求级幂等键（持久模式）：同 user/session 下同键重放不再生成一轮新消息，
   * 直接返回既有 run 记录的结果。CLI 不重试，不传。
   */
  requestId?: string;
  /**
   * 本轮用户位置（web 端经 service 透传）：持久运行时注入
   * location_context system section（不进用户消息/raw/消息表），
   * 坐标随本条 run 的 input 快照落库；本轮没带时沿用会话最近位置
   * （每次 reload 从最新 location run 恢复，跨实例/重启一致）。
   * 内存路径（performTurn）不处理。
   */
  location?: { lat: number; lng: number };
}

/** 手动压缩的结果：applied=写入了新检查点并切换上下文。 */
export interface PlannerCompactOutcome {
  applied: boolean;
  error?: string;
}

/**
 * 持久化运行时接缝（由 PersistentRuntime 实现）：接管 prompt 的租约/互斥、
 * run 生命周期与上下文恢复；PlannerSession 只保留纠正循环本身。
 */
export interface PlannerRuntime {
  prompt(text: string, options?: PlannerPromptOptions): Promise<PlannerTurn>;
  compact(): Promise<PlannerCompactOutcome>;
  cancel(): void;
  close(): Promise<void>;
  readonly busy: boolean;
  readonly sessionId: string;
}

/** 一次工具执行记录；真实工具链经 Agent 事件流记下，可供 CLI/测试检查。 */
export interface ToolCallRecord {
  toolName: string;
  args: unknown;
  isError: boolean;
  durationMs?: number;
}

/** 校验通过、即将成为当前行程的载荷（message 是产生它的原始 assistant 消息）。 */
export interface ValidatedPlanCommit {
  message: AgentMessage;
  constraints: PlanningConstraints;
  itinerary: Itinerary;
}

export interface PlannerSessionOptions {
  agent: Agent;
  repository: EventRepository;
  /** 校验函数，缺省为 src/itinerary/validation.ts 的 validateItinerary（测试可注入）。 */
  validate?: (
    candidate: unknown,
    constraints: PlanningConstraints,
    events: Map<string, Event>,
  ) => ValidationResult;
  /** 校验/格式失败后的纠正轮上限；默认 2，防无界重试。 */
  maxCorrections?: number;
  /**
   * 校验通过后的落库钩子（持久模式）：先写库成功才更新内存中的当前行程；
   * 抛错 → 本轮按落库失败结束（error turn），不当模型格式错误继续纠正。
   */
  onValidatedPlan?: (commit: ValidatedPlanCommit) => Promise<void>;
}

function issuesText(issues: ValidationIssue[]): string {
  return issues.map((i) => `- [${i.code}] ${i.event_id ? `${i.event_id}: ` : ""}${i.message}`).join("\n");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 规划会话：包着 Pi Agent，代 CLI 做"自然语言进 → 行程 JSON 出"。
 * 无 runtime 时是纯内存会话（退出即结束）；挂上 PersistentRuntime 后
 * 每轮在会话租约内执行、消息落 SQLite、校验通过的行程提交指针。
 * 每轮：prompt → 解析 envelope → clarify 直接回传追问；
 * itinerary 则把模型上报的约束补丁合并到已确认约束（缺省字段沿用、
 * null 显式清除、显式值覆盖），取活动详情、跑 validateItinerary，
 * **只通过才更新当前行程与已确认约束**。
 * 失败时把原需求、生效约束和问题回喂给模型纠正，最多 maxCorrections 轮。
 */
export class PlannerSession {
  /** 已发生的工具调用链（含参数与成败），按时间顺序。 */
  readonly toolCalls: ToolCallRecord[] = [];
  /** @internal 由 createPersistentPlanner 注入；存在时 prompt/compact 走持久路径。 */
  runtime?: PlannerRuntime;
  private readonly options: PlannerSessionOptions;
  private current?: Itinerary;
  private confirmed?: PlanningConstraints;
  private readonly validate: NonNullable<PlannerSessionOptions["validate"]>;
  private readonly maxCorrections: number;
  private readonly unsubscribeTrace: () => void;

  constructor(options: PlannerSessionOptions) {
    this.options = options;
    this.validate = options.validate ?? validateItinerary;
    this.maxCorrections = options.maxCorrections ?? 2;
    const pending = new Map<string, { toolName: string; args: unknown }>();
    this.unsubscribeTrace = options.agent.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        pending.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      } else if (event.type === "tool_execution_end") {
        const start = pending.get(event.toolCallId);
        pending.delete(event.toolCallId);
        this.toolCalls.push({
          toolName: event.toolName,
          args: start?.args,
          isError: event.isError,
          durationMs: event.durationMs,
        });
      }
    });
  }

  /** 底层 Pi Agent（调试用；常规代码只走 prompt/compact/cancel/close）。 */
  get agent(): Agent {
    return this.options.agent;
  }

  /** 当前已确认的行程（未通过校验的输出不会污染它）。 */
  get itinerary(): Itinerary | undefined {
    return this.current;
  }

  /** 当前已确认的用户约束（同上，只在校验通过时更新）。 */
  get constraints(): PlanningConstraints | undefined {
    return this.confirmed;
  }

  /** 是否有请求正在处理（持久模式含租约内整个纠正循环）。 */
  get busy(): boolean {
    return this.runtime?.busy ?? this.options.agent.state.isStreaming;
  }

  /** 持久会话 ID；内存会话为 undefined。 */
  get sessionId(): string | undefined {
    return this.runtime?.sessionId;
  }

  /**
   * 由持久运行时恢复已确认规划状态（重启/易主后调用）；undefined 表示无有效指针。
   * @internal
   */
  restorePlan(plan?: { constraints: PlanningConstraints; itinerary: Itinerary }): void {
    this.confirmed = plan?.constraints;
    this.current = plan?.itinerary;
  }

  /** 送一轮自然语言给 Agent，返回 PlannerTurn。 */
  async prompt(text: string, options: PlannerPromptOptions = {}): Promise<PlannerTurn> {
    if (this.runtime) return this.runtime.prompt(text, options);
    return this.performTurn(text);
  }

  /** 手动压缩会话上下文（仅持久模式；内存模式明确报错）。 */
  async compact(): Promise<PlannerCompactOutcome> {
    return this.runtime
      ? this.runtime.compact()
      : { applied: false, error: "当前会话无持久化，不支持手动压缩" };
  }

  /** 取消进行中的请求（模型请求/摘要/退避/工具一并中止）；空闲时无副作用。 */
  cancel(): void {
    if (this.runtime) this.runtime.cancel();
    else this.options.agent.abort();
  }

  /**
   * 释放运行时资源：退订事件、停心跳、释放租约、等运行收尾；可重复调用。
   * 故意不用 async：收尾就是 runtime 的收尾 Promise（并发 close 共享
   * 同一实例），退订挂在确认关闭之后；无 runtime 的内存会话返回已解决
   * Promise，同样可 await。
   * 判拒先于退订：op 链内调用被 runtime 明确 reject 时保持 trace 订阅，
   * 否则后续 tool_execution_end 会静默漏记。
   */
  close(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) {
      this.unsubscribeTrace();
      return Promise.resolve();
    }
    return runtime.close().then(() => this.unsubscribeTrace());
  }

  /**
   * 一轮完整纠正循环（不含持久化包装）。持久模式下由 PersistentRuntime 在
   * 租约内调用并传入本轮取消信号；直接调用绕过租约与消息落库，仅供
   * 内存模式/测试。
   * @internal
   */
  async performTurn(
    text: string,
    control?: { signal?: AbortSignal },
  ): Promise<PlannerTurn> {
    const signal = control?.signal;
    let outgoing = text;
    let lastError = "没有得到可用回复";
    for (let attempt = 0; attempt <= this.maxCorrections; attempt++) {
      // 取消/关闭横跨验证与提交：每轮纠正前先确认没有被叫停。
      const stopped = signal ? abortedTurn(signal) : undefined;
      if (stopped) return stopped;
      const reply = await this.ask(outgoing);
      if (reply.error !== undefined || reply.text === undefined) {
        return { kind: "error", message: reply.error ?? "模型没有给出回复" };
      }
      try {
        const parsed = parsePlannerResponse(reply.text);
        if (parsed.type === "clarify") {
          return { kind: "clarification", question: parsed.question };
        }
        // 补丁合并到已确认约束：纠正回复漏带字段不会放宽已确认的限制。
        const effective = mergeConstraints(this.confirmed, parsed.constraints);
        const events = await this.options.repository.getByIds(extractEventIds(parsed.candidate));
        // 验证的异步边界之后重新确认取消：中止的轮次不再校验、提交或纠正。
        const cancelled = signal ? abortedTurn(signal) : undefined;
        if (cancelled) return cancelled;
        const result = this.validate(parsed.candidate, effective, events);
        if (result.ok && result.itinerary) {
          // 提交是最后一个可拦截点：validate 与 commit 之间仍可能被取消。
          const blocked = signal ? abortedTurn(signal) : undefined;
          if (blocked) return blocked;
          if (this.options.onValidatedPlan) {
            try {
              await this.options.onValidatedPlan({
                message: reply.message as AgentMessage,
                constraints: effective,
                itinerary: result.itinerary,
              });
            } catch (error) {
              // 数据库失败不是模型格式错误：结束本轮，旧行程保留。
              return {
                kind: "error",
                message: `行程校验通过但写入会话库失败：${errorText(error)}`,
              };
            }
          }
          this.current = result.itinerary;
          this.confirmed = effective;
          return { kind: "itinerary", itinerary: result.itinerary, constraints: effective };
        }
        lastError = `行程未通过校验：${result.issues.map((i) => i.message).join("；") || "未知问题"}`;
        outgoing =
          `用户的原始要求："${text}"\n` +
          "上一版行程未通过校验：\n" +
          issuesText(result.issues) +
          `\n当前生效约束：${JSON.stringify(effective)}\n` +
          "请按原始要求和生效约束修正，重新输出完整的 itinerary JSON（保留 type/constraints/itinerary 结构，constraints 填当前生效约束）。";
      } catch (error) {
        lastError =
          error instanceof PlannerResponseError
            ? `回复格式不符：${error.message}`
            : `处理回复时出错：${errorText(error)}`;
        outgoing =
          `用户的原始要求："${text}"\n` +
          `你的回复不符合输出契约（${lastError}）。请重新只输出一个约定的 JSON 对象。`;
      }
    }
    return { kind: "error", message: lastError };
  }

  /** 单轮请求：prompt() 不 reject 模型错误，改查 state/末条消息。 */
  private async ask(
    text: string,
  ): Promise<{ text?: string; error?: string; message?: AgentMessage }> {
    const { agent } = this.options;
    if (agent.state.isStreaming) {
      return { error: "Agent 正在处理上一轮；等它结束或用 steer()/followUp()。" };
    }
    try {
      await agent.prompt(text);
    } catch (error) {
      return { error: `prompt 失败：${errorText(error)}` };
    }
    const messages = agent.state.messages;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") {
      return { error: agent.state.errorMessage ?? "模型没有给出回复" };
    }
    if (last.stopReason === "error" || last.stopReason === "aborted") {
      return { error: last.errorMessage ?? agent.state.errorMessage ?? "模型请求失败" };
    }
    const reply = lastAssistantText(messages);
    if (reply === undefined) return { error: "模型回复为空" };
    return { text: reply, message: last };
  }
}

/**
 * 一步到位：建 Agent + PlannerSession。CLI 只需拿这个对象循环 prompt()。
 * repository 由调用方创建并负责 close()。
 */
export async function createPlanner(
  options: ExplorerAgentOptions & Omit<PlannerSessionOptions, "agent" | "repository">,
): Promise<PlannerSession> {
  const agent = await createExplorerAgent(options);
  return new PlannerSession({
    agent,
    repository: options.repository,
    validate: options.validate,
    maxCorrections: options.maxCorrections,
  });
}

export interface PersistentPlannerOptions extends ExplorerAgentOptions {
  /** 会话持久仓库（调用方创建并负责 close()；":memory:" 供测试）。 */
  sessions: SessionRepository;
  /** 认证后的用户标识：存储层只校验归属，不识别身份。CLI 取 EXPLORER_USER_ID。 */
  userId: string;
  /** 缺省新建一条 kind='main' 对话会话；显式给定时必须属于该用户且 active（main/child 均可）。 */
  sessionId?: string;
  /** 新建对话时的会话标题（仅未传 sessionId 时生效；Web 取首条消息前 30 码点）。 */
  title?: string;
  /** 编排入参：本 planner 所建 run 的父 run（delegate_task 派生子任务时透传）。 */
  parentRunId?: string;
  /** 编排入参：结果回投目标会话（随 run 记录落库，本期同步派发仅存档）。 */
  replyToSessionId?: string;
  /** 编排递归深度：对话 = 0、child 任务 = 1；缺省 0。 */
  depth?: number;
  /**
   * 子任务并发信号量：缺省按 config.subagentMaxConcurrent 取进程级共享池
   * （同容量同池）；离线测试可注入独立池精确观测排队。
   */
  subagentSemaphore?: SubagentSemaphore;
  /** 单次子任务超时（毫秒）；缺省 config.subagentTimeoutMs（再缺省 120s）。 */
  subagentTimeoutMs?: number;
  /** 递归深度上限：缺省 1（子任务不再挂 delegate_task，根除嵌套等锁死锁）。 */
  maxSubagentDepth?: number;
  /** 写者标识（租约 owner）；缺省生成进程相关实例名。 */
  leaseOwner?: string;
  /** 会话写租约 TTL（毫秒）；默认 30s，忙时按 TTL/3 心跳续期。 */
  leaseTtlMs?: number;
  /** 心跳间隔（毫秒）；缺省 leaseTtlMs/3，测试可调小观察续租。 */
  leaseRenewMs?: number;
  /** 压缩参数；缺省 resolveCompactionOptions(config)。 */
  compaction?: CompactionOptions;
  /** 同 PlannerSessionOptions。 */
  validate?: PlannerSessionOptions["validate"];
  maxCorrections?: number;
  /**
   * 位置锚点解析（测试可注入）：把本轮透传的经纬度翻成锚点文案。
   * 缺省实现查活动库最近场馆，30km 内才提供锚点。
   */
  locationAnchor?: (lat: number, lng: number) => Promise<string | undefined>;
  /**
   * close 机会蒸馏后台执行（不阻塞 close/响应路径）；缺省 false（同步，
   * 进程即将退出的调用方如 CLI 应同步蒸完）。web 服务传 true。
   */
  detachDistill?: boolean;
}

/**
 * 缺省位置锚点：查活动库中距该坐标最近的场馆，30km 内返回
 * "距「场馆」约 N 公里"；更远/无结果/查询失败 → undefined
 * （section 只留坐标，锚点失败不影响本轮）。
 */
async function defaultLocationAnchor(
  repository: EventRepository,
  lat: number,
  lng: number,
): Promise<string | undefined> {
  try {
    const nearest = (await repository.search({ near: { lat, lng } })).find(
      (e) => typeof e.distanceKm === "number",
    );
    return nearest && (nearest.distanceKm as number) <= 30
      ? `距「${nearest.venueName}」约 ${nearest.distanceKm} 公里`
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 建持久化 PlannerSession：createUser 幂等 → 校验会话归属 → 租约内恢复
 * 上下文（含中断补全与死 run 标记）→ 挂 message_end 落库与
 * prepareRequest 压缩钩子。关闭用 planner.close()；sessions/活动库
 * 两个连接仍由调用方关闭。
 */
export async function createPersistentPlanner(
  options: PersistentPlannerOptions,
): Promise<PlannerSession> {
  const compaction = options.compaction ?? resolveCompactionOptions(options.config);
  // 编排闭环：对话（depth 0）且未显式关 delegate 时挂载 delegate_task；
  // child（depth>=maxDepth）既无该工具也无系统提示派发节，结构防嵌套死锁。
  const depth = options.depth ?? 0;
  const maxDepth = options.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
  const canDelegate = options.canDelegate ?? depth < maxDepth;
  const semaphore =
    options.subagentSemaphore ??
    getDefaultSubagentSemaphore(options.config.subagentMaxConcurrent);
  const timeoutMs = options.subagentTimeoutMs ?? options.config.subagentTimeoutMs;
  // 派发上下文槽：runPrompt 建 run 后置位、收尾清空；槽空时工具直接 isError。
  let activeTurn: ActiveDispatchTurn | undefined;
  const delegateTool = canDelegate
    ? createDelegateTaskTool({
        getContext: () => activeTurn,
        repository: options.repository,
        sessions: options.sessions,
        semaphore,
        maxDepth,
        timeoutMs,
        spawnChild: (childInput) =>
          // extraTools 只透传调用方原值：绝不把父实例的 delegateTool 带进
          // depth=1 的 child；leaseOwner 置空让 child 生成独立写者标识；
          // detachDistill=false（child close 本就不蒸，语义对齐）。
          createPersistentPlanner({
            ...options,
            userId: childInput.userId,
            sessionId: childInput.sessionId,
            title: undefined,
            parentRunId: childInput.parentRunId,
            replyToSessionId: childInput.replyToSessionId,
            depth: childInput.depth,
            maxSubagentDepth: maxDepth,
            subagentSemaphore: semaphore,
            subagentTimeoutMs: timeoutMs,
            leaseOwner: undefined,
            detachDistill: false,
            extraTools: options.extraTools,
            canDelegate: childInput.depth < maxDepth,
          }),
      })
    : undefined;
  const agent = await createExplorerAgent({
    ...options,
    canDelegate,
    extraTools: [...(options.extraTools ?? []), ...(delegateTool ? [delegateTool] : [])],
  });
  let runtime!: PersistentRuntime;
  const session = new PlannerSession({
    agent,
    repository: options.repository,
    validate: options.validate,
    maxCorrections: options.maxCorrections,
    onValidatedPlan: (commit) => runtime.commitValidatedPlan(commit),
  });
  runtime = new PersistentRuntime({
    agent,
    planner: session,
    sessions: options.sessions,
    userId: options.userId,
    sessionId: options.sessionId,
    title: options.title,
    parentRunId: options.parentRunId,
    replyToSessionId: options.replyToSessionId,
    depth: options.depth,
    leaseOwner: options.leaseOwner,
    leaseTtlMs: options.leaseTtlMs,
    leaseRenewMs: options.leaseRenewMs,
    compaction,
    resolveLocationAnchor:
      options.locationAnchor ??
      ((lat, lng) => defaultLocationAnchor(options.repository, lat, lng)),
    memoryInputChars: options.config.memoryInputChars,
    memoryMinUserMessages: options.config.memoryMinUserMessages,
    memoryDistillTimeoutMs: options.config.memoryDistillTimeoutMs,
    detachDistill: options.detachDistill,
    onActiveTurnChange: (turn) => {
      activeTurn = turn;
    },
  });
  session.runtime = runtime;
  await runtime.open();
  return session;
}

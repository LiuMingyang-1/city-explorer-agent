import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { EventRepository } from "../data/repository.ts";
import type { Itinerary, PlanningConstraints } from "../itinerary/types.ts";
import type { SessionRepository } from "../session/repository.ts";
import type { LeaseWriter, RunStatus, Session } from "../session/types.ts";
import { isSessionError } from "../session/types.ts";
import { safeEmit, stampSubagent, subagentDoneEvent, subagentSpawnedEvent } from "./progress.ts";
import type { ProgressSink } from "./progress.ts";
import type { PlannerTurn } from "./session.ts";

/** 工具名：父 Agent 经它把自包含的子任务派给同进程的子 PlannerSession。 */
export const DELEGATE_TASK_TOOL = "delegate_task";
/** 递归深度硬上限：对话=0 → 子任务=1，子任务不再挂 delegate_task（防嵌套等锁死锁）。 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 1;
/** 进程级子任务并发上限缺省值。 */
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
/** 单次子任务超时缺省值（自进入 execute 起算，含信号量排队）。 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 120_000;

interface SemaphoreWaiter {
  signal?: AbortSignal;
  onAbort: () => void;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
}

/**
 * 进程级子任务并发信号量：计数槽位 + FIFO 等待队列。
 * 同轮并行派发与多请求并发共享同一池；等待期间 signal abort 立即出队、
 * 不占槽位。释放出的槽位按入队顺序唤醒，跳过已被 abort 的请求。
 */
export class SubagentSemaphore {
  private readonly maxConcurrent: number;
  private inUse = 0;
  private readonly queue: SemaphoreWaiter[] = [];

  constructor(maxConcurrent = DEFAULT_SUBAGENT_MAX_CONCURRENT) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new Error("SubagentSemaphore maxConcurrent 必须是正整数");
    }
    this.maxConcurrent = maxConcurrent;
  }

  /** 已占用槽位数（诊断/测试用）。 */
  get running(): number {
    return this.inUse;
  }

  /** 队列中等待的请求数（诊断/测试用）。 */
  get waiting(): number {
    return this.queue.length;
  }

  /**
   * 占一个槽位；有空闲且 signal 未 abort 时立即返回幂等的 release()。
   * 满载时进 FIFO 队尾等待；入队前或排队期间 signal abort → 立即出队
   * 并以 signal.reason reject，不消耗槽位。
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.inUse < this.maxConcurrent) {
      this.inUse += 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return; // 已出队（被唤醒中）：不再拦截
          this.queue.splice(index, 1);
          signal?.removeEventListener("abort", waiter.onAbort);
          reject(signal?.reason);
        },
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  /** 幂等释放：重复调用只生效一次；释放后按 FIFO 唤醒队首。 */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse -= 1;
      this.wake();
    };
  }

  private wake(): void {
    while (this.inUse < this.maxConcurrent && this.queue.length > 0) {
      const waiter = this.queue[0];
      if (waiter.signal?.aborted) {
        // abort 与唤醒紧邻的兜底：正常由 onAbort 出队，这里再挡一次。
        this.queue.shift();
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(waiter.signal.reason);
        continue;
      }
      this.queue.shift();
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      this.inUse += 1;
      waiter.resolve(this.makeRelease());
    }
  }
}

const defaultSemaphores = new Map<number, SubagentSemaphore>();

/**
 * 进程级默认信号量按容量分池：未显式注入信号量的调用方按
 * maxConcurrent 共享池——同容量配置共用同一进程池，不同容量各自
 * 准确定容（同进程内多种 subagentMaxConcurrent 不再被首存单例覆盖）。
 */
export function getDefaultSubagentSemaphore(maxConcurrent?: number): SubagentSemaphore {
  const limit = maxConcurrent ?? DEFAULT_SUBAGENT_MAX_CONCURRENT;
  let semaphore = defaultSemaphores.get(limit);
  if (semaphore === undefined) {
    semaphore = new SubagentSemaphore(limit);
    defaultSemaphores.set(limit, semaphore);
  }
  return semaphore;
}

/**
 * 派发上下文：由持久运行时在父租约窗口内填入，轮次结束后清空。
 * 字段与 PersistentRuntime 的 ActiveDispatchTurn 一一对应。
 */
export interface DelegateTurnContext {
  userId: string;
  /** 父会话（派发方）ID；子会话的 parent_session_id 与 run 的 reply_to_session_id。 */
  sessionId: string;
  /** 父会话当前 run ID；子 run 的 parent_run_id。 */
  runId: string;
  /** 父会话写租约：createChildSession 直传（不经 guarded，普通校验错误不闩父）。 */
  writer: LeaseWriter;
  /** 父会话当前生效位置；透传给 child.prompt（child 自身无历史可恢复）。 */
  location?: { lat: number; lng: number };
  /** 派发深度：对话=0，子任务=1。 */
  depth: number;
  /** 父租约失效（createChildSession 抛 lease_lost/archived）时中止父轮的回调。 */
  failParentLease: (error: unknown) => void;
  /**
   * 父轮过程事件 sink（本轮 PlannerPromptOptions.onProgress 原样透传）：
   * 派发点发 subagent_spawned、终了点发 subagent_done；child.prompt 的
   * onProgress 经 stampSubagent 盖章后也落此 sink——子任务过程与父轮
   * 阶段事件共用同一 SSE progress 通道。未挂接时省略，事件自然静默。
   */
  onProgress?: ProgressSink;
  /**
   * 本次工具调用 ID → 父轮方案标号（"A"/"B"…）：与 exploring_plans 的
   * plan_ids 同源；供 subagent_* 事件回填 plan_id，未知调用 → undefined。
   */
  planIdForToolCall?: (toolCallId: string) => string | undefined;
}

/**
 * 子 Planner 接缝：spawnChild 的实现方打开并返回一个已就绪的持久
 * PlannerSession（或测试桩），归它 close() 释放子租约与心跳。
 */
export interface ChildPlannerHandle {
  readonly sessionId?: string;
  prompt(
    text: string,
    options?: {
      location?: { lat: number; lng: number };
      /** 子会话过程事件回调：编排层盖章（subagent_id）后透传父 sink。 */
      onProgress?: ProgressSink;
    },
  ): Promise<PlannerTurn>;
  cancel(): void;
  close(): Promise<void>;
}

export type SpawnChildPlanner = (input: {
  userId: string;
  /** 已由编排层建好的 child 会话 ID。 */
  sessionId: string;
  /** 父会话当前 run ID，写进子 run 的 parent_run_id。 */
  parentRunId: string;
  /** 父会话 ID，写进子 run 的 reply_to_session_id。 */
  replyToSessionId: string;
  /** 父深度 + 1；子 Agent 据此不再挂载 delegate_task。 */
  depth: number;
}) => Promise<ChildPlannerHandle>;

/** 回传父模型的活动精简元信息：够核对时间窗与预算，不带全文与素材字段。 */
export interface DelegatedEventMeta {
  id: string;
  title: string;
  category: string;
  venueName: string;
  startAt: string | null;
  endAt: string | null;
  suggestedDurationMinutes: number | null;
  budgetMin: number | null;
  budgetMax: number | null;
  currency: string;
  budgetNote: string | null;
}

/** 工具结果载荷（content 为它的 JSON 序列化，details 同源）。 */
export interface DelegateTaskDetails {
  status: "completed" | "failed" | "cancelled";
  kind?: "itinerary" | "clarification";
  sessionId: string | null;
  runId: string | null;
  question?: string;
  constraints?: PlanningConstraints;
  itinerary?: Itinerary;
  events?: DelegatedEventMeta[];
  error?: string;
}

export interface DelegateTaskToolOptions {
  /** 取当前轮派发上下文；返回 undefined 说明不在持久运行窗口内。 */
  getContext: () => DelegateTurnContext | undefined;
  repository: EventRepository;
  sessions: SessionRepository;
  spawnChild: SpawnChildPlanner;
  /** 缺省取进程级共享信号量。 */
  semaphore?: SubagentSemaphore;
  maxDepth?: number;
  timeoutMs?: number;
}

const delegateTaskParameters = Type.Object({
  task: Type.String({
    description:
      "自包含的子任务说明：写明推断后的具体日期 YYYY-MM-DD、可用时段、探索方向/区域" +
      "及已知预算/偏好约束（子 Agent 看不到本对话历史）。",
  }),
  title: Type.Optional(
    Type.String({
      description: '简短子任务标题（如"周六下午大雁塔看展方案"），落入会话树供排查。',
    }),
  ),
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toResult(details: DelegateTaskDetails): AgentToolResult<DelegateTaskDetails> {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
    structuredContent: details as unknown as JsonValue,
    isError: details.status !== "completed",
  };
}

/**
 * 组装 delegate_task 工具：同步派发——占槽 → 建 child 会话 → 打开子
 * Planner → prompt 阻塞至完成 → 组装结构化结果回父 Agent。
 * 父 signal 与本地子超时联合控制 combined；任一触发级联 child.cancel()。
 * 失败/取消一律返回 isError: true 的结构化结果（含可读原因），
 * 父模型据此降级 search_events 自行兜底。
 */
export function createDelegateTaskTool(
  options: DelegateTaskToolOptions,
): AgentTool<typeof delegateTaskParameters, DelegateTaskDetails> {
  const semaphore = options.semaphore ?? getDefaultSubagentSemaphore();
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;
  const timeoutError = `子任务执行超时（${Math.round(timeoutMs / 1000)}s）`;

  return {
    name: DELEGATE_TASK_TOOL,
    label: "Delegate task",
    description:
      "把一个自包含的子任务派给子 Agent 在独立会话中规划（同一轮可并行派发 2–3 个）。" +
      "仅用于：出行日期已明确，且需要多方向/多片区候选方案并行比选，或上下午跨度大需分头深挖。" +
      "返回 JSON：completed 时含候选 itinerary 与所选 events 元信息；failed/cancelled 时含 error。" +
      "常规单线规划或需先追问的场景请直接用 search_events / clarify，不要派子任务。",
    parameters: delegateTaskParameters,
    execute: async (toolCallId, params, parentSignal) => {
      const task = typeof params.task === "string" ? params.task.trim() : "";
      if (!task) {
        return toResult({
          status: "failed",
          sessionId: null,
          runId: null,
          error: "task 不能为空：请给出自包含的子任务说明",
        });
      }
      const ctx = options.getContext();
      if (!ctx) {
        return toResult({
          status: "failed",
          sessionId: null,
          runId: null,
          error: "当前不在可派发的持久运行上下文中",
        });
      }
      if (ctx.depth >= maxDepth) {
        return toResult({
          status: "failed",
          sessionId: null,
          runId: null,
          error: `已达子任务递归深度上限（depth=${ctx.depth}）`,
        });
      }

      // 联合取消：父 signal（用户取消/断连）与本地超时共用 combined 出口；
      // 两个标记位区分原因文案，外层 finally 务必解绑监听与定时器。
      let timedOut = false;
      let parentAborted = false;
      const combined = new AbortController();
      const cancelError = () => (timedOut ? timeoutError : "父请求已取消");
      const onParentAbort = () => {
        parentAborted = true;
        combined.abort();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        combined.abort();
      }, timeoutMs);
      if (parentSignal) {
        if (parentSignal.aborted) {
          onParentAbort();
        } else {
          parentSignal.addEventListener("abort", onParentAbort, { once: true });
        }
      }
      try {
        let release: () => void;
        try {
          release = await semaphore.acquire(combined.signal);
        } catch {
          return toResult({
            status: "cancelled",
            sessionId: null,
            runId: null,
            error: cancelError(),
          });
        }
        try {
          let childSession: Session;
          try {
            childSession = await options.sessions.createChildSession(ctx.writer, ctx.userId, {
              parentSessionId: ctx.sessionId,
              title: params.title?.trim() || undefined,
            });
          } catch (error) {
            if (isSessionError(error, "lease_lost") || isSessionError(error, "archived")) {
              // 父会话写租约已失效：立即中止父轮，避免模型继续空跑浪费 token。
              ctx.failParentLease(error);
              throw error;
            }
            return toResult({
              status: "failed",
              sessionId: null,
              runId: null,
              error: `创建子任务会话失败：${errorText(error)}`,
            });
          }
          // 分身入场即发 spawned（协调文档 §7.1）；plan_id 与父轮
          // exploring_plans 同源（planIdForToolCall 按 toolCallId 反查）。
          const planId = ctx.planIdForToolCall?.(toolCallId) ?? null;
          const spawned = subagentSpawnedEvent({
            subagentId: childSession.sessionId,
            planId,
            parentRunId: ctx.runId,
            title: params.title,
            task,
          });
          safeEmit(ctx.onProgress, spawned);
          // 派发终了即发 done（§7.3）：status/kind/summary/stops_count 与
          // 回传父模型的 details 同源，child_run_* 抄录 DB 持久化终态
          // （running 不伪装成终态）。每次 spawn 至多且最终恰一个 done：
          // 正常路径都经 finish，异常分支由下方 catch 幂等补发。
          let doneEmitted = false;
          const emitDone = (
            details: DelegateTaskDetails,
            childRunStatus?: RunStatus | null,
          ): void => {
            doneEmitted = true;
            safeEmit(
              ctx.onProgress,
              subagentDoneEvent({
                subagentId: childSession.sessionId,
                planId,
                // 契约必填 title：与 spawned.title 同源（入参 title 缺省取
                // task 裁剪 ≤40 码点），前端按它把 done 归属到分身。
                title: spawned.title,
                status: details.status,
                ...(details.kind !== undefined ? { kind: details.kind } : {}),
                stopsCount:
                  details.status === "completed" && details.kind === "itinerary"
                    ? (details.itinerary?.stops.length ?? null)
                    : null,
                summary:
                  details.status === "completed"
                    ? details.kind === "clarification"
                      ? (details.question ?? "")
                      : (details.itinerary?.summary ?? "")
                    : (details.error ?? ""),
                childRunId: details.runId,
                childRunStatus: childRunStatus ?? null,
              }),
            );
          };
          const finish = (
            details: DelegateTaskDetails,
            childRunStatus?: RunStatus | null,
          ): AgentToolResult<DelegateTaskDetails> => {
            emitDone(details, childRunStatus);
            return toResult(details);
          };
          let child: ChildPlannerHandle;
          try {
            child = await options.spawnChild({
              userId: ctx.userId,
              sessionId: childSession.sessionId,
              parentRunId: ctx.runId,
              replyToSessionId: ctx.sessionId,
              depth: ctx.depth + 1,
            });
          } catch (error) {
            // 启动失败：实现方可能已建半成品子 run——如实读取其持久化
            // runId/status 填入 details/done，查无才 null，不伪造终态。
            // status 维持既有父模型语义：启动期 combined 已 abort 也如实
            // 报 failed（旧实现同样不区分，父据此走降级兜底）。
            const lastRun = await options.sessions
              .listRunsBySession(ctx.userId, childSession.sessionId)
              .then((runs) => runs.at(-1))
              .catch(() => undefined);
            return finish(
              {
                status: "failed",
                sessionId: childSession.sessionId,
                runId: lastRun?.runId ?? null,
                error: `启动子任务失败：${errorText(error)}`,
              },
              lastRun?.status ?? null,
            );
          }
          try {
            let turn: PlannerTurn;
            if (combined.signal.aborted) {
              child.cancel();
              turn = { kind: "error", message: cancelError() };
            } else {
              const onCombinedAbort = () => child.cancel();
              combined.signal.addEventListener("abort", onCombinedAbort, { once: true });
              try {
                // 子会话过程事件盖章 subagent_id 后落父 sink（契约骨架
                // 透传缝）。stage 事件是本轮私有叙事不透传——父轮 stage 序列
                // 保持原状不被子会话插入；子侧可见性由 subagent_* 与盖章
                // tool_call 等实体级事件承担（详见 docs/issue-39/coordination.md）。
                turn = await child.prompt(task, {
                  ...(ctx.location ? { location: ctx.location } : {}),
                  ...(ctx.onProgress
                    ? {
                        onProgress: (event) => {
                          if (event.type === undefined || event.type === "stage") return;
                          safeEmit(
                            ctx.onProgress,
                            stampSubagent(event, childSession.sessionId),
                          );
                        },
                      }
                    : {}),
                });
              } catch (error) {
                turn = { kind: "error", message: errorText(error) };
              } finally {
                combined.signal.removeEventListener("abort", onCombinedAbort);
              }
            }
            // 子 run 由 spawnChild 侧建立；最新一条即本次派发的 run。
            // child_run_status 如实抄录持久化状态：父超时/取消瞬间子 run
            // 可能仍 running——以 DB 为权威，不伪装成终态（契约 §4）。
            const lastRun = await options.sessions
              .listRunsBySession(ctx.userId, childSession.sessionId)
              .then((runs) => runs.at(-1))
              .catch(() => undefined);
            const runId = lastRun?.runId ?? null;
            const childRunStatus = lastRun?.status ?? null;
            if (timedOut || parentAborted) {
              return finish(
                {
                  status: "cancelled",
                  sessionId: childSession.sessionId,
                  runId,
                  error: cancelError(),
                },
                childRunStatus,
              );
            }
            if (turn.kind === "error") {
              return finish(
                {
                  status: "failed",
                  sessionId: childSession.sessionId,
                  runId,
                  error: turn.message,
                },
                childRunStatus,
              );
            }
            if (turn.kind === "clarification") {
              return finish(
                {
                  status: "completed",
                  kind: "clarification",
                  sessionId: childSession.sessionId,
                  runId,
                  question: turn.question,
                },
                childRunStatus,
              );
            }
            if (turn.kind === "answer") {
              // 子任务把派发当成普通问答处理：如实回报为失败并附回答摘要，
              // 父 Agent 按既有降级准则改用 search_events 自行兜底。
              return finish(
                {
                  status: "failed",
                  sessionId: childSession.sessionId,
                  runId,
                  error: `子任务返回普通回答而非行程：${turn.text.slice(0, 200)}`,
                },
                childRunStatus,
              );
            }
            // child 也可能产出 comparison：委派结果统一取首个（active）
            // plan，父 Agent 汇总阶段再决定是否输出双方案。
            const itinerary =
              turn.kind === "comparison" ? turn.plans[0]?.itinerary : turn.itinerary;
            if (itinerary === undefined) {
              return finish(
                {
                  status: "failed",
                  sessionId: childSession.sessionId,
                  runId,
                  error: "子任务返回的双方案为空",
                },
                childRunStatus,
              );
            }
            // event_id 断链修复：按去重保序取回所选活动的校验/决策元信息，
            // 父 Agent 无需重跑 search_events 即可核对时间窗并合并站点。
            const ids = [...new Set(itinerary.stops.map((stop) => stop.event_id))];
            const eventsById = await options.repository.getByIds(ids);
            const events: DelegatedEventMeta[] = [];
            for (const id of ids) {
              const event = eventsById.get(id);
              if (!event) continue;
              events.push({
                id: event.id,
                title: event.title,
                category: event.category,
                venueName: event.venueName,
                startAt: event.startAt,
                endAt: event.endAt,
                suggestedDurationMinutes: event.suggestedDurationMinutes,
                budgetMin: event.budgetMin,
                budgetMax: event.budgetMax,
                currency: event.currency,
                budgetNote: event.budgetNote,
              });
            }
            return finish(
              {
                status: "completed",
                kind: "itinerary",
                sessionId: childSession.sessionId,
                runId,
                constraints: turn.constraints,
                itinerary,
                events,
              },
              childRunStatus,
            );
          } catch (error) {
            // spawned 已发出但未能走到终了回报（如活动元信息查询异常）：
            // 幂等补恰一个 failed done 保持 spawn/done 1:1，再上抛。
            if (!doneEmitted) {
              const lastRun = await options.sessions
                .listRunsBySession(ctx.userId, childSession.sessionId)
                .then((runs) => runs.at(-1))
                .catch(() => undefined);
              emitDone(
                {
                  status: "failed",
                  sessionId: childSession.sessionId,
                  runId: lastRun?.runId ?? null,
                  error: `子任务派发异常：${errorText(error)}`,
                },
                lastRun?.status ?? null,
              );
            }
            throw error;
          } finally {
            await child.close();
          }
        } finally {
          release();
        }
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", onParentAbort);
      }
    },
  };
}

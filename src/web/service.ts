/**
 * Web Chat 业务服务：把 ./types.ts 的 ChatService 契约接到持久化 Planner 上。
 *
 * - send() 每次为该 userId 打开一个持久化 Planner（createPersistentPlanner
 *   缺省幂等建用户并绑定主会话），跑一轮 prompt 后立即 close() 释放租约——
 *   无内存会话常驻，重启/多实例安全。
 * - history() 不打模型：直接读会话库，从已完成 run 的 input/result 还原
 *   用户可见消息，当前生效行程走 current_itinerary 指针单独返回。
 * - 离线测试可注入 createPlanner 工厂（返回 stub planner）或只注入
 *   streamFn（faux provider，仍走真实持久链路）；本文件不发真实模型请求。
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createPersistentPlanner } from "../agent/session.ts";
import type {
  PersistentPlannerOptions,
  PlannerPromptOptions,
  PlannerTurn,
} from "../agent/session.ts";
import type { ExplorerConfig } from "../config.ts";
import type { EventRepository } from "../data/repository.ts";
import type { Event } from "../data/types.ts";
import type { Itinerary } from "../itinerary/types.ts";
import type { SessionRepository } from "../session/repository.ts";
import type { Run } from "../session/types.ts";
import type {
  ChatHistory,
  ChatLocation,
  ChatMessage,
  ChatResult,
  ChatService,
  EventView,
} from "./types.ts";

/**
 * 一轮规划需要的最小 planner 面；PlannerSession 天然满足它。
 * 测试注入 stub 实现即可离线覆盖关闭/错误路径。
 */
export interface ChatPlanner {
  prompt(text: string, options?: PlannerPromptOptions): Promise<PlannerTurn>;
  /** 中止在途请求（幂等；空闲时无副作用）。 */
  cancel(): void;
  close(): Promise<void>;
}

/** planner 工厂签名：与 createPersistentPlanner 相同，返回收敛到 ChatPlanner。 */
export type ChatPlannerFactory = (
  options: PersistentPlannerOptions,
) => Promise<ChatPlanner>;

export interface WebChatServiceOptions {
  /** Agent 运行配置（provider/model/apiKey/compaction 等）。 */
  config: ExplorerConfig;
  /** 活动库：send 时供 Agent 工具使用，这里另用于 event_id → EventView 映射。 */
  repository: EventRepository;
  /** 会话库：planner 与 history 共用；调用方持有并负责 close()。 */
  sessions: SessionRepository;
  /**
   * planner 工厂；缺省 = createPersistentPlanner。注入 stub 时
   * config/repository/sessions 仍会传入，实现方自行决定用不用。
   */
  createPlanner?: ChatPlannerFactory;
  /** 模型流实现（注入 faux 时默认工厂完全离线；缺省走 config 对应的真实 provider）。 */
  streamFn?: StreamFn;
  /** "今天"（YYYY-MM-DD），写进系统提示解释相对日期；测试可固定。 */
  currentDate?: string;
  /** 会话写租约 TTL（毫秒）；默认 30s。 */
  leaseTtlMs?: number;
  /** 租约心跳间隔（毫秒）；缺省 leaseTtlMs/3。 */
  leaseRenewMs?: number;
  /** 校验/格式失败后的纠正轮上限；默认 2。 */
  maxCorrections?: number;
}

/**
 * turn.kind=error 或服务关闭时抛出的服务端异常：HTTP 层把它（与任何其他
 * 异常）统一记进 onError 并回 5xx，消息细节不外泄给响应体。
 */
export class ChatServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatServiceError";
  }
}

/**
 * ChatService + 生命周期管理：任务 D 在关闭数据库前 shutdown()。
 * - shutdown() 立即拒绝新请求（send/history 拒绝 ChatServiceError）；
 * - 取消所有在途 send（调 planner.cancel()）并等待它们 settle + close，
 *   保证 run 终态与会话租约收尾完成；
 * - 等待在途 history 读取结束；
 * - 幂等：重复调用返回同一个 Promise。
 */
export interface ManagedChatService extends ChatService {
  shutdown(): Promise<void>;
}

/**
 * 存储层 Event → 线上契约 EventView：显式做 camelCase → snake_case 映射，
 * 只挑 EventView 声明过的展示字段，不透传整条存储记录。
 */
export function toEventView(event: Event): EventView {
  return {
    event_id: event.id,
    title: event.title,
    latitude: event.latitude,
    longitude: event.longitude,
    venue_name: event.venueName,
    description: event.description,
    category: event.category,
    address: event.address,
    start_at: event.startAt,
    end_at: event.endAt,
    suggested_duration_minutes: event.suggestedDurationMinutes,
    budget_min: event.budgetMin,
    budget_max: event.budgetMax,
    currency: event.currency,
    budget_note: event.budgetNote,
    guide_url: event.guideUrl,
    thumbnail_url: event.thumbnailUrl,
    image_urls: [...event.imageUrls],
  };
}

/** run.input 中取用户可见输入文本；手动压缩等非对话输入返回 undefined。 */
function runInputText(run: Run): string | undefined {
  try {
    const input = JSON.parse(run.input) as { text?: unknown };
    return typeof input?.text === "string" ? input.text : undefined;
  } catch {
    return undefined;
  }
}

/** run.result 中取 PlannerTurn；形状不符（含手动压缩结果）返回 undefined。 */
function runTurn(run: Run): PlannerTurn | undefined {
  if (!run.result) return undefined;
  try {
    const turn = (JSON.parse(run.result) as { turn?: PlannerTurn }).turn;
    if (!turn || typeof turn !== "object") return undefined;
    if (turn.kind === "itinerary" && turn.itinerary) return turn;
    if (turn.kind === "clarification" && typeof turn.question === "string") return turn;
    if (turn.kind === "error" && typeof turn.message === "string") return turn;
    return undefined;
  } catch {
    return undefined;
  }
}

/** 一轮结果里用户可见的 assistant 文本：追问原文，或行程摘要。 */
function assistantText(turn: PlannerTurn): string | undefined {
  if (turn.kind === "clarification") return turn.question;
  if (turn.kind === "itinerary") return turn.itinerary.summary;
  return undefined;
}

/** send 的在途句柄：planner 就绪前即可被 shutdown/signal 标记取消。 */
interface SendHandle {
  planner?: ChatPlanner;
  cancelled: boolean;
}

/** 客户端中止信号对应的异常；优先复用 signal.reason。 */
function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new ChatServiceError(
    typeof reason === "string" && reason ? reason : "请求已中止",
  );
  error.name = "AbortError";
  return error;
}

/**
 * 建 ManagedChatService 实例。state 只存注入的依赖与在途集合，不缓存
 * 会话——每条消息都走会话库，重启或换实例后历史与当前行程不丢。
 *
 * 在途注册与 assertOpen 都在各自方法的第一个 await 之前（同步段内）：
 * shutdown() 与请求互不错过——要么请求已注册会被等待，要么请求直接被拒。
 */
export function createChatService(options: WebChatServiceOptions): ManagedChatService {
  const { config, repository, sessions } = options;
  const factory = options.createPlanner ?? createPersistentPlanner;

  /** 所有未 settle 的 send/history work promise。 */
  const inflight = new Set<Promise<unknown>>();
  /** 在途 send 句柄：shutdown 时对每个已就绪 planner 调 cancel()。 */
  const activeSends = new Set<SendHandle>();
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;

  /** 为该用户开一个新持久化 planner（缺省工厂内部幂等建用户/主会话）。 */
  function openPlanner(userId: string): Promise<ChatPlanner> {
    return factory({
      config,
      repository,
      sessions,
      userId,
      streamFn: options.streamFn,
      currentDate: options.currentDate,
      leaseTtlMs: options.leaseTtlMs,
      leaseRenewMs: options.leaseRenewMs,
      maxCorrections: options.maxCorrections,
      // web 是请求-响应生命周期：close 的机会蒸馏后台跑，不拖慢 send 响应。
      detachDistill: true,
    });
  }

  function assertOpen(): void {
    if (closed) throw new ChatServiceError("服务正在关闭，不再接受新请求");
  }

  /** 登记在途 work；settle（无论成败）后移出，shutdown 据此等待。 */
  function track<T>(work: Promise<T>): Promise<T> {
    inflight.add(work);
    const done = () => inflight.delete(work);
    work.then(done, done); // 不挂到返回 promise 上，避免产生 unhandled rejection
    return work;
  }

  /** 行程各站 event_id → EventView，按 stops 顺序、去重、缺库记录跳过。 */
  async function eventViews(itinerary: Itinerary): Promise<EventView[]> {
    const ids: string[] = [];
    for (const stop of itinerary.stops) {
      if (!ids.includes(stop.event_id)) ids.push(stop.event_id);
    }
    const events = await repository.getByIds(ids);
    const views: EventView[] = [];
    for (const id of ids) {
      const event = events.get(id);
      if (event) views.push(toEventView(event));
    }
    return views;
  }

  async function runSend(
    handle: SendHandle,
    userId: string,
    message: string,
    options?: { signal?: AbortSignal; location?: ChatLocation },
  ): Promise<ChatResult> {
    const signal = options?.signal;
    let planner: ChatPlanner | undefined;
    try {
      planner = await openPlanner(userId);
      handle.planner = planner;
      // openPlanner 期间可能已被 shutdown/abort 标记：不再启动模型轮。
      if (handle.cancelled || signal?.aborted) throw abortError(signal);
      const onAbort = () => {
        handle.cancelled = true;
        handle.planner?.cancel();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      let turn: PlannerTurn;
      try {
        // abort 时 prompt 自行 settle；location 只进 prompt options（持久层
        // 会沿用到本会话后续请求，见 PlannerPromptOptions.location）。
        turn = await planner.prompt(message, { location: options?.location });
      } catch (error) {
        // 中止引起的 prompt 异常也归为 AbortError，不伪装成内部错误。
        if (handle.cancelled || signal?.aborted) throw abortError(signal);
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      // 已中止：结果照常丢弃，向 HTTP 层报中止（客户端通常已断开）。
      if (handle.cancelled || signal?.aborted) throw abortError(signal);
      if (turn.kind === "error") {
        throw new ChatServiceError(`规划失败：${turn.message}`);
      }
      if (turn.kind === "clarification") {
        return { kind: "clarification", question: turn.question };
      }
      return {
        kind: "itinerary",
        itinerary: turn.itinerary,
        events: await eventViews(turn.itinerary),
      };
    } finally {
      activeSends.delete(handle);
      // 每次 send 用完即关：释放会话租约，让其他实例/请求能继续写。
      if (planner) await planner.close();
    }
  }

  async function runHistory(userId: string): Promise<ChatHistory> {
    // 幂等：已存在直接返回既有用户；没有则建 user + main 会话。
    await sessions.createUser({ userId });
    const session = await sessions.getMainSession(userId);
    const [runs, current] = await Promise.all([
      sessions.listRunsBySession(userId, session.sessionId),
      sessions.getCurrentItinerary(userId, session.sessionId),
    ]);
    // 产生当前行程的那个 run：其 assistant 文本由独立行程卡片替代，不进 messages。
    const producingRunId = current?.record.runId ?? undefined;
    const messages: ChatMessage[] = [];
    for (const run of runs) {
      // 只看 completed：中断/失败/排队中的 run 对用户不可见，连同输入一起忽略。
      if (run.status !== "completed") continue;
      const text = runInputText(run);
      const turn = runTurn(run);
      if (text === undefined && turn === undefined) continue; // 非对话 run
      if (text !== undefined) messages.push({ role: "user", text });
      // 一轮内的工具消息、模型纠错文本不还原——只有终态 turn 可见。
      if (turn !== undefined && run.runId !== producingRunId) {
        const reply = assistantText(turn);
        if (reply !== undefined) messages.push({ role: "assistant", text: reply });
      }
    }
    const history: ChatHistory = {
      messages,
      itinerary: current?.plan.itinerary ?? null,
    };
    if (current) history.events = await eventViews(current.plan.itinerary);
    return history;
  }

  return {
    // async 使 assertOpen 的拒绝也走 rejected promise（与 HTTP/测试约定一致）。
    async send(
      userId: string,
      message: string,
      options?: { signal?: AbortSignal; location?: ChatLocation },
    ): Promise<ChatResult> {
      // 同步段：拒新请求 + 注册在途句柄，都先于第一个 await（防 shutdown 竞争）。
      assertOpen();
      const signal = options?.signal;
      if (signal?.aborted) throw abortError(signal);
      const handle: SendHandle = { cancelled: false };
      activeSends.add(handle);
      return track(runSend(handle, userId, message, options));
    },

    async history(userId: string): Promise<ChatHistory> {
      assertOpen();
      return track(runHistory(userId));
    },

    shutdown(): Promise<void> {
      if (shutdownPromise === undefined) {
        // 同步段：closed 置位与取消广播先于 await，此刻起新请求一律被拒。
        closed = true;
        for (const handle of activeSends) {
          handle.cancelled = true;
          handle.planner?.cancel();
        }
        shutdownPromise = Promise.allSettled([...inflight]).then(() => {});
      }
      return shutdownPromise;
    },
  };
}

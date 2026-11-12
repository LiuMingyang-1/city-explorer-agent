/**
 * Web Chat 业务服务：把 ./types.ts 的 ChatService 契约接到持久化 Planner 上。
 *
 * - send() 每次为该 userId 打开一个持久化 Planner：带 sessionId 时校验
 *   并续用该对话；不带时懒建一条新对话（标题取首条消息前 30 个码点），
 *   跑一轮 prompt 后立即 close() 释放租约——无内存会话常驻，
 *   重启/多实例安全。
 * - history() 不打模型：带 sessionId 时从已完成 run 的 input/result 还原
 *   用户可见消息，当前生效行程走 current_itinerary 指针单独返回；不带时
 *   直接回空历史，不在库里建任何行。
 * - 客户端语义错误（不存在/跨用户/child → not_found，归档/租约忙 →
 *   conflict）抛 ChatClientError，HTTP 层映射 404/409；其余异常仍 500。
 * - 离线测试可注入 createPlanner 工厂（返回 stub planner）或只注入
 *   streamFn（faux provider，仍走真实持久链路）；本文件不发真实模型请求。
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createPersistentPlanner } from "../agent/session.ts";
import type {
  PersistentPlannerOptions,
  PlannerProgress,
  PlannerPromptOptions,
  PlannerTurn,
} from "../agent/session.ts";
import type { ExplorerConfig } from "../config.ts";
import type { EventRepository } from "../data/repository.ts";
import type { Event } from "../data/types.ts";
import type { Itinerary } from "../itinerary/types.ts";
import { createAmapRouter } from "../routing/amap.ts";
import { computePlanLegs } from "../routing/legs.ts";
import type { RouteComputer } from "../routing/types.ts";
import type { SessionRepository } from "../session/repository.ts";
import { isSessionError, type Run } from "../session/types.ts";
import { ChatClientError } from "./types.ts";
import type {
  ChatHistory,
  ChatLocation,
  ChatMessage,
  ChatResult,
  ChatService,
  EventsQuery,
  EventsResult,
  EventView,
  Plan,
  UserMemoryView,
} from "./types.ts";

/**
 * 一轮规划需要的最小 planner 面；PlannerSession 天然满足它。
 * 测试注入 stub 实现即可离线覆盖关闭/错误路径。
 */
export interface ChatPlanner {
  /** 该 planner 绑定的持久会话 ID；内存会话可为 undefined。 */
  readonly sessionId?: string;
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
    if (turn.kind === "comparison" && Array.isArray(turn.plans) && turn.plans.length > 0) {
      return turn;
    }
    if (turn.kind === "clarification" && typeof turn.question === "string") return turn;
    if (turn.kind === "error" && typeof turn.message === "string") return turn;
    return undefined;
  } catch {
    return undefined;
  }
}

/** 一轮结果里用户可见的 assistant 文本：追问原文、行程摘要或方案标题串。 */
function assistantText(turn: PlannerTurn): string | undefined {
  if (turn.kind === "clarification") return turn.question;
  if (turn.kind === "itinerary") return turn.itinerary.summary;
  if (turn.kind === "comparison") {
    return turn.plans.map((p) => `方案 ${p.label}：${p.title}`).join("；");
  }
  return undefined;
}

/** 校验通过的 plan → 线上 Plan 视图；legs 缺省 []（无算路器时全组降级）。 */
function planView(
  label: "A" | "B",
  title: string,
  itinerary: Itinerary,
  legs: Plan["legs"] = [],
): Plan {
  return {
    plan_id: label,
    label,
    title,
    itinerary,
    legs,
    validation: { status: "passed", scope: "inter_stop", issues: [] },
    warnings: legs.some((leg) => leg.status === "error")
      ? ["部分站间道路路线获取失败，对应轨迹已省略"]
      : [],
  };
}

/**
 * turn.warning 收进响应顶层 warnings；无警告时省略该键。
 * "run 终态…" 是租约丢失等内部故障的落库告警，原文含底层错误细节，
 * 对外一律换成固定脱敏文案（详情仍在 run.result 供审计）。
 */
function topWarnings(turn: PlannerTurn): { warnings?: string[] } {
  if (turn.kind === "error" || turn.warning === undefined) return {};
  const warning = turn.warning.startsWith("run 终态")
    ? "本次回复已生成，但后台存档未完整落库"
    : turn.warning;
  return { warnings: [warning] };
}

/** turn 告警 + legs 降级说明合并进顶层 warnings；均无则省略该键。 */
function mergedWarnings(turn: PlannerTurn, extra: string[]): { warnings?: string[] } {
  const warnings = [...(topWarnings(turn).warnings ?? []), ...extra];
  return warnings.length > 0 ? { warnings } : {};
}

/** send 的在途句柄：planner 就绪前即可被 shutdown/signal 标记取消。 */
interface SendHandle {
  planner?: ChatPlanner;
  cancelled: boolean;
  /** shutdown 取消入口：abort 本轮的合并 signal（覆盖 legs 算路）。 */
  abortSend?: () => void;
}

/**
 * send 的可选参数。signal/location/sessionId 与 ChatService 契约一致；
 * onSession/onProgress 是流式端点（POST /api/chat/stream）的观察回调——
 * 事件契约见 ./sse.ts，types.ts 由 plans-contract 工作流维护故不并入。
 */
export interface SendOptions {
  signal?: AbortSignal;
  location?: ChatLocation;
  sessionId?: string;
  /** 前端滑块选中方案；仅最近一轮为 comparison 时注入 prompt，否则忽略。 */
  activePlan?: string;
  /** 地图气泡点选的活动 id；查库解析后注入 prompt，查无忽略。 */
  referencedEventId?: string;
  /** 会话确定（planner 就绪、sessionId 可知）即回调一次；SSE meta 据此发出。 */
  onSession?: (sessionId: string) => void;
  /** 规划阶段进度回调（轮内可多次）；SSE progress 事件据此转发。 */
  onProgress?: (progress: PlannerProgress) => void;
}

/** GET /api/events 未传 limit 时的契约默认条数（上限校验在 HTTP 层）。 */
const DEFAULT_EVENTS_LIMIT = 200;

/** 服务端本地"今天"（YYYY-MM-DD）：GET /api/events 不带日期参数时的默认窗口。 */
function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
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
  // 高德算路器：未配置 EXPLORER_AMAP_KEY 时为 null，legs 全组 skipped 降级。
  const router: RouteComputer | null = config.amapKey
    ? createAmapRouter({ key: config.amapKey, city: config.amapTransitCity })
    : null;

  /** 所有未 settle 的 send/history work promise。 */
  const inflight = new Set<Promise<unknown>>();
  /** 在途 send 句柄：shutdown 时对每个已就绪 planner 调 cancel()。 */
  const activeSends = new Set<SendHandle>();
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;

  /**
   * 新对话标题：首条消息 trim 后前 30 个码点。[...str] 按码点迭代，
   * 绝不切碎 emoji 等 surrogate pair（message 已由 HTTP 层 trim+限长）。
   */
  function conversationTitle(message: string): string {
    return [...message.trim()].slice(0, 30).join("");
  }

  /**
   * 用户面对话校验：不存在、不属于该用户或 kind!=='main'（内部 child
   * 任务会话）统一 not_found——不泄露跨用户/内部会话存在性；非 active
   * （已归档）→ conflict。
   */
  async function requireMainSession(userId: string, sessionId: string): Promise<void> {
    const session = await sessions.getSession(userId, sessionId);
    if (!session || session.kind !== "main") {
      throw new ChatClientError("not_found", "会话不存在");
    }
    if (session.status !== "active") {
      throw new ChatClientError("conflict", "会话已归档");
    }
  }

  /**
   * 校验点之后的租约/归档竞争兜底：显式会话在 requireMainSession 到
   * openPlanner/prompt 之间仍可能被归档或被另一写者占用，把那些异常统一
   * 归并进 ChatClientError（HTTP 层 404/409），不当 500 报。其余异常原样。
   */
  function mapSessionError(error: unknown): unknown {
    if (error instanceof ChatClientError) return error;
    if (isSessionError(error, "archived")) {
      return new ChatClientError("conflict", "会话已归档");
    }
    if (isSessionError(error, "not_found") || isSessionError(error, "cross_user")) {
      return new ChatClientError("not_found", "会话不存在");
    }
    // LeaseGuard 在 acquireLease 失败时抛普通 Error（"写租约未释放"），
    // 续约/接管失败也是同族写租约竞争——同会话并发写一律 409。
    if (error instanceof Error && error.message.includes("写租约")) {
      return new ChatClientError("conflict", "会话正由另一个写者处理，请稍后重试");
    }
    return error;
  }

  /** 为该用户开一个持久化 planner：显式 sessionId 续用对话，否则按 title 懒建新对话。 */
  function openPlanner(
    userId: string,
    extra: { sessionId?: string; title?: string } = {},
  ): Promise<ChatPlanner> {
    return factory({
      config,
      repository,
      sessions,
      userId,
      sessionId: extra.sessionId,
      title: extra.title,
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

  /** 各行程 stops 的 event_id → Event 映射（EventView 与 legs 算路共用一次查询）。 */
  async function planEvents(...itineraries: Itinerary[]): Promise<Map<string, Event>> {
    const ids: string[] = [];
    for (const itinerary of itineraries) {
      for (const stop of itinerary.stops) {
        if (!ids.includes(stop.event_id)) ids.push(stop.event_id);
      }
    }
    return repository.getByIds(ids);
  }

  /** eventsById → 按 ids 顺序的 EventView 列表；缺库记录跳过。 */
  function toEventViews(eventsById: ReadonlyMap<string, Event>, ids: string[]): EventView[] {
    const views: EventView[] = [];
    for (const id of ids) {
      const event = eventsById.get(id);
      if (event) views.push(toEventView(event));
    }
    return views;
  }

  /** 各行程 stops 的 event_id → EventView，按出现顺序、去重、缺库记录跳过。 */
  async function eventViews(...itineraries: Itinerary[]): Promise<EventView[]> {
    const events = await planEvents(...itineraries);
    const ids: string[] = [];
    for (const itinerary of itineraries) {
      for (const stop of itinerary.stops) {
        if (!ids.includes(stop.event_id)) ids.push(stop.event_id);
      }
    }
    return toEventViews(events, ids);
  }

  /**
   * 一组行程 → plans + events 响应装配：复用一次 getByIds，逐 plan 并行
   * 计算真实站间道路 legs（高德；无 router 时全组 skipped 降级，绝不阻塞
   * 响应）。配置了算路器且存在站间段时先报 routing 阶段进度。
   */
  async function assemblePlans(
    items: { label: "A" | "B"; title: string; itinerary: Itinerary }[],
    onProgress?: (progress: PlannerProgress) => void,
    signal?: AbortSignal,
  ): Promise<{ plans: Plan[]; events: EventView[]; warnings: string[] }> {
    const eventsById = await planEvents(...items.map((i) => i.itinerary));
    const hasLegs = items.some((i) => i.itinerary.stops.length >= 2);
    if (router && hasLegs) {
      try {
        onProgress?.({
          stage: "routing",
          message: "正在获取站间道路路线",
          plan_ids: items.map((i) => i.label),
        });
      } catch {
        // 观察回调抛错不中断本轮。
      }
    }
    const plans = await Promise.all(
      items.map(async (item) =>
        planView(
          item.label,
          item.title,
          item.itinerary,
          await computePlanLegs(item.itinerary.stops, eventsById, {
            router,
            transitThresholdM: config.routeTransitThresholdM,
            signal,
          }),
        ),
      ),
    );
    const ids: string[] = [];
    for (const item of items) {
      for (const stop of item.itinerary.stops) {
        if (!ids.includes(stop.event_id)) ids.push(stop.event_id);
      }
    }
    // 各 plan 的降级说明去重汇总进顶层 warnings（契约：双层提示）。
    return {
      plans,
      events: toEventViews(eventsById, ids),
      warnings: [...new Set(plans.flatMap((plan) => plan.warnings))],
    };
  }

  /**
   * referenced_event_id → 注入用的点选活动描述：查库取标题/场馆；
   * 查无此 id 或查询失败 → undefined（点选是弱上下文，不该让请求失败）。
   */
  async function resolveReferencedEvent(
    eventId: string | undefined,
  ): Promise<PlannerPromptOptions["referencedEvent"]> {
    if (eventId === undefined) return undefined;
    try {
      const event = (await repository.getByIds([eventId])).get(eventId);
      return event
        ? { eventId: event.id, title: event.title, venueName: event.venueName }
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function runSend(
    handle: SendHandle,
    userId: string,
    message: string,
    options?: SendOptions,
  ): Promise<ChatResult> {
    const clientSignal = options?.signal;
    // 每次 send 持有独立 AbortController：shutdown 直接 abort，与客户端
    // signal 合并后贯穿查询/模型/算路/装配全程（legs 不再只认客户端断连）。
    const controller = new AbortController();
    handle.abortSend = () => controller.abort();
    const signal =
      clientSignal !== undefined
        ? AbortSignal.any([clientSignal, controller.signal])
        : controller.signal;
    let planner: ChatPlanner | undefined;
    // abort 监听从模型轮一路挂到 legs 算路与装配结束——取消链覆盖
    // resolveReferencedEvent、prompt、computePlanLegs 全程。
    const onAbort = () => {
      handle.cancelled = true;
      handle.planner?.cancel();
    };
    try {
      if (options?.sessionId !== undefined) {
        // 显式续用对话：先校验归属/kind/status，再交给工厂打开。
        await requireMainSession(userId, options.sessionId);
      }
      planner = await openPlanner(
        userId,
        options?.sessionId !== undefined
          ? { sessionId: options.sessionId }
          : { title: conversationTitle(message) },
      );
      handle.planner = planner;
      // 会话已确定（模型轮尚未启动）：流式端点据此先发 meta 事件。
      const readySessionId = planner.sessionId ?? options?.sessionId;
      if (readySessionId !== undefined && readySessionId !== "") {
        try {
          options?.onSession?.(readySessionId);
        } catch {
          // 观察回调抛错不中断本轮。
        }
      }
      // openPlanner 期间可能已被 shutdown/abort 标记：不再启动模型轮。
      if (handle.cancelled || signal?.aborted) throw abortError(signal);
      signal?.addEventListener("abort", onAbort, { once: true });
      let turn: PlannerTurn;
      try {
        // abort 时 prompt 自行 settle；location/activePlan/referencedEvent
        // 只进 prompt options（持久层注入 system section，见
        // PlannerPromptOptions）。未定义的键不写入，保持 options 稀疏。
        const promptOptions: PlannerPromptOptions = {};
        if (options?.location !== undefined) promptOptions.location = options.location;
        if (options?.activePlan !== undefined) promptOptions.activePlan = options.activePlan;
        const referenced = await resolveReferencedEvent(options?.referencedEventId);
        if (referenced !== undefined) promptOptions.referencedEvent = referenced;
        // 点选查询是异步边界：期间断连不启动模型轮。
        if (handle.cancelled || signal?.aborted) throw abortError(signal);
        if (options?.onProgress !== undefined) promptOptions.onProgress = options.onProgress;
        turn = await planner.prompt(message, promptOptions);
      } catch (error) {
        // 中止引起的 prompt 异常也归为 AbortError，不伪装成内部错误。
        if (handle.cancelled || signal?.aborted) throw abortError(signal);
        throw error;
      }
      // 已中止：结果照常丢弃，向 HTTP 层报中止（客户端通常已断开）。
      if (handle.cancelled || signal?.aborted) throw abortError(signal);
      if (turn.kind === "error") {
        // 租约竞争/归档竞争在轮内被压成 error turn（open 后、prompt 建 run
        // 前会话被抢占/归档）：如实映射 409，不冒充服务端故障 500。
        if (turn.message.includes("写租约") || turn.message.includes("已归档")) {
          throw new ChatClientError("conflict", "会话暂不可用，请稍后重试");
        }
        throw new ChatServiceError(`规划失败：${turn.message}`);
      }
      const sessionId = planner.sessionId ?? options?.sessionId;
      if (sessionId === undefined || sessionId === "") {
        throw new ChatServiceError("本轮规划未返回 session_id");
      }
      if (turn.kind === "clarification") {
        return { kind: "clarification", session_id: sessionId, question: turn.question };
      }
      if (turn.kind === "comparison") {
        // 双方案：首个 plan 是已提交指针的 active 方案。
        const { plans, events, warnings } = await assemblePlans(
          turn.plans.map((p) => ({ label: p.label, title: p.title, itinerary: p.itinerary })),
          options?.onProgress,
          signal,
        );
        // 算路期间断连：丢弃装配结果（已提交的行程指针保留）。
        if (handle.cancelled || signal?.aborted) throw abortError(signal);
        return {
          kind: "plans",
          session_id: sessionId,
          mode: "comparison",
          active_plan: turn.plans[0].label,
          plans,
          events,
          coordinate_system: "GCJ-02",
          ...mergedWarnings(turn, warnings),
        };
      }
      const { plans, events, warnings } = await assemblePlans(
        [{ label: "A", title: turn.itinerary.summary, itinerary: turn.itinerary }],
        options?.onProgress,
        signal,
      );
      if (handle.cancelled || signal?.aborted) throw abortError(signal);
      return {
        kind: "plans",
        session_id: sessionId,
        mode: "single",
        active_plan: "A",
        plans,
        events,
        coordinate_system: "GCJ-02",
        ...mergedWarnings(turn, warnings),
      };
    } catch (error) {
      if (handle.cancelled || signal?.aborted) throw abortError(signal);
      throw mapSessionError(error);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      activeSends.delete(handle);
      // 每次 send 用完即关：释放会话租约，让其他实例/请求能继续写。
      if (planner) await planner.close();
    }
  }

  async function runHistory(userId: string, sessionId?: string): Promise<ChatHistory> {
    // 未指定对话 = 新访客/新页面：不建用户、不查库建会话，空页面加载
    // 绝不产生任何数据库会话行（对话在首条 POST 时才懒建）。
    if (sessionId === undefined) return { messages: [], itinerary: null };
    await requireMainSession(userId, sessionId);
    const [runs, current] = await Promise.all([
      sessions.listRunsBySession(userId, sessionId),
      sessions.getCurrentItinerary(userId, sessionId),
    ]);
    // 产生当前行程的那个 run：其 assistant 文本由独立行程卡片替代，不进 messages。
    const producingRunId = current?.record.runId ?? undefined;
    const messages: ChatMessage[] = [];
    // 会话最近一轮产出（列表升序，最后定义的 turn 即最新一轮）：
    // 为 comparison 时 history 额外还原 plans/mode/active_plan。
    let latestTurn: PlannerTurn | undefined;
    for (const run of runs) {
      // 只看 completed：中断/失败/排队中的 run 对用户不可见，连同输入一起忽略。
      if (run.status !== "completed") continue;
      const text = runInputText(run);
      const turn = runTurn(run);
      if (text === undefined && turn === undefined) continue; // 非对话 run
      if (turn !== undefined) latestTurn = turn;
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
    // 最近一个产出方案的轮（itinerary 或 comparison）还原 plans 视图：
    // 前端统一按 plans 渲染（含 legs 轨迹），itinerary 保持向后兼容。
    if (latestTurn?.kind === "comparison") {
      const { plans, events } = await assemblePlans(
        latestTurn.plans.map((p) => ({ label: p.label, title: p.title, itinerary: p.itinerary })),
      );
      history.plans = plans;
      history.mode = "comparison";
      history.active_plan = latestTurn.plans[0].label;
      history.events = events;
    } else if (latestTurn?.kind === "itinerary") {
      const { plans, events } = await assemblePlans([
        { label: "A", title: latestTurn.itinerary.summary, itinerary: latestTurn.itinerary },
      ]);
      history.plans = plans;
      history.mode = "single";
      history.active_plan = "A";
      history.events = events;
    } else if (current) {
      history.events = await eventViews(current.plan.itinerary);
    }
    return history;
  }

  /**
   * GET /api/events：活动库全局共享，不按 userId 过滤（签名与接口其余
   * 方法一致以 cookie 用户起头）。date 与 from/to 二选一由 HTTP 层保证；
   * 都不给时按"今天"（currentDate 可注入固定，缺省服务端本地日期）。
   */
  async function runListEvents(query: EventsQuery): Promise<EventsResult> {
    const date =
      query.date ??
      (query.from === undefined && query.to === undefined
        ? (options.currentDate ?? localToday())
        : undefined);
    const events = await repository.search({
      date,
      from: query.from,
      to: query.to,
      bbox: query.bbox,
      // 契约默认 200 是 API 语义（上限 500 已由 HTTP 层校验）；
      // 活动库自身缺省 100 是 search_events 工具的保护上限，不在此复用。
      limit: query.limit ?? DEFAULT_EVENTS_LIMIT,
    });
    return { events: events.map(toEventView) };
  }

  async function runGetMemory(userId: string): Promise<UserMemoryView> {
    const memory = await sessions.getUserMemory(userId);
    return { content: memory?.content ?? "", updated_at: memory?.updatedAt ?? null };
  }

  /**
   * PUT /api/memory：覆盖式更新正文。cookie 用户可能从未发过消息而还没
   * users 行——createUser 幂等，先保证 user_memory 的外键主行存在。
   * 蒸馏游标（sourceSessionId + throughMessageSeq）整对保留——它是
   * "蒸到哪儿"的读取指针，与正文内容无关；清掉会话 ID 会让下次蒸馏
   * 从头重读，可能把刚删掉/改掉的偏好重新蒸回来。
   */
  async function runPutMemory(userId: string, content: string): Promise<UserMemoryView> {
    await sessions.createUser({ userId });
    // 用含墓碑的原始读：删除后手工重写仍沿用原游标，已蒸过的消息不会
    // 因墓碑被重新蒸馏回偏好。
    const existing = await sessions.getUserMemoryRaw(userId);
    await sessions.putUserMemory(userId, {
      content,
      sourceSessionId: existing?.sourceSessionId ?? null,
      throughMessageSeq: existing?.throughMessageSeq ?? 0,
    });
    return runGetMemory(userId);
  }

  async function runDeleteMemory(userId: string): Promise<void> {
    await sessions.deleteUserMemory(userId);
  }

  return {
    // async 使 assertOpen 的拒绝也走 rejected promise（与 HTTP/测试约定一致）。
    async send(
      userId: string,
      message: string,
      options?: SendOptions,
    ): Promise<ChatResult> {
      // 同步段：拒新请求 + 注册在途句柄，都先于第一个 await（防 shutdown 竞争）。
      assertOpen();
      const signal = options?.signal;
      if (signal?.aborted) throw abortError(signal);
      const handle: SendHandle = { cancelled: false };
      activeSends.add(handle);
      return track(runSend(handle, userId, message, options));
    },

    async history(userId: string, sessionId?: string): Promise<ChatHistory> {
      assertOpen();
      return track(runHistory(userId, sessionId));
    },

    async listEvents(_userId: string, query: EventsQuery): Promise<EventsResult> {
      assertOpen();
      return track(runListEvents(query));
    },

    async getMemory(userId: string): Promise<UserMemoryView> {
      assertOpen();
      return track(runGetMemory(userId));
    },

    async putMemory(userId: string, content: string): Promise<UserMemoryView> {
      assertOpen();
      return track(runPutMemory(userId, content));
    },

    async deleteMemory(userId: string): Promise<void> {
      assertOpen();
      return track(runDeleteMemory(userId));
    },

    shutdown(): Promise<void> {
      if (shutdownPromise === undefined) {
        // 同步段：closed 置位与取消广播先于 await，此刻起新请求一律被拒。
        closed = true;
        for (const handle of activeSends) {
          handle.cancelled = true;
          // abort 触发 onAbort → planner.cancel()，不再重复直接调。
          handle.abortSend?.();
        }
        shutdownPromise = Promise.allSettled([...inflight]).then(() => {});
      }
      return shutdownPromise;
    },
  };
}

/**
 * Web Chat HTTP 协议层的共享契约类型：前端 ↔ HTTP handler ↔ 业务服务。
 * HTTP 层（http.ts）只依赖这些类型与注入的 ChatService，不 import 真实 Agent；
 * service 的具体实现（会话存储 + Agent 编排）由装配层提供。
 */
import type { Itinerary } from "../itinerary/types.ts";

export type { Itinerary } from "../itinerary/types.ts";

/** 聊天记录里的一条消息，与 CLI 端保持 user/assistant 两角色。 */
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * 前端渲染行程卡片与地图用的活动视图，是独立的线上契约（snake_case，
 * 与 Itinerary 的 event_id/arrive_at 风格一致），不是存储层 Event 的别名。
 * service/adapter 必须显式做 Event → EventView 字段映射，不得整条透传
 * 存储记录——camelCase 的 id/venueName 前端并不认识。
 * 前五个为必填；其余展示字段可选，缺省表示前端不展示该项。
 */
export interface EventView {
  /** 对应 Event.id；itinerary.stops[].event_id 以此关联详情。 */
  record_type?: "activity" | "attraction";
  valid_from?: string | null; valid_to?: string | null;
  available_windows?: import("../data/schedule.ts").AvailableWindow[];
  coordinate_system?: "GCJ-02";
  event_id: string;
  title: string;
  latitude: number;
  longitude: number;
  venue_name: string;
  description?: string;
  category?: string;
  address?: string;
  /** 本地时间 "YYYY-MM-DDTHH:MM"（不带时区），语义同 Event.startAt/endAt。 */
  start_at?: string | null;
  end_at?: string | null;
  suggested_duration_minutes?: number | null;
  /** 每人费用区间（分；0=免费、null=未知），语义同 Event 对应字段。 */
  budget_min?: number | null;
  budget_max?: number | null;
  currency?: string;
  budget_note?: string | null;
  guide_url?: string | null;
  thumbnail_url?: string | null;
  image_urls?: string[];
}

/** GET /api/chat/history 的响应体。 */
export interface ChatHistory {
  messages: ChatMessage[];
  /** 当前生效行程（committed plan 的 itinerary）；尚未形成行程时省略或为 null。 */
  itinerary?: Itinerary | null;
  /** itinerary 各站（最近一轮为 comparison 时是全部 plan）event_id 对应的活动详情。 */
  events?: EventView[];
  /** 最近一轮 run 产出为 comparison 时还原的方案列表（含当前生效/备选）。 */
  plans?: Plan[];
  /** 最近一轮输出形态；plans 存在时为 "comparison"。 */
  mode?: "single" | "comparison";
  /** 当前生效 plan_id（committed plan 的 label）。 */
  active_plan?: string;
}

/** 用户当前位置坐标（GPS/选点），只含坐标不含地名。 */
export interface ChatLocation {
  lat: number;
  lng: number;
}

/**
 * POST /api/chat 接受的请求体形：`{ "message": "…" }`，可附带 location、
 * session_id、active_plan 与 referenced_event_id。message 必填，按 trim 后
 * 长度计须为 1..1000 字；location 可选，是前端当前选点/GPS 的经纬度（只传
 * 坐标不传地名）；session_id 可选，是本页已建对话的 id——带它继续同一
 * 对话，不带则懒建一条新对话；active_plan 可选，是前端滑块当前选中的
 * plan_id（"A"/"B"），仅最近一轮产出过 comparison 时有意义；referenced_
 * event_id 可选，是地图气泡点选的活动 id（服务端查库取标题/场馆注入
 * prompt，查无则忽略）。不接受 userId、messages 等任何其他字段——身份
 * 只来自服务端签发的 cookie，历史只存服务端。
 */
export interface ChatSendRequest {
  message: string;
  location?: ChatLocation;
  session_id?: string;
  active_plan?: string;
  referenced_event_id?: string;
}

/**
 * 相邻两站间的道路段（stops-1 条），由服务端在模型输出校验通过后经
 * 高德算路工作流计算填充——模型不输出 legs；本期一律返回 []。
 */
export interface PlanLeg {
  from_event_id: string;
  to_event_id: string;
  mode: "walking" | "transit";
  status: "ok" | "error" | "skipped";
  provider: "amap" | "none";
  duration_seconds: number | null;
  distance_meters: number | null;
  buffer_seconds: number;
  /** GeoJSON LineString，[lng,lat] GCJ-02；算路失败/未算时为 null。 */
  geometry: { type: "LineString"; coordinates: [number, number][] } | null;
  error_code: string | null;
}

/** 单个候选方案（单方案恒 label "A"）。 */
export interface Plan {
  /** 与 label 同值："A" 或 "B"；single 恒 "A"。 */
  plan_id: string;
  label: "A" | "B";
  /** 方案一句话标题（single 取 itinerary.summary）。 */
  title: string;
  itinerary: Itinerary;
  legs: PlanLeg[];
  validation: { status: "passed" | "issues"; scope: "inter_stop"; issues: unknown[] };
  warnings: string[];
}

/**
 * POST /api/chat 成功（200）的响应体：追问、普通回答或方案列表；
 * session_id 回传本轮对话。kind:"plans" 统一承载单/双方案：
 * mode "single" 时 plans 恰 1 条（label "A"）；"comparison" 时 2 条，
 * active_plan 为当前生效 plan_id（首个=committed plan）。
 * kind:"answer" 是普通问答/讨论：只带 text 回答文本，不携带方案、
 * 不改变当前行程——前端按普通聊天消息展示，不更新行程卡片与地图。
 */
export type ChatResult =
  | { kind: "clarification"; session_id: string; question: string }
  | { kind: "answer"; session_id: string; text: string; warnings?: string[] }
  | {
      kind: "plans";
      session_id: string;
      mode: "single" | "comparison";
      active_plan: string;
      plans: Plan[];
      /** 全部 plan 引用活动的去重并集。 */
      events: EventView[];
      coordinate_system: "GCJ-02";
      warnings?: string[];
    };

/** GCJ-02 经纬度包围盒（GET /api/events 的 bbox=minLng,minLat,maxLng,maxLat 解析结果）。 */
export interface EventBBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

/**
 * GET /api/events 已校验的查询条件：date 与 from/to 二选一（都不给时
 * 由实现方按服务端本地"今天"处理）；bbox 可选；limit 已由 HTTP 层
 * 钳进契约上限。
 */
export interface EventsQuery {
  date?: string;
  from?: string;
  to?: string;
  bbox?: EventBBox;
  limit?: number;
}

/** GET /api/events 的响应体。 */
export interface EventsResult {
  events: EventView[];
}

/** GET/PUT /api/memory 的响应体：无记录时 content 为空串、updated_at 为 null。 */
export interface UserMemoryView {
  content: string;
  updated_at: string | null;
}

/** 所有非 2xx 响应的统一错误体形。 */
export interface ChatErrorResponse {
  error: string;
}

/**
 * 客户端语义错误（HTTP 层据此映射 404/409，不记 onError）：
 * - not_found：会话不存在、不属于该用户或不是用户面对话（kind='child'）——
 *   统一响应不泄露跨用户或内部会话的存在性 → 404；
 * - conflict：会话已归档或写租约被另一写者占用 → 409。
 * 定义在本层，service 抛它、http 判它，两边都不需要 import src/session/*。
 */
export type ChatClientErrorCode = "not_found" | "conflict";
export class ChatClientError extends Error {
  readonly code: ChatClientErrorCode;
  constructor(code: ChatClientErrorCode, message: string) {
    super(message);
    this.name = "ChatClientError";
    this.code = code;
  }
}

/**
 * 可注入的业务服务签名，HTTP 层只面向它编程。
 * userId 是服务端签发的随机匿名 id（见 identity.ts 的安全语义注释）；
 * 实现方负责把同一 userId 下的历史与当前行程关联起来。
 */
export interface ChatService {
  /**
   * 读指定对话的历史消息与当前行程/活动；sessionId 缺省时返回空历史
   * （新访客/新页面不在服务端建任何会话行）。会话不存在、跨用户或
   * 指向内部 child 会话 → ChatClientError("not_found")；已归档 →
   * ChatClientError("conflict")。
   */
  history(userId: string, sessionId?: string): Promise<ChatHistory>;
  /**
   * 处理一条用户消息，返回追问或方案列表（含本轮 session_id）。
   * options.sessionId 缺省时为该用户懒建一条新对话（标题取首条消息
   * 前 30 个码点）；给定时校验归属与 active（同上 404/409 分类）。
   * options.signal 在 HTTP 客户端断连（响应未正常完成就关闭）时触发 abort；
   * 实现方可把它传给下游取消规划等耗时工作，也可直接忽略。正常完成的
   * 响应保证不触发 abort。options.location 是本轮前端附带的位置（可选）；
   * options.activePlan 是前端滑块选中方案（可选，仅最近一轮为 comparison
   * 时注入 prompt）；options.referencedEventId 是地图点选活动 id（可选，
   * 查库解析标题/场馆注入，查无忽略）。ChatClientError 由 HTTP 层映射为
   * 404/409；其余异常（模型/数据/内部）统一映射为 500，异常细节不外泄。
   */
  send(
    userId: string,
    message: string,
    options?: {
      signal?: AbortSignal;
      location?: ChatLocation;
      sessionId?: string;
      activePlan?: string;
      referencedEventId?: string;
    },
  ): Promise<ChatResult>;
  /**
   * 近期活动只读查询（GET /api/events）：活动库全局共享、不按 userId
   * 过滤，userId 仅为接口一致性保留（并保证匿名 cookie 照常签发）。
   * date 与 from/to 二选一，都不给时按"今天"（实现方的本地日期）；
   * bbox 为 GCJ-02 包围盒过滤；limit 已由 HTTP 层校验/钳限。
   */
  listEvents(userId: string, query: EventsQuery): Promise<EventsResult>;
  /** 读该用户的长期记忆文档；无记录 → {content:"",updated_at:null}。 */
  getMemory(userId: string): Promise<UserMemoryView>;
  /**
   * 覆盖式更新记忆文档（PUT /api/memory，HTTP 层已按 trim 后
   * 1..8000 字符校验 content）：只换正文，保留既有蒸馏游标。
   */
  putMemory(userId: string, content: string): Promise<UserMemoryView>;
  /** 清除该用户记忆（DELETE /api/memory）；无记录时幂等成功。 */
  deleteMemory(userId: string): Promise<void>;
}

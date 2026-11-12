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
  event_id: string;
  title: string;
  latitude: number;
  longitude: number;
  venue_name: string;
  description?: string;
  category?: string;
  address?: string;
  /** 本地时间 "YYYY-MM-DDTHH:MM"（不带时区），语义同 Event.startAt/endAt。 */
  start_at?: string;
  end_at?: string;
  suggested_duration_minutes?: number;
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
  /** 当前生效行程；尚未形成行程时省略或为 null。 */
  itinerary?: Itinerary | null;
  /** itinerary 各站 event_id 对应的活动详情，供卡片与地图渲染。 */
  events?: EventView[];
}

/** 用户当前位置坐标（GPS/选点），只含坐标不含地名。 */
export interface ChatLocation {
  lat: number;
  lng: number;
}

/**
 * POST /api/chat 接受的请求体形：`{ "message": "…" }`，可附带 location 与
 * session_id。message 必填，按 trim 后长度计须为 1..1000 字；location 可选，
 * 是前端当前选点/GPS 的经纬度（只传坐标不传地名）；session_id 可选，是本页
 * 已建对话的 id——带它继续同一对话，不带则懒建一条新对话。不接受 userId、
 * messages 等任何其他字段——身份只来自服务端签发的 cookie，历史只存服务端。
 */
export interface ChatSendRequest {
  message: string;
  location?: ChatLocation;
  session_id?: string;
}

/** POST /api/chat 成功（200）的响应体：要么追问，要么新行程；session_id 回传本轮对话。 */
export type ChatResult =
  | { kind: "clarification"; session_id: string; question: string }
  | { kind: "itinerary"; session_id: string; itinerary: Itinerary; events: EventView[] };

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
   * 处理一条用户消息，返回追问或新行程（含本轮 session_id）。
   * options.sessionId 缺省时为该用户懒建一条新对话（标题取首条消息
   * 前 30 个码点）；给定时校验归属与 active（同上 404/409 分类）。
   * options.signal 在 HTTP 客户端断连（响应未正常完成就关闭）时触发 abort；
   * 实现方可把它传给下游取消规划等耗时工作，也可直接忽略。正常完成的
   * 响应保证不触发 abort。options.location 是本轮前端附带的位置（可选）。
   * ChatClientError 由 HTTP 层映射为 404/409；其余异常（模型/数据/内部）
   * 统一映射为 500，异常细节不外泄。
   */
  send(
    userId: string,
    message: string,
    options?: { signal?: AbortSignal; location?: ChatLocation; sessionId?: string },
  ): Promise<ChatResult>;
}

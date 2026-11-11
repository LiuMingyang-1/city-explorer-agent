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

/**
 * POST /api/chat 接受的唯一请求体形：`{ "message": "…" }`。
 * message 按 trim 后长度计须为 1..1000 字；不接受 userId、messages 等
 * 任何其他字段——身份只来自服务端签发的 cookie，历史只存服务端。
 */
export interface ChatSendRequest {
  message: string;
}

/** POST /api/chat 成功（200）的响应体：要么追问，要么新行程。 */
export type ChatResult =
  | { kind: "clarification"; question: string }
  | { kind: "itinerary"; itinerary: Itinerary; events: EventView[] };

/** 所有非 2xx 响应的统一错误体形。 */
export interface ChatErrorResponse {
  error: string;
}

/**
 * 可注入的业务服务签名，HTTP 层只面向它编程。
 * userId 是服务端签发的随机匿名 id（见 identity.ts 的安全语义注释）；
 * 实现方负责把同一 userId 下的历史与当前行程关联起来。
 */
export interface ChatService {
  /** 读该用户的历史消息与当前行程/活动。 */
  history(userId: string): Promise<ChatHistory>;
  /**
   * 处理一条用户消息，返回追问或新行程。
   * signal 在 HTTP 客户端断连（响应未正常完成就关闭）时触发 abort；
   * 实现方可把它传给下游取消规划等耗时工作，也可直接忽略。正常完成的
   * 响应保证不触发 abort。实现方只接收两个参数的旧签名依然兼容。
   * 抛错（含模型/数据/内部错误）由 HTTP 层统一映射为 500，异常细节不外泄。
   */
  send(userId: string, message: string, signal?: AbortSignal): Promise<ChatResult>;
}

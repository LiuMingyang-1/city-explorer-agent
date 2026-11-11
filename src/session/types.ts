import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Itinerary, PlanningConstraints } from "../itinerary/types.ts";

/**
 * 会话持久仓库的行类型与 payload 形状（docs/users-and-sessions.md）。
 * TS 侧 camelCase，数据库 snake_case 映射在 impl/context.ts；
 * payload 是 JSON 文本列，解析/校验在 ./payload.ts。
 */

export type SessionKind = "main" | "child";
export type SessionStatus = "active" | "archived";
export type RecordType = "message" | "compaction";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface User {
  userId: string;
  mainSessionId: string | null;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  sessionId: string;
  userId: string;
  kind: SessionKind;
  parentSessionId: string | null;
  title: string | null;
  status: SessionStatus;
  /** 仅 main 会话维护；指向本会话一条带 plan 标注的 assistant 记录。 */
  currentItineraryRecordId: string | null;
  leaseOwner: string | null;
  leaseEpoch: number;
  leaseExpiresAt: string | null;
  /** 最近用户可见活动时间：消息追加/run 状态推进/plan 标注推进，纯压缩不刷它。 */
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  recordId: string;
  sessionId: string;
  /** 日志序号（含 compaction），会话内单调递增。 */
  seq: number;
  type: RecordType;
  /** 消息序号（仅 message 行；compaction 为 null）。与 seq 是两个序列。 */
  messageSeq: number | null;
  /** JSON 文本：MessagePayload（type=message）或 CompactionPayload。 */
  payload: string;
  /** 产生该消息的 run，必须与消息同会话。 */
  runId: string | null;
  /** 消息来源 run（如子任务回传），同用户即可。 */
  sourceRunId: string | null;
  dedupeKey: string | null;
  createdAt: string;
}

export interface Run {
  runId: string;
  userId: string;
  sessionId: string;
  parentRunId: string | null;
  /** 递归树的根 run；无父时等于自身 runId。 */
  rootRunId: string;
  replyToSessionId: string | null;
  status: RunStatus;
  /** JSON 文本：任务目标、约束、必要资料的输入快照。 */
  input: string;
  /** JSON 文本：完成时的结果摘要。 */
  result: string | null;
  error: string | null;
  cancelRequested: boolean;
  /** 预留字段（结果回投时间），本期不实现投递，恒为 null。 */
  deliveredAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** 已通过校验的规划元信息：完整生效约束 + 行程。 */
export interface ValidatedPlan {
  constraints: PlanningConstraints;
  itinerary: Itinerary;
}

/** type='message' 记录的 payload；plan 只允许经 commitValidatedPlan 附加。 */
export interface MessagePayload {
  message: AgentMessage;
  plan?: ValidatedPlan;
}

/** type='compaction' 记录的 payload；字段名保持 snake_case，与文档示例一致。 */
export interface CompactionPayload {
  /** 非空摘要文本。 */
  summary: string;
  /** 生成摘要时看到的最大 message_seq；提交时必须等于当时最大 message_seq。 */
  source_through_message_seq: number;
  /** 仍重放原文的起点 message_seq；空尾部 = 当时最大 message_seq + 1。 */
  first_kept_message_seq: number;
  tokens_before?: number;
  tokens_after?: number;
  model_ref?: string;
  usage?: unknown;
}

/** 会话级写操作的凭证：acquireLease 返回，写方法携带以证明持有租约。 */
export interface LeaseWriter {
  owner: string;
  epoch: number;
}

export interface CreateUserInput {
  /** 缺省生成 UUID；传已存在的 userId 时幂等返回既有用户。 */
  userId?: string;
  displayName?: string;
}

export interface CreateChildSessionInput {
  /** 父会话，必须与 child 同用户；递归时指向直接父会话。 */
  parentSessionId: string;
  title?: string;
}

export interface AppendMessageInput {
  payload: MessagePayload;
  /** 产生该消息的 run；必须属于本 session。 */
  runId?: string;
  /** 来源 run（子任务回传）；同用户即可。 */
  sourceRunId?: string;
  /** 会话内唯一；撞键且内容一致时幂等返回既有记录，内容不同则拒绝。 */
  dedupeKey?: string;
}

export interface AppendCompactionInput {
  payload: CompactionPayload;
  dedupeKey?: string;
}

export interface CreateRunInput {
  /** 本 run 执行的会话（上下文边界），租约也校验在它上面。 */
  sessionId: string;
  /** JSON 可序列化的输入快照。 */
  input: unknown;
  /** 派出本 run 的父 run；必须同用户。 */
  parentRunId?: string;
  /** 结果投递目标会话；必须同用户。 */
  replyToSessionId?: string;
  /** true 时创建即 running（原子安排），startedAt 同时写入；缺省 queued。 */
  startImmediately?: boolean;
}

export type RunFinishOutcome =
  | { status: "completed"; result?: unknown }
  | { status: "failed"; error: string }
  | { status: "cancelled"; error?: string };

/** latestCompaction 的返回：记录本体 + 已解析并通过边界校验的 payload。 */
export interface ValidatedCompaction {
  record: SessionRecord;
  payload: CompactionPayload;
}

export interface CurrentItinerary {
  record: SessionRecord;
  plan: ValidatedPlan;
}

export type SessionErrorCode =
  | "cross_user" // 写路径归属校验失败（session/record/run/parent/reply 跨用户）
  | "not_found" // 引用实体不存在，或读路径的会话不属于该用户
  | "lease_lost" // 租约 owner/epoch 不符、已过期或会话无可写租约
  | "archived" // 归档会话的写/租约操作
  | "conflict" // dedupe 撞键内容不同、指针回退、run 归属到错误会话等
  | "invalid_state" // 非法状态推进（终态覆盖、无请求的 cancelled 等）
  | "invalid_payload" // 调用方传入的 payload/参数结构非法
  | "corrupt"; // 库内已存数据未过读边界校验

export class SessionRepositoryError extends Error {
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode, message: string) {
    super(message);
    this.name = "SessionRepositoryError";
    this.code = code;
  }
}

export function isSessionError(
  error: unknown,
  code?: SessionErrorCode,
): error is SessionRepositoryError {
  return (
    error instanceof SessionRepositoryError && (code === undefined || error.code === code)
  );
}

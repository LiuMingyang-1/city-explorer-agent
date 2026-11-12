import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureSessionSchema } from "../schema.ts";
import {
  SessionRepositoryError,
  type LeaseWriter,
  type Run,
  type Session,
  type SessionRecord,
  type SessionKind,
  type SessionStatus,
  type RecordType,
  type RunStatus,
  type User,
  type UserMemory,
} from "../types.ts";

/**
 * SQLite 会话库的连接上下文与行映射。所有写路径在 BEGIN IMMEDIATE
 * 事务内做"取行 → 校验 → 写入"，靠 IMMEDIATE 锁保证同库多连接下
 * 校验与写入之间不被插入。
 */

export interface SessionDbContext {
  db: DatabaseSync;
  nowIso(): string;
  nowPlus(ttlMs: number): string;
}

/** 打开（必要时创建）会话库：WAL、外键、busy_timeout，幂等建表。 */
export function openSessionDb(dbPath: string, clock: () => Date): SessionDbContext {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  ensureSessionSchema(db);
  return {
    db,
    nowIso: () => clock().toISOString(),
    nowPlus: (ttlMs) => new Date(clock().getTime() + ttlMs).toISOString(),
  };
}

/** 单事务执行；write=true 取 IMMEDIATE 写锁，失败回滚并原样抛出。 */
export function tx<T>(ctx: SessionDbContext, write: boolean, fn: () => T): T {
  ctx.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = fn();
    ctx.db.exec("COMMIT");
    return result;
  } catch (error) {
    ctx.db.exec("ROLLBACK");
    throw error;
  }
}

// ---- 行类型与映射（snake_case 列 → camelCase） ----

export type UserRow = {
  user_id: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
};

export type SessionRow = {
  session_id: string;
  user_id: string;
  kind: SessionKind;
  parent_session_id: string | null;
  title: string | null;
  status: SessionStatus;
  current_itinerary_record_id: string | null;
  lease_owner: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
};

export type RecordRow = {
  record_id: string;
  session_id: string;
  seq: number;
  type: RecordType;
  message_seq: number | null;
  payload: string;
  run_id: string | null;
  source_run_id: string | null;
  dedupe_key: string | null;
  created_at: string;
};

export type RunRow = {
  run_id: string;
  user_id: string;
  session_id: string;
  parent_run_id: string | null;
  root_run_id: string;
  reply_to_session_id: string | null;
  status: RunStatus;
  input: string;
  result: string | null;
  error: string | null;
  cancel_requested: number;
  delivered_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export const toUser = (row: UserRow): User => ({
  userId: row.user_id,
  displayName: row.display_name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toSession = (row: SessionRow): Session => ({
  sessionId: row.session_id,
  userId: row.user_id,
  kind: row.kind,
  parentSessionId: row.parent_session_id,
  title: row.title,
  status: row.status,
  currentItineraryRecordId: row.current_itinerary_record_id,
  leaseOwner: row.lease_owner,
  leaseEpoch: row.lease_epoch,
  leaseExpiresAt: row.lease_expires_at,
  lastActivityAt: row.last_activity_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toRecord = (row: RecordRow): SessionRecord => ({
  recordId: row.record_id,
  sessionId: row.session_id,
  seq: row.seq,
  type: row.type,
  messageSeq: row.message_seq,
  payload: row.payload,
  runId: row.run_id,
  sourceRunId: row.source_run_id,
  dedupeKey: row.dedupe_key,
  createdAt: row.created_at,
});

export const toRun = (row: RunRow): Run => ({
  runId: row.run_id,
  userId: row.user_id,
  sessionId: row.session_id,
  parentRunId: row.parent_run_id,
  rootRunId: row.root_run_id,
  replyToSessionId: row.reply_to_session_id,
  status: row.status,
  input: row.input,
  result: row.result,
  error: row.error,
  cancelRequested: row.cancel_requested === 1,
  deliveredAt: row.delivered_at,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export type UserMemoryRow = {
  user_id: string;
  content: string;
  source_session_id: string | null;
  through_message_seq: number;
  updated_at: string;
};

export const toUserMemory = (row: UserMemoryRow): UserMemory => ({
  userId: row.user_id,
  content: row.content,
  sourceSessionId: row.source_session_id,
  throughMessageSeq: row.through_message_seq,
  updatedAt: row.updated_at,
});

// ---- 共享取行与归属/租约断言 ----

export function fetchUser(ctx: SessionDbContext, userId: string): UserRow | undefined {
  return ctx.db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as
    | UserRow
    | undefined;
}

export function fetchSession(ctx: SessionDbContext, sessionId: string): SessionRow | undefined {
  return ctx.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as
    | SessionRow
    | undefined;
}

export function fetchRun(ctx: SessionDbContext, runId: string): RunRow | undefined {
  return ctx.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | undefined;
}

export function fetchRecord(ctx: SessionDbContext, recordId: string): RecordRow | undefined {
  return ctx.db.prepare("SELECT * FROM session_records WHERE record_id = ?").get(recordId) as
    | RecordRow
    | undefined;
}

/** 读路径范围校验：会话不存在或不属于该用户一律 not_found（不区分泄露）。 */
export function assertSessionScope(
  ctx: SessionDbContext,
  userId: string,
  sessionId: string,
): SessionRow {
  const row = fetchSession(ctx, sessionId);
  if (!row) throw new SessionRepositoryError("not_found", `会话 ${sessionId} 不存在`);
  if (row.user_id !== userId) {
    throw new SessionRepositoryError("not_found", `会话 ${sessionId} 不存在`);
  }
  return row;
}

/**
 * 写路径校验（须在写事务内调用）：存在性 → 用户归属 → active → 租约。
 * 过期但未被抢占的租约同样拒绝写（expires_at < now 即失效）。
 */
export function assertWritableSession(
  ctx: SessionDbContext,
  userId: string,
  sessionId: string,
  writer: LeaseWriter,
): SessionRow {
  const row = fetchSession(ctx, sessionId);
  if (!row) throw new SessionRepositoryError("not_found", `会话 ${sessionId} 不存在`);
  if (row.user_id !== userId) {
    throw new SessionRepositoryError("cross_user", `会话 ${sessionId} 不属于用户 ${userId}`);
  }
  if (row.status !== "active") {
    throw new SessionRepositoryError("archived", `会话 ${sessionId} 已归档，拒绝写入`);
  }
  if (row.lease_owner !== writer.owner || row.lease_epoch !== writer.epoch) {
    throw new SessionRepositoryError(
      "lease_lost",
      `会话 ${sessionId} 的写租约已由 (owner=${row.lease_owner ?? "无"}, epoch=${row.lease_epoch}) 接管`,
    );
  }
  if (row.lease_expires_at === null || row.lease_expires_at < ctx.nowIso()) {
    throw new SessionRepositoryError("lease_lost", `会话 ${sessionId} 的写租约已过期`);
  }
  return row;
}

/** 追加/更新会话活动的统一写法（last_activity_at 由调用方决定是否推进）。 */
export function touchSession(
  ctx: SessionDbContext,
  sessionId: string,
  bumpActivity: boolean,
): void {
  const now = ctx.nowIso();
  if (bumpActivity) {
    ctx.db
      .prepare("UPDATE sessions SET last_activity_at = ?, updated_at = ? WHERE session_id = ?")
      .run(now, now, sessionId);
  } else {
    ctx.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?")
      .run(now, sessionId);
  }
}

/** SQLite 唯一约束冲突判定（node:sqlite 的错误消息含列名）。 */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

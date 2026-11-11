import { randomUUID } from "node:crypto";
import {
  SessionRepositoryError,
  type CreateChildSessionInput,
  type CreateUserInput,
  type LeaseWriter,
  type Session,
  type User,
} from "../types.ts";
import {
  assertWritableSession,
  fetchSession,
  fetchUser,
  isUniqueViolation,
  toSession,
  toUser,
  touchSession,
  tx,
  type SessionDbContext,
  type SessionRow,
} from "./context.ts";

/**
 * users / sessions / 租约。所有方法假定由 sqlite.ts 包成 async 调用。
 */

export function createUser(ctx: SessionDbContext, input: CreateUserInput): User {
  const userId = input.userId ?? randomUUID();
  const create = (): User =>
    tx(ctx, true, () => {
      const existing = fetchUser(ctx, userId);
      if (existing) return toUser(existing);
      const now = ctx.nowIso();
      const sessionId = randomUUID();
      ctx.db
        .prepare(
          "INSERT INTO users (user_id, main_session_id, display_name, created_at, updated_at) VALUES (?, NULL, ?, ?, ?)",
        )
        .run(userId, input.displayName ?? null, now, now);
      ctx.db
        .prepare(
          `INSERT INTO sessions (session_id, user_id, kind, parent_session_id, title, status,
             current_itinerary_record_id, lease_owner, lease_epoch, lease_expires_at,
             last_activity_at, created_at, updated_at)
           VALUES (?, ?, 'main', NULL, NULL, 'active', NULL, NULL, 0, NULL, ?, ?, ?)`,
        )
        .run(sessionId, userId, now, now, now);
      ctx.db
        .prepare("UPDATE users SET main_session_id = ? WHERE user_id = ?")
        .run(sessionId, userId);
      return toUser(fetchUser(ctx, userId) as NonNullable<ReturnType<typeof fetchUser>>);
    });
  try {
    return create();
  } catch (error) {
    // 另一连接抢先初始化同一 userId：唯一冲突时按幂等返回既有用户。
    if (isUniqueViolation(error)) {
      const user = fetchUser(ctx, userId);
      if (user) return toUser(user);
    }
    throw error;
  }
}

export function getUser(ctx: SessionDbContext, userId: string): User | undefined {
  const row = fetchUser(ctx, userId);
  return row ? toUser(row) : undefined;
}

export function getMainSession(ctx: SessionDbContext, userId: string): Session {
  return tx(ctx, false, () => {
    const user = fetchUser(ctx, userId);
    if (!user) throw new SessionRepositoryError("not_found", `用户 ${userId} 不存在`);
    if (user.main_session_id === null) {
      throw new SessionRepositoryError("corrupt", `用户 ${userId} 未绑定主会话`);
    }
    const session = fetchSession(ctx, user.main_session_id);
    if (!session || session.kind !== "main" || session.user_id !== userId) {
      throw new SessionRepositoryError("corrupt", `用户 ${userId} 的主会话指针非法`);
    }
    return toSession(session);
  });
}

export function getSession(
  ctx: SessionDbContext,
  userId: string,
  sessionId: string,
): Session | undefined {
  const row = fetchSession(ctx, sessionId);
  if (!row || row.user_id !== userId) return undefined;
  return toSession(row);
}

export function listSessions(ctx: SessionDbContext, userId: string): Session[] {
  const rows = ctx.db
    .prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY last_activity_at DESC, session_id")
    .all(userId) as SessionRow[];
  return rows.map(toSession);
}

export function createChildSession(
  ctx: SessionDbContext,
  writer: LeaseWriter,
  userId: string,
  input: CreateChildSessionInput,
): Session {
  return tx(ctx, true, () => {
    assertWritableSession(ctx, userId, input.parentSessionId, writer);
    const now = ctx.nowIso();
    const sessionId = randomUUID();
    ctx.db
      .prepare(
        `INSERT INTO sessions (session_id, user_id, kind, parent_session_id, title, status,
           current_itinerary_record_id, lease_owner, lease_epoch, lease_expires_at,
           last_activity_at, created_at, updated_at)
         VALUES (?, ?, 'child', ?, ?, 'active', NULL, NULL, 0, NULL, ?, ?, ?)`,
      )
      .run(sessionId, userId, input.parentSessionId, input.title ?? null, now, now, now);
    touchSession(ctx, input.parentSessionId, true);
    return toSession(fetchSession(ctx, sessionId) as SessionRow);
  });
}

export function archiveSession(
  ctx: SessionDbContext,
  writer: LeaseWriter,
  userId: string,
  sessionId: string,
): void {
  return tx(ctx, true, () => {
    const row = assertWritableSession(ctx, userId, sessionId, writer);
    if (row.kind === "main") {
      throw new SessionRepositoryError("conflict", `主会话 ${sessionId} 不可归档`);
    }
    ctx.db
      .prepare(
        `UPDATE sessions SET status = 'archived', lease_owner = NULL,
           lease_expires_at = NULL, updated_at = ? WHERE session_id = ?`,
      )
      .run(ctx.nowIso(), sessionId);
  });
}

// ---- 单写者租约 ----

export function acquireLease(
  ctx: SessionDbContext,
  userId: string,
  sessionId: string,
  owner: string,
  ttlMs: number,
): LeaseWriter | undefined {
  return tx(ctx, true, () => {
    const row = fetchSession(ctx, sessionId);
    if (!row) throw new SessionRepositoryError("not_found", `会话 ${sessionId} 不存在`);
    if (row.user_id !== userId) {
      throw new SessionRepositoryError("cross_user", `会话 ${sessionId} 不属于用户 ${userId}`);
    }
    if (row.status !== "active") {
      throw new SessionRepositoryError("archived", `会话 ${sessionId} 已归档，不能获取租约`);
    }
    const now = ctx.nowIso();
    const heldByOther =
      row.lease_owner !== null &&
      row.lease_owner !== owner &&
      row.lease_expires_at !== null &&
      row.lease_expires_at >= now;
    if (heldByOther) return undefined;
    const epoch = row.lease_epoch + 1;
    ctx.db
      .prepare(
        `UPDATE sessions SET lease_owner = ?, lease_epoch = ?, lease_expires_at = ?, updated_at = ?
         WHERE session_id = ?`,
      )
      .run(owner, epoch, ctx.nowPlus(ttlMs), now, sessionId);
    return { owner, epoch };
  });
}

export function renewLease(
  ctx: SessionDbContext,
  writer: LeaseWriter,
  userId: string,
  sessionId: string,
  ttlMs: number,
): boolean {
  return tx(ctx, true, () => {
    const row = fetchSession(ctx, sessionId);
    if (!row) throw new SessionRepositoryError("not_found", `会话 ${sessionId} 不存在`);
    if (row.user_id !== userId) {
      throw new SessionRepositoryError("cross_user", `会话 ${sessionId} 不属于用户 ${userId}`);
    }
    const now = ctx.nowIso();
    const held =
      row.lease_owner === writer.owner &&
      row.lease_epoch === writer.epoch &&
      row.lease_expires_at !== null &&
      row.lease_expires_at >= now;
    if (!held) return false;
    ctx.db
      .prepare("UPDATE sessions SET lease_expires_at = ?, updated_at = ? WHERE session_id = ?")
      .run(ctx.nowPlus(ttlMs), now, sessionId);
    return true;
  });
}

export function releaseLease(
  ctx: SessionDbContext,
  writer: LeaseWriter,
  userId: string,
  sessionId: string,
): void {
  return tx(ctx, true, () => {
    const row = fetchSession(ctx, sessionId);
    if (!row) throw new SessionRepositoryError("not_found", `会话 ${sessionId} 不存在`);
    if (row.user_id !== userId) {
      throw new SessionRepositoryError("cross_user", `会话 ${sessionId} 不属于用户 ${userId}`);
    }
    // WHERE 携带 owner+epoch：只能释放自己这一代，不会误清已易主的租约。
    ctx.db
      .prepare(
        `UPDATE sessions SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE session_id = ? AND lease_owner = ? AND lease_epoch = ?`,
      )
      .run(ctx.nowIso(), sessionId, writer.owner, writer.epoch);
  });
}

import {
  SessionRepositoryError,
  type PutUserMemoryInput,
  type UserMemory,
} from "../types.ts";
import {
  fetchUser,
  toUserMemory,
  tx,
  type SessionDbContext,
  type UserMemoryRow,
} from "./context.ts";

/**
 * user_memory 读写：每用户一行的长期记忆文档 + 蒸馏游标。
 * 用户级方法，不走 LeaseWriter——蒸馏是会话 close 时的机会性写入，
 * 触发方并不持有会话租约（guard.run 每个 op 结束即放租约）：两个实例
 * 并发 close 最坏 last-writer-wins；upsert 把 content 与游标作为一致对
 * 原子写入、不会撕裂，v1 接受这个边界。
 * content 是整篇 markdown，存储层不解析其小节结构。
 */

/** content 存储硬上限（字符）；system 注入侧另有更小的截断（context.ts）。 */
const MAX_MEMORY_CONTENT_CHARS = 8_000;

/** 含墓碑的原始读：蒸馏 CAS 基线与手工 PUT 游标保留用。 */
export function getUserMemoryRaw(
  ctx: SessionDbContext,
  userId: string,
): UserMemory | undefined {
  const row = ctx.db.prepare("SELECT * FROM user_memory WHERE user_id = ?").get(userId) as
    | UserMemoryRow
    | undefined;
  return row ? toUserMemory(row) : undefined;
}

export function getUserMemory(
  ctx: SessionDbContext,
  userId: string,
): UserMemory | undefined {
  const memory = getUserMemoryRaw(ctx, userId);
  // content="" 是 DELETE 留下的墓碑行（合法正文非空，"" 只可能是墓碑）：
  // 对读路径按"无记忆"处理，行保留是为了让 version/游标留痕供 CAS。
  return memory && memory.content !== "" ? memory : undefined;
}

export function putUserMemory(
  ctx: SessionDbContext,
  userId: string,
  input: PutUserMemoryInput,
): void {
  if (
    typeof input.content !== "string" ||
    input.content.length === 0 ||
    input.content.length > MAX_MEMORY_CONTENT_CHARS
  ) {
    throw new SessionRepositoryError(
      "invalid_payload",
      `user_memory.content 必须是非空且 ≤${MAX_MEMORY_CONTENT_CHARS} 字符的字符串`,
    );
  }
  if (!Number.isInteger(input.throughMessageSeq) || input.throughMessageSeq < 0) {
    throw new SessionRepositoryError(
      "invalid_payload",
      "user_memory.throughMessageSeq 必须是非负整数",
    );
  }
  if (input.sourceSessionId !== null && typeof input.sourceSessionId !== "string") {
    throw new SessionRepositoryError(
      "invalid_payload",
      "user_memory.sourceSessionId 必须是字符串或 null",
    );
  }
  return tx(ctx, true, () => {
    if (!fetchUser(ctx, userId)) {
      throw new SessionRepositoryError("not_found", `用户 ${userId} 不存在`);
    }
    // 版本 CAS：与手工 PUT/DELETE 竞争时放弃写入（检查与写同事务）。
    // 用 version 而非正文比对——删除墓碑、删后同文重写都能检出。
    if (input.expectedVersion !== undefined) {
      const row = ctx.db
        .prepare("SELECT version FROM user_memory WHERE user_id = ?")
        .get(userId) as { version: number } | undefined;
      if ((row?.version ?? 0) !== input.expectedVersion) {
        throw new SessionRepositoryError(
          "conflict",
          "user_memory 已被并发修改，本次写入放弃",
        );
      }
    }
    ctx.db
      .prepare(
        `INSERT INTO user_memory (user_id, content, source_session_id, through_message_seq, version, updated_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           content = excluded.content,
           source_session_id = excluded.source_session_id,
           through_message_seq = excluded.through_message_seq,
           version = user_memory.version + 1,
           updated_at = excluded.updated_at`,
      )
      .run(
        userId,
        input.content,
        input.sourceSessionId,
        input.throughMessageSeq,
        ctx.nowIso(),
      );
  });
}

/**
 * 删除该用户的记忆：写墓碑行而不是物理删行——行保留使 version 继续
 * 单调递增，在途蒸馏的 expectedVersion CAS 能检出"蒸馏期间被删"而不
 * 复活旧文；蒸馏游标原样保留——已蒸过的消息不应因手工删除被重新蒸
 * 馏、把刚删掉的偏好推导回来。墓碑 content="" 由 getUserMemory 过滤
 * 为无记忆；幂等照旧（重复删只推版本，用户不存在仍 no-op 保外键）。
 */
export function deleteUserMemory(ctx: SessionDbContext, userId: string): void {
  return tx(ctx, true, () => {
    if (!fetchUser(ctx, userId)) return;
    ctx.db
      .prepare(
        `INSERT INTO user_memory (user_id, content, source_session_id, through_message_seq, version, updated_at)
         VALUES (?, '', NULL, 0, 1, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           content = '',
           version = user_memory.version + 1,
           updated_at = excluded.updated_at`,
      )
      .run(userId, ctx.nowIso());
  });
}

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

export function getUserMemory(
  ctx: SessionDbContext,
  userId: string,
): UserMemory | undefined {
  const row = ctx.db.prepare("SELECT * FROM user_memory WHERE user_id = ?").get(userId) as
    | UserMemoryRow
    | undefined;
  return row ? toUserMemory(row) : undefined;
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
    ctx.db
      .prepare(
        `INSERT INTO user_memory (user_id, content, source_session_id, through_message_seq, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           content = excluded.content,
           source_session_id = excluded.source_session_id,
           through_message_seq = excluded.through_message_seq,
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
 * 删除该用户的记忆行（含蒸馏游标）。幂等：行不存在（从未写过或已删过、
 * 用户本身不存在）时静默 no-op——DELETE /api/memory 的"清除即成功"
 * 语义由这里保证，调用方无需先查存在性。
 */
export function deleteUserMemory(ctx: SessionDbContext, userId: string): void {
  ctx.db.prepare("DELETE FROM user_memory WHERE user_id = ?").run(userId);
}

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
 * 用户级方法，不走 LeaseWriter——蒸馏由会话租约持有方触发，天然串行。
 * content 是整篇 markdown，存储层不解析其小节结构。
 */

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

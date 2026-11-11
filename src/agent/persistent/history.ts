import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { parseStoredMessagePayload } from "../../session/payload.ts";
import type { SessionRecord } from "../../session/types.ts";
import { SessionRepositoryError } from "../../session/types.ts";

/** raw 中每条原始消息的持久化坐标（对象同一性索引，不靠深比较）。 */
export interface RawMeta {
  recordId: string;
  messageSeq: number;
  runId: string | null;
}

/**
 * 会话原始消息存储：raw 只含原始消息（不含 system/摘要/注入消息），
 * 与 session_records 的 message 行一一对应；meta 维护
 * 消息对象 → record_id/message_seq 的单向映射。
 * compact() 用 raw.indexOf 依赖对象同一性，projectHistory 复用同对象
 * 引用切有效尾部，所以这里只入/只追加同一个对象，绝不重建。
 */
export class RawHistory {
  /** 全部原始消息（无 system/摘要），按 message_seq 升序。 */
  readonly raw: AgentMessage[] = [];
  private readonly meta = new Map<AgentMessage, RawMeta>();
  private maxSeq = 0;

  get maxMessageSeq(): number {
    return this.maxSeq;
  }

  /** 落库消息 → raw 索引；payload 只解析一次，供重载路径使用。 */
  indexStored(record: SessionRecord): AgentMessage {
    const { message } = parseStoredMessagePayload(record.payload, `记录 ${record.recordId}`);
    this.index(message, record);
    return message;
  }

  /** 本轮刚写库成功的消息 → 用原对象入索引（保持对象同一性）。 */
  indexLive(message: AgentMessage, record: SessionRecord): void {
    this.index(message, record);
  }

  private index(message: AgentMessage, record: SessionRecord): void {
    const messageSeq = record.messageSeq as number;
    this.raw.push(message);
    this.meta.set(message, {
      recordId: record.recordId,
      messageSeq,
      runId: record.runId,
    });
    this.maxSeq = Math.max(this.maxSeq, messageSeq);
  }

  metaOf(message: AgentMessage): RawMeta | undefined {
    return this.meta.get(message);
  }

  /** run_id → 该 run 已落库消息的最大 message_seq；无 run 关联的消息不计。 */
  maxSeqByRun(): Map<string, number> {
    const map = new Map<string, number>();
    for (const meta of this.meta.values()) {
      if (meta.runId === null) continue;
      const prev = map.get(meta.runId);
      if (prev === undefined || meta.messageSeq > prev) map.set(meta.runId, meta.messageSeq);
    }
    return map;
  }

  messageSeqOf(message: AgentMessage): number | undefined {
    return this.meta.get(message)?.messageSeq;
  }

  /** first_kept_message_seq → raw 一基序号（空尾部 = raw.length + 1）。 */
  ordinalFor(firstKeptSeq: number): number {
    for (let i = 0; i < this.raw.length; i++) {
      if (this.meta.get(this.raw[i])?.messageSeq === firstKeptSeq) return i + 1;
    }
    if (firstKeptSeq > this.maxSeq) return this.raw.length + 1;
    throw new SessionRepositoryError(
      "corrupt",
      `检查点边界 first_kept_message_seq=${firstKeptSeq} 在会话消息中找不到`,
    );
  }
}

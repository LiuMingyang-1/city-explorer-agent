import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  isSuccessfulAssistant,
  parseStoredCompactionPayload,
  parseStoredMessagePayload,
  parseStoredPlan,
  serializeCompactionPayload,
  serializeMessagePayload,
  toolCallIds,
  assertValidPlan,
} from "../payload.ts";
import {
  SessionRepositoryError,
  type AppendCompactionInput,
  type AppendMessageInput,
  type CompactionPayload,
  type CurrentItinerary,
  type LeaseWriter,
  type SessionRecord,
  type ValidatedCompaction,
  type ValidatedPlan,
} from "../types.ts";
import {
  assertSessionScope,
  assertWritableSession,
  fetchRecord,
  fetchRun,
  toRecord,
  touchSession,
  tx,
  type RecordRow,
  type SessionDbContext,
} from "./context.ts";

/**
 * session_records 读写与压缩检查点校验。
 * 检查点一律按"它写入时的记录前缀"（seq 更小的记录）校验，
 * 而不是按最终全历史——这样老检查点不会被后来的消息误判。
 */

type MessageRole = "user" | "assistant" | "toolResult";

/** 一次工具调用 → 对应 toolResult 的 message_seq 区间；边界落在 (callSeq, resultSeq] 内即切断批次。 */
interface ToolCallSpan {
  id: string;
  callSeq: number;
  resultSeq: number;
}

interface LogScan {
  maxSeq: number;
  messageCount: number;
  minMessageSeq: number | null;
  maxMessageSeq: number | null;
  roleByMessageSeq: Map<number, MessageRole>;
  toolCallIds: Set<string>;
  /** toolCallId → 最近一次 assistant 调用的 message_seq（含已闭环）。 */
  latestCallSeq: Map<string, number>;
  /** toolCallId → 尚未等到 toolResult 的调用 message_seq；结果消除、同 id 再调用覆盖。 */
  openCallSeqs: Map<string, number>;
  /** 已闭环的 调用→结果 区间（含绑定到最近调用的多余结果）。 */
  toolCallSpans: ToolCallSpan[];
  latest: ValidatedCompaction | undefined;
}

type CheckpointFail = (message: string) => never;
const corruptFail: CheckpointFail = (message) => {
  throw new SessionRepositoryError("corrupt", message);
};
const conflictFail: CheckpointFail = (message) => {
  throw new SessionRepositoryError("conflict", message);
};

/** 用日志前缀状态校验一条 compaction payload；fail 决定错误码（读=corrupt，写=conflict）。 */
function checkCheckpoint(
  payload: CompactionPayload,
  scan: LogScan,
  previousFirstKept: number | undefined,
  context: string,
  fail: CheckpointFail,
): void {
  if (scan.minMessageSeq === null || scan.maxMessageSeq === null) {
    fail(`${context}：压缩检查点前没有任何消息记录`);
  }
  const { minMessageSeq, maxMessageSeq } = scan as { minMessageSeq: number; maxMessageSeq: number };
  if (payload.source_through_message_seq !== maxMessageSeq) {
    fail(
      `${context}：source_through_message_seq=${payload.source_through_message_seq} ` +
        `与提交时已有最大 message_seq=${maxMessageSeq} 不一致`,
    );
  }
  const first = payload.first_kept_message_seq;
  if (first < minMessageSeq + 1 || first > maxMessageSeq + 1) {
    fail(
      `${context}：first_kept_message_seq=${first} 超出合法边界 ` +
        `[${minMessageSeq + 1}, ${maxMessageSeq + 1}]`,
    );
  }
  // 边界不得切在工具批次中间：first_kept 指向的消息不能是 toolResult。
  if (first <= maxMessageSeq && scan.roleByMessageSeq.get(first) === "toolResult") {
    fail(`${context}：first_kept_message_seq=${first} 指向 toolResult，切断工具批次`);
  }
  // 更一般地，边界不得越过任何尚未闭环的工具调用头：其 toolResult
  // （含中断补齐/未来补写的）的 message_seq 必然落在 first_kept 之后，
  // 保留区会出现没有对应调用的 toolResult。未完成批次只能整体保留
  // （first_kept <= 该 assistant 头），或等结果到齐后再跨过。
  for (const [callId, callSeq] of scan.openCallSeqs) {
    if (callSeq < first) {
      fail(
        `${context}：first_kept_message_seq=${first} 越过未闭环工具调用 ${callId}` +
          `（assistant message_seq=${callSeq}），其结果只能落在边界之后`,
      );
    }
  }
  // 已闭环批次同样不得被切开：边界落在 (调用, 结果] 区间内即非法，
  // 即使它指向的不是 toolResult（如夹在批次中间的 user 消息）。
  for (const span of scan.toolCallSpans) {
    if (span.callSeq < first && first <= span.resultSeq) {
      fail(
        `${context}：first_kept_message_seq=${first} 切断工具批次` +
          `（toolCallId=${span.id}：assistant ${span.callSeq} → toolResult ${span.resultSeq}）`,
      );
    }
  }
  if (previousFirstKept !== undefined && first < previousFirstKept) {
    fail(`${context}：first_kept_message_seq=${first} 回退到上一检查点边界 ${previousFirstKept} 之前`);
  }
}

/**
 * 按 seq 扫描整段日志：解析全部 payload、拒孤立 toolResult、逐条校验
 * 检查点（任何非法已存记录抛 corrupt）。返回尾部统计与最新合法检查点。
 */
function scanSessionLog(rows: RecordRow[]): LogScan {
  const scan: LogScan = {
    maxSeq: 0,
    messageCount: 0,
    minMessageSeq: null,
    maxMessageSeq: null,
    roleByMessageSeq: new Map(),
    toolCallIds: new Set(),
    latestCallSeq: new Map(),
    openCallSeqs: new Map(),
    toolCallSpans: [],
    latest: undefined,
  };
  let previousFirstKept: number | undefined;
  for (const row of rows) {
    const context = `记录 ${row.record_id}（seq=${row.seq}）`;
    scan.maxSeq = row.seq;
    if (row.type === "message") {
      const message = parseStoredMessagePayload(row.payload, context).message;
      const seq = row.message_seq as number;
      scan.messageCount += 1;
      if (scan.minMessageSeq === null) scan.minMessageSeq = seq;
      scan.maxMessageSeq = seq;
      scan.roleByMessageSeq.set(seq, message.role as MessageRole);
      if (message.role === "assistant") {
        for (const id of toolCallIds(message)) {
          scan.toolCallIds.add(id);
          scan.latestCallSeq.set(id, seq);
          // 同 id 再调用按新批次头记（与运行时 closeInterrupted 按 id 记账一致）；
          // 此前同 id 的未闭环调用随覆盖不再计入待闭环。
          scan.openCallSeqs.set(id, seq);
        }
      } else if (message.role === "toolResult") {
        if (!scan.toolCallIds.has(message.toolCallId)) {
          corruptFail(`${context}：toolResult(toolCallId=${message.toolCallId}) 无对应 assistant 调用`);
        }
        // 闭环区间绑定最新未闭环调用；id 已知但无未闭环调用（重复/多余
        // 结果）退回该 id 最近一次调用，使越过它的边界同样被切断判定覆盖。
        const callSeq =
          scan.openCallSeqs.get(message.toolCallId) ??
          (scan.latestCallSeq.get(message.toolCallId) as number);
        scan.openCallSeqs.delete(message.toolCallId);
        scan.toolCallSpans.push({ id: message.toolCallId, callSeq, resultSeq: seq });
      }
      continue;
    }
    const payload = parseStoredCompactionPayload(row.payload, context);
    checkCheckpoint(payload, scan, previousFirstKept, context, corruptFail);
    previousFirstKept = payload.first_kept_message_seq;
    scan.latest = { record: toRecord(row), payload };
  }
  return scan;
}

function listRecordRows(ctx: SessionDbContext, sessionId: string): RecordRow[] {
  return ctx.db
    .prepare("SELECT * FROM session_records WHERE session_id = ? ORDER BY seq")
    .all(sessionId) as RecordRow[];
}

function dedupeHit(
  ctx: SessionDbContext,
  sessionId: string,
  dedupeKey: string,
): RecordRow | undefined {
  return ctx.db
    .prepare("SELECT * FROM session_records WHERE session_id = ? AND dedupe_key = ?")
    .get(sessionId, dedupeKey) as RecordRow | undefined;
}

function checkRunRefs(
  ctx: SessionDbContext,
  userId: string,
  sessionId: string,
  runId: string | undefined,
  sourceRunId: string | undefined,
): void {
  if (runId !== undefined) {
    const run = fetchRun(ctx, runId);
    if (!run) throw new SessionRepositoryError("not_found", `run ${runId} 不存在`);
    if (run.session_id !== sessionId) {
      throw new SessionRepositoryError("conflict", `run ${runId} 不属于会话 ${sessionId}`);
    }
  }
  if (sourceRunId !== undefined) {
    const run = fetchRun(ctx, sourceRunId);
    if (!run) throw new SessionRepositoryError("not_found", `来源 run ${sourceRunId} 不存在`);
    if (run.user_id !== userId) {
      throw new SessionRepositoryError("cross_user", `来源 run ${sourceRunId} 不属于用户 ${userId}`);
    }
  }
}

export function appendMessage(
  ctx: SessionDbContext,
  writer: LeaseWriter,
  userId: string,
  sessionId: string,
  input: AppendMessageInput,
): SessionRecord {
  return tx(ctx, true, () => {
    assertWritableSession(ctx, userId, sessionId, writer);
    const serialized = serializeMessagePayload(input.payload);
    if (input.dedupeKey !== undefined) {
      const existing = dedupeHit(ctx, sessionId, input.dedupeKey);
      if (existing) {
        const sameMessage =
          existing.type === "message" &&
          canonicalJson(parseStoredMessagePayload(existing.payload, `记录 ${existing.record_id}`).message) ===
            canonicalJson(input.payload.message);
        const sameRefs =
          existing.run_id === (input.runId ?? null) &&
          existing.source_run_id === (input.sourceRunId ?? null);
        // 撞键且内容一致 → 幂等返回；内容不同 → 拒绝，不无声重用不相关记录。
        if (sameMessage && sameRefs) return toRecord(existing);
        throw new SessionRepositoryError(
          "conflict",
          `dedupe_key "${input.dedupeKey}" 已绑定到不同内容的记录`,
        );
      }
    }
    checkRunRefs(ctx, userId, sessionId, input.runId, input.sourceRunId);
    const scan = scanSessionLog(listRecordRows(ctx, sessionId));
    const message = input.payload.message;
    if (message.role === "toolResult" && !scan.toolCallIds.has(message.toolCallId)) {
      throw new SessionRepositoryError(
        "invalid_payload",
        `孤立 toolResult：toolCallId ${message.toolCallId} 在本会话中无对应 assistant 调用`,
      );
    }
    const now = ctx.nowIso();
    const recordId = randomUUID();
    ctx.db
      .prepare(
        `INSERT INTO session_records (record_id, session_id, seq, type, message_seq,
           payload, run_id, source_run_id, dedupe_key, created_at)
         VALUES (?, ?, ?, 'message', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        recordId,
        sessionId,
        scan.maxSeq + 1,
        scan.maxMessageSeq !== null ? scan.maxMessageSeq + 1 : 1,
        serialized,
        input.runId ?? null,
        input.sourceRunId ?? null,
        input.dedupeKey ?? null,
        now,
      );
    touchSession(ctx, sessionId, true);
    return toRecord(fetchRecord(ctx, recordId) as RecordRow);
  });
}

export function appendCompaction(
  ctx: SessionDbContext,
  writer: LeaseWriter,
  userId: string,
  sessionId: string,
  input: AppendCompactionInput,
): SessionRecord {
  return tx(ctx, true, () => {
    assertWritableSession(ctx, userId, sessionId, writer);
    const serialized = serializeCompactionPayload(input.payload);
    if (input.dedupeKey !== undefined) {
      const existing = dedupeHit(ctx, sessionId, input.dedupeKey);
      if (existing) {
        if (
          existing.type === "compaction" &&
          canonicalJson(parseStoredCompactionPayload(existing.payload, `记录 ${existing.record_id}`)) ===
            canonicalJson(input.payload)
        ) {
          return toRecord(existing);
        }
        throw new SessionRepositoryError(
          "conflict",
          `dedupe_key "${input.dedupeKey}" 已绑定到不同内容的记录`,
        );
      }
    }
    // 校验既有日志（任一非法已存记录 → corrupt），再按当前前缀核对新检查点。
    const scan = scanSessionLog(listRecordRows(ctx, sessionId));
    checkCheckpoint(
      input.payload,
      scan,
      scan.latest?.payload.first_kept_message_seq,
      "新压缩检查点",
      conflictFail,
    );
    const now = ctx.nowIso();
    const recordId = randomUUID();
    ctx.db
      .prepare(
        `INSERT INTO session_records (record_id, session_id, seq, type, message_seq,
           payload, run_id, source_run_id, dedupe_key, created_at)
         VALUES (?, ?, ?, 'compaction', NULL, ?, NULL, NULL, ?, ?)`,
      )
      .run(recordId, sessionId, scan.maxSeq + 1, serialized, input.dedupeKey ?? null, now);
    // 压缩不是用户交互：只刷 updated_at，不推进 last_activity_at。
    touchSession(ctx, sessionId, false);
    return toRecord(fetchRecord(ctx, recordId) as RecordRow);
  });
}

export function commitValidatedPlan(
  ctx: SessionDbContext,
  writer: LeaseWriter,
  userId: string,
  sessionId: string,
  recordId: string,
  plan: ValidatedPlan,
): void {
  return tx(ctx, true, () => {
    const session = assertWritableSession(ctx, userId, sessionId, writer);
    if (session.kind !== "main") {
      throw new SessionRepositoryError("conflict", `会话 ${sessionId} 不是主会话，不能设置行程指针`);
    }
    assertValidPlan(plan);
    const row = fetchRecord(ctx, recordId);
    if (!row || row.session_id !== sessionId) {
      throw new SessionRepositoryError("not_found", `记录 ${recordId} 不存在于会话 ${sessionId}`);
    }
    if (row.type !== "message") {
      throw new SessionRepositoryError("conflict", `记录 ${recordId} 不是消息，不能标注 plan`);
    }
    const parsed = parseStoredMessagePayload(row.payload, `记录 ${recordId}`);
    if (parsed.plan !== undefined) {
      throw new SessionRepositoryError("conflict", `记录 ${recordId} 已有 plan 标注`);
    }
    if (!isSuccessfulAssistant(parsed.message)) {
      throw new SessionRepositoryError(
        "conflict",
        `记录 ${recordId} 不是成功的 assistant 消息，不能标注 plan`,
      );
    }
    if (session.current_itinerary_record_id !== null) {
      const current = fetchRecord(ctx, session.current_itinerary_record_id);
      if (!current || current.session_id !== sessionId) {
        throw new SessionRepositoryError(
          "corrupt",
          `会话 ${sessionId} 的行程指针指向不存在或跨会话的记录`,
        );
      }
      if (row.seq <= current.seq) {
        throw new SessionRepositoryError(
          "conflict",
          `行程指针不能回退：记录 ${recordId}（seq=${row.seq}）不晚于当前指针（seq=${current.seq}）`,
        );
      }
    }
    // 原 message 逐字保留，只在 payload 上附加 plan；指针同事务推进。
    ctx.db
      .prepare("UPDATE session_records SET payload = ? WHERE record_id = ?")
      .run(JSON.stringify({ message: parsed.message, plan }), recordId);
    const now = ctx.nowIso();
    ctx.db
      .prepare(
        `UPDATE sessions SET current_itinerary_record_id = ?, last_activity_at = ?, updated_at = ?
         WHERE session_id = ?`,
      )
      .run(recordId, now, now, sessionId);
  });
}

export function listRecords(
  ctx: SessionDbContext,
  userId: string,
  sessionId: string,
): SessionRecord[] {
  return tx(ctx, false, () => {
    assertSessionScope(ctx, userId, sessionId);
    return listRecordRows(ctx, sessionId).map(toRecord);
  });
}

export function listMessagesFrom(
  ctx: SessionDbContext,
  userId: string,
  sessionId: string,
  firstMessageSeq: number,
): SessionRecord[] {
  return tx(ctx, false, () => {
    assertSessionScope(ctx, userId, sessionId);
    if (!Number.isSafeInteger(firstMessageSeq) || firstMessageSeq < 1) {
      throw new SessionRepositoryError(
        "invalid_payload",
        `firstMessageSeq 必须是 >=1 的整数，得到 ${firstMessageSeq}`,
      );
    }
    const rows = ctx.db
      .prepare(
        `SELECT * FROM session_records WHERE session_id = ? AND type = 'message' AND message_seq >= ?
         ORDER BY message_seq`,
      )
      .all(sessionId, firstMessageSeq) as RecordRow[];
    return rows.map(toRecord);
  });
}

export function latestCompaction(
  ctx: SessionDbContext,
  userId: string,
  sessionId: string,
): ValidatedCompaction | undefined {
  return tx(ctx, false, () => {
    assertSessionScope(ctx, userId, sessionId);
    return scanSessionLog(listRecordRows(ctx, sessionId)).latest;
  });
}

export function getRecord(
  ctx: SessionDbContext,
  userId: string,
  sessionId: string,
  recordId: string,
): SessionRecord | undefined {
  return tx(ctx, false, () => {
    assertSessionScope(ctx, userId, sessionId);
    const row = fetchRecord(ctx, recordId);
    if (!row || row.session_id !== sessionId) return undefined;
    return toRecord(row);
  });
}

export function getCurrentItinerary(
  ctx: SessionDbContext,
  userId: string,
  sessionId: string,
): CurrentItinerary | undefined {
  return tx(ctx, false, () => {
    const session = assertSessionScope(ctx, userId, sessionId);
    const pointer = session.current_itinerary_record_id;
    if (pointer === null) return undefined;
    const row = fetchRecord(ctx, pointer);
    if (!row || row.session_id !== sessionId || row.type !== "message") {
      throw new SessionRepositoryError("corrupt", `会话 ${sessionId} 的行程指针非法`);
    }
    const parsed = parseStoredMessagePayload(row.payload, `记录 ${pointer}`);
    if (parsed.plan === undefined) {
      throw new SessionRepositoryError("corrupt", `指针记录 ${pointer} 缺少 plan 标注`);
    }
    return {
      record: toRecord(row),
      plan: parseStoredPlan(parsed.plan, `记录 ${pointer} 的 plan`),
    };
  });
}

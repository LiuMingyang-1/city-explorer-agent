import { randomUUID } from "node:crypto";
import {
  SessionRepositoryError,
  type CreateRunInput,
  type LeaseWriter,
  type Run,
  type RunFinishOutcome,
  type RunStatus,
} from "../types.ts";
import {
  assertSessionScope,
  assertWritableSession,
  fetchRun,
  fetchSession,
  toRun,
  touchSession,
  tx,
  type RunRow,
  type SessionDbContext,
} from "./context.ts";

/**
 * runs 生命周期：queued → running → completed/failed/cancelled。
 * 一切状态推进都要求 run.sessionId 的有效租约 + 同用户归属；
 * 终态不可相互覆盖。root_run_id：无父时指向自身，有父继承父的根。
 */

function serializeJsonColumn(value: unknown, column: string): string {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new SessionRepositoryError("invalid_payload", `run.${column} 不能是 undefined`);
    }
    return json;
  } catch (error) {
    if (error instanceof SessionRepositoryError) throw error;
    throw new SessionRepositoryError(
      "invalid_payload",
      `run.${column} 无法 JSON 序列化：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function fetchOwnedRun(ctx: SessionDbContext, userId: string, runId: string): RunRow {
  const run = fetchRun(ctx, runId);
  if (!run) throw new SessionRepositoryError("not_found", `run ${runId} 不存在`);
  if (run.user_id !== userId) {
    throw new SessionRepositoryError("cross_user", `run ${runId} 不属于用户 ${userId}`);
  }
  return run;
}

const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"]);

export function createRun(
  ctx: SessionDbContext,
  writer: LeaseWriter,
  userId: string,
  input: CreateRunInput,
): Run {
  return tx(ctx, true, () => {
    assertWritableSession(ctx, userId, input.sessionId, writer);
    const inputJson = serializeJsonColumn(input.input, "input");
    const runId = randomUUID();
    let rootRunId: string = runId;
    if (input.parentRunId !== undefined) {
      const parent = fetchRun(ctx, input.parentRunId);
      if (!parent) {
        throw new SessionRepositoryError("not_found", `父 run ${input.parentRunId} 不存在`);
      }
      if (parent.user_id !== userId) {
        throw new SessionRepositoryError(
          "cross_user",
          `父 run ${input.parentRunId} 不属于用户 ${userId}`,
        );
      }
      rootRunId = parent.root_run_id;
    }
    if (input.replyToSessionId !== undefined) {
      const replyTo = fetchSession(ctx, input.replyToSessionId);
      if (!replyTo) {
        throw new SessionRepositoryError(
          "not_found",
          `回投会话 ${input.replyToSessionId} 不存在`,
        );
      }
      if (replyTo.user_id !== userId) {
        throw new SessionRepositoryError(
          "cross_user",
          `回投会话 ${input.replyToSessionId} 不属于用户 ${userId}`,
        );
      }
    }
    const now = ctx.nowIso();
    const status: RunStatus = input.startImmediately ? "running" : "queued";
    ctx.db
      .prepare(
        `INSERT INTO runs (run_id, user_id, session_id, parent_run_id, root_run_id,
           reply_to_session_id, status, input, result, error, cancel_requested,
           delivered_at, created_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?, NULL)`,
      )
      .run(
        runId,
        userId,
        input.sessionId,
        input.parentRunId ?? null,
        rootRunId,
        input.replyToSessionId ?? null,
        status,
        inputJson,
        now,
        status === "running" ? now : null,
      );
    touchSession(ctx, input.sessionId, true);
    return toRun(fetchRun(ctx, runId) as RunRow);
  });
}

export function getRun(ctx: SessionDbContext, userId: string, runId: string): Run | undefined {
  const row = fetchRun(ctx, runId);
  if (!row || row.user_id !== userId) return undefined;
  return toRun(row);
}

export function listRunsBySession(
  ctx: SessionDbContext,
  userId: string,
  sessionId: string,
): Run[] {
  return tx(ctx, false, () => {
    assertSessionScope(ctx, userId, sessionId);
    const rows = ctx.db
      .prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY created_at, run_id")
      .all(sessionId) as RunRow[];
    return rows.map(toRun);
  });
}

export function listRunsByParent(
  ctx: SessionDbContext,
  userId: string,
  parentRunId: string,
): Run[] {
  return tx(ctx, false, () => {
    const parent = fetchRun(ctx, parentRunId);
    if (!parent || parent.user_id !== userId) {
      throw new SessionRepositoryError("not_found", `父 run ${parentRunId} 不存在`);
    }
    const rows = ctx.db
      .prepare("SELECT * FROM runs WHERE parent_run_id = ? ORDER BY created_at, run_id")
      .all(parentRunId) as RunRow[];
    return rows.map(toRun);
  });
}

export function listRunsByUser(ctx: SessionDbContext, userId: string): Run[] {
  const rows = ctx.db
    .prepare("SELECT * FROM runs WHERE user_id = ? ORDER BY created_at, run_id")
    .all(userId) as RunRow[];
  return rows.map(toRun);
}

export function startRun(ctx: SessionDbContext, writer: LeaseWriter, userId: string, runId: string): void {
  return tx(ctx, true, () => {
    const run = fetchOwnedRun(ctx, userId, runId);
    assertWritableSession(ctx, userId, run.session_id, writer);
    if (run.status !== "queued") {
      throw new SessionRepositoryError(
        "invalid_state",
        `run ${runId} 状态 ${run.status} 不能启动（仅 queued 可启动）`,
      );
    }
    ctx.db
      .prepare("UPDATE runs SET status = 'running', started_at = ? WHERE run_id = ?")
      .run(ctx.nowIso(), runId);
    touchSession(ctx, run.session_id, true);
  });
}

export function finishRun(
  ctx: SessionDbContext,
  writer: LeaseWriter,
  userId: string,
  runId: string,
  outcome: RunFinishOutcome,
): void {
  return tx(ctx, true, () => {
    const run = fetchOwnedRun(ctx, userId, runId);
    assertWritableSession(ctx, userId, run.session_id, writer);
    if (TERMINAL.has(run.status)) {
      throw new SessionRepositoryError(
        "invalid_state",
        `run ${runId} 已是终态 ${run.status}，不能覆盖为 ${outcome.status}`,
      );
    }
    let result: string | null = null;
    let error: string | null = null;
    switch (outcome.status) {
      case "completed":
        if (outcome.result !== undefined) result = serializeJsonColumn(outcome.result, "result");
        break;
      case "failed":
        if (typeof outcome.error !== "string" || outcome.error.length === 0) {
          throw new SessionRepositoryError("invalid_payload", "failed 终态需要非空 error");
        }
        error = outcome.error;
        break;
      case "cancelled":
        if (run.cancel_requested !== 1) {
          throw new SessionRepositoryError(
            "invalid_state",
            `run ${runId} 未收到取消请求，不能以 cancelled 终态结束`,
          );
        }
        if (outcome.error !== undefined) error = outcome.error;
        break;
      default:
        throw new SessionRepositoryError("invalid_payload", "未知的 run 终态");
    }
    const now = ctx.nowIso();
    ctx.db
      .prepare(
        `UPDATE runs SET status = ?, result = ?, error = ?, finished_at = ?,
           started_at = COALESCE(started_at, ?) WHERE run_id = ?`,
      )
      .run(outcome.status, result, error, now, now, runId);
    touchSession(ctx, run.session_id, true);
  });
}

export function requestCancelRun(
  ctx: SessionDbContext,
  writer: LeaseWriter,
  userId: string,
  runId: string,
): boolean {
  return tx(ctx, true, () => {
    const run = fetchOwnedRun(ctx, userId, runId);
    assertWritableSession(ctx, userId, run.session_id, writer);
    if (TERMINAL.has(run.status)) return false;
    ctx.db.prepare("UPDATE runs SET cancel_requested = 1 WHERE run_id = ?").run(runId);
    touchSession(ctx, run.session_id, true);
    return true;
  });
}


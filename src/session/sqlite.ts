import type { SessionRepository } from "./repository.ts";
import { openSessionDb, type SessionDbContext } from "./impl/context.ts";
import * as accounts from "./impl/sessions.ts";
import * as records from "./impl/records.ts";
import * as runs from "./impl/runs.ts";
import * as memory from "./impl/memory.ts";

export { SESSION_SCHEMA_DDL, ensureSessionSchema } from "./schema.ts";

/**
 * 会话库的 SQLite repository 工厂（node:sqlite DatabaseSync，无原生依赖）。
 * 库文件独立于活动库（EXPLORER_SESSION_DB_PATH，默认 data/sessions.db）；
 * ":memory:" 供测试；非内存路径自动建父目录。
 */
export interface SessionRepositoryOptions {
  /**
   * 时钟注入：返回当前时间（UTC）。所有内部时间戳、租约过期判定
   * 都用它；测试可注入固定/步进时钟覆盖过期与抢占场景。
   */
  now?: () => Date;
}

export function createSqliteSessionRepository(
  dbPath: string,
  options: SessionRepositoryOptions = {},
): SessionRepository {
  const ctx: SessionDbContext = openSessionDb(dbPath, options.now ?? (() => new Date()));

  return {
    // users / 初始化
    createUser: async (input) => accounts.createUser(ctx, input),
    getUser: async (userId) => accounts.getUser(ctx, userId),
    getMainSession: async (userId) => accounts.getMainSession(ctx, userId),

    // sessions
    getSession: async (userId, sessionId) => accounts.getSession(ctx, userId, sessionId),
    listSessions: async (userId) => accounts.listSessions(ctx, userId),
    createChildSession: async (writer, userId, input) =>
      accounts.createChildSession(ctx, writer, userId, input),
    archiveSession: async (writer, userId, sessionId) =>
      accounts.archiveSession(ctx, writer, userId, sessionId),

    // 租约
    acquireLease: async (userId, sessionId, owner, ttlMs) =>
      accounts.acquireLease(ctx, userId, sessionId, owner, ttlMs),
    renewLease: async (writer, userId, sessionId, ttlMs) =>
      accounts.renewLease(ctx, writer, userId, sessionId, ttlMs),
    releaseLease: async (writer, userId, sessionId) =>
      accounts.releaseLease(ctx, writer, userId, sessionId),

    // records
    appendMessage: async (writer, userId, sessionId, input) =>
      records.appendMessage(ctx, writer, userId, sessionId, input),
    appendCompaction: async (writer, userId, sessionId, input) =>
      records.appendCompaction(ctx, writer, userId, sessionId, input),
    commitValidatedPlan: async (writer, userId, sessionId, recordId, plan) =>
      records.commitValidatedPlan(ctx, writer, userId, sessionId, recordId, plan),
    listRecords: async (userId, sessionId) => records.listRecords(ctx, userId, sessionId),
    listMessagesFrom: async (userId, sessionId, firstMessageSeq) =>
      records.listMessagesFrom(ctx, userId, sessionId, firstMessageSeq),
    latestCompaction: async (userId, sessionId) =>
      records.latestCompaction(ctx, userId, sessionId),
    getRecord: async (userId, sessionId, recordId) =>
      records.getRecord(ctx, userId, sessionId, recordId),
    getCurrentItinerary: async (userId, sessionId) =>
      records.getCurrentItinerary(ctx, userId, sessionId),

    // runs
    createRun: async (writer, userId, input) => runs.createRun(ctx, writer, userId, input),
    getRun: async (userId, runId) => runs.getRun(ctx, userId, runId),
    listRunsBySession: async (userId, sessionId) =>
      runs.listRunsBySession(ctx, userId, sessionId),
    listRunsByParent: async (userId, parentRunId) =>
      runs.listRunsByParent(ctx, userId, parentRunId),
    listRunsByUser: async (userId) => runs.listRunsByUser(ctx, userId),
    startRun: async (writer, userId, runId) => runs.startRun(ctx, writer, userId, runId),
    finishRun: async (writer, userId, runId, outcome) =>
      runs.finishRun(ctx, writer, userId, runId, outcome),
    requestCancelRun: async (writer, userId, runId) =>
      runs.requestCancelRun(ctx, writer, userId, runId),

    // user_memory
    getUserMemory: async (userId) => memory.getUserMemory(ctx, userId),
    putUserMemory: async (userId, input) => memory.putUserMemory(ctx, userId, input),

    close: () => ctx.db.close(),
  };
}

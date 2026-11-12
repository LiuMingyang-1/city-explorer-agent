import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionRepository } from "../src/session/repository.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";
import type {
  CompactionPayload,
  LeaseWriter,
  Session,
  User,
  ValidatedPlan,
} from "../src/session/types.ts";

/** session-*.test.ts 共用的 fixture；不是测试文件（无 .test 后缀）。 */

let stamp = 1_700_000_000_000;
const nextStamp = () => (stamp += 1);

/** 可控时钟：注入 createSqliteSessionRepository 的 now，advance 推进时间。 */
export function fakeClock(startIso = "2026-11-11T08:00:00.000Z") {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
    set(iso: string) {
      current = Date.parse(iso);
    },
  };
}

export function openMemoryRepo(t: TestContext, now?: () => Date): SessionRepository {
  const repo = createSqliteSessionRepository(":memory:", now ? { now } : {});
  t.after(() => repo.close());
  return repo;
}

export function tempDbPath(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "explorer-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "sessions.db");
}

export function openFileRepo(
  t: TestContext,
  dbPath: string,
  now?: () => Date,
): SessionRepository {
  const repo = createSqliteSessionRepository(dbPath, now ? { now } : {});
  t.after(() => repo.close());
  return repo;
}

/** 建用户并建一条对话会话，取回 (user, main)。 */
export async function makeUser(
  repo: SessionRepository,
  userId = "u-test",
): Promise<{ user: User; main: Session }> {
  const user = await repo.createUser({ userId });
  const main = await repo.createConversation(userId);
  return { user, main };
}

export async function mustAcquire(
  repo: SessionRepository,
  userId: string,
  sessionId: string,
  owner = "worker-1",
  ttlMs = 60_000,
): Promise<LeaseWriter> {
  const writer = await repo.acquireLease(userId, sessionId, owner, ttlMs);
  assert.ok(writer, "应能获取租约");
  return writer;
}

// ---- 消息构造（满足 src/session/payload.ts 边界校验的最小合法形状） ----

export function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: nextStamp() };
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function assistantMessage(
  text: string,
  options: {
    stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted" | "pending" | "deferred";
    errorMessage?: string;
    toolCalls?: Array<{ id: string; name?: string }>;
  } = {},
): AgentMessage {
  const content: unknown[] = [
    ...(options.toolCalls ?? []).map((call) => ({
      type: "toolCall",
      id: call.id,
      name: call.name ?? "search_events",
      arguments: {},
    })),
    { type: "text", text },
  ];
  const message: Record<string, unknown> = {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
    stopReason: options.stopReason ?? "stop",
    timestamp: nextStamp(),
  };
  if (options.errorMessage !== undefined) message.errorMessage = options.errorMessage;
  return message as AgentMessage;
}

export function toolResultMessage(
  toolCallId: string,
  options: { toolName?: string; isError?: boolean; text?: string } = {},
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: options.toolName ?? "search_events",
    content: [{ type: "text", text: options.text ?? "{}" }],
    isError: options.isError ?? false,
    timestamp: nextStamp(),
  } as AgentMessage;
}

/** 顺序追加一批消息（字符串自动包成 userMessage）。 */
export async function seedMessages(
  repo: SessionRepository,
  writer: LeaseWriter,
  userId: string,
  sessionId: string,
  messages: Array<AgentMessage | string>,
): Promise<void> {
  for (const item of messages) {
    const message = typeof item === "string" ? userMessage(item) : item;
    await repo.appendMessage(writer, userId, sessionId, { payload: { message } });
  }
}

export function validPlan(): ValidatedPlan {
  return {
    constraints: { date: "2026-11-15", availableStart: "13:00", availableEnd: "18:00" },
    itinerary: {
      date: "2026-11-15",
      summary: "下午看展",
      stops: [
        { event_id: "evt_1", arrive_at: "13:00", leave_at: "15:00", reason: "主展" },
        { event_id: "evt_2", arrive_at: "15:30", leave_at: "17:00", reason: "书店" },
      ],
    },
  };
}

export function compactionPayload(
  through: number,
  firstKept: number,
  overrides: Partial<CompactionPayload> = {},
): CompactionPayload {
  return {
    summary: "历史摘要",
    source_through_message_seq: through,
    first_kept_message_seq: firstKept,
    ...overrides,
  };
}

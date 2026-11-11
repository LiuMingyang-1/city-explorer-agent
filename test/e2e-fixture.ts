import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createExplorerAgent } from "../src/agent/explorer-agent.ts";
import { createPersistentPlanner, PlannerSession } from "../src/agent/session.ts";
import type { PersistentPlannerOptions, PlannerSessionOptions } from "../src/agent/session.ts";
import type { ExplorerConfig } from "../src/config.ts";
import type { EventRepository } from "../src/data/repository.ts";
import { seedDatabase } from "../src/data/seed.ts";
import { createSqliteEventRepository } from "../src/data/sqlite.ts";
import type { Event } from "../src/data/types.ts";
import type { SessionRepository } from "../src/session/repository.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";

/**
 * agent-e2e*.test.ts 共用的端到端 fixture；不是测试文件（无 .test 后缀）。
 * PlannerSession 走默认接线（真实 validateItinerary），
 * faux 模型 → 真实 search_events → 真实 SQLite → 真实校验。
 */
export const BASE = "2026-11-11";
export const DAY1 = "2026-11-14"; // 种子覆盖 11-11 起 7 天
export const DAY2 = "2026-11-15";

export const CONFIG: ExplorerConfig = {
  provider: "openai",
  model: "gpt-5.4",
  apiKey: "k",
  contextWindow: 128_000,
  maxTokens: 4096,
  dbPath: "unused.db",
};

export function envelope(
  itinerary: unknown,
  constraints: Record<string, unknown> = { date: BASE },
): string {
  return JSON.stringify({ type: "itinerary", constraints, itinerary });
}

export async function makeRepo(t: TestContext): Promise<EventRepository> {
  const dir = mkdtempSync(join(tmpdir(), "explorer-e2e-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "events.db");
  seedDatabase(dbPath, BASE);
  const repo = createSqliteEventRepository(dbPath);
  t.after(() => repo.close());
  return repo;
}

export async function makeSession(t: TestContext, responses: FauxResponseStep[]) {
  const repo = await makeRepo(t);
  const faux = createFauxCore({});
  faux.setResponses(responses);
  const streamFn: StreamFn = (model, context, options) => faux.streamSimple(model, context, options);
  const agent = await createExplorerAgent({
    config: CONFIG,
    repository: repo,
    streamFn,
    currentDate: BASE,
  });
  return { session: new PlannerSession({ agent, repository: repo }), repo, faux };
}

export async function exhibition(repo: EventRepository, date: string = DAY1): Promise<Event> {
  return (await repo.search({ date, category: "展览" }))[0];
}

export function stopsAt(event_id: string) {
  return (arrive_at: string, leave_at: string) => ({ event_id, arrive_at, leave_at, reason: "r" });
}

/** 首轮行程响应：DAY1 展览 13:00–14:00，确认可用时段 13:00–18:00。 */
export function afternoonPlan(ev: Event): FauxResponseStep {
  return fauxAssistantMessage(
    envelope(
      { date: DAY1, summary: "s", stops: [stopsAt(ev.id)("13:00", "14:00")] },
      { date: DAY1, availableStart: "13:00", availableEnd: "18:00" },
    ),
  );
}

// ---- 持久会话 fixture（session-integration*.test.ts 用） ----

/**
 * 摘要请求与正常请求走同一个 streamFn；按 TranscriptContext 中的
 * `<conversation>` 标记分流到独立队列，互不消耗响应。
 */
export function isSummaryRequest(context: { messages: unknown[] }): boolean {
  return (context.messages as Array<{ role?: string; content?: unknown }>).some(
    (message) =>
      message.role === "user" &&
      (typeof message.content === "string"
        ? message.content.includes("<conversation>")
        : JSON.stringify(message.content).includes("<conversation>")),
  );
}

export interface SummaryControl {
  /** 摘要请求计数（含重试）。 */
  calls: () => number;
}

/**
 * 双队列 streamFn：摘要请求 → 独立小队列（每次请求重建，
 * 同一批响应可反复消费），其余 → 主 faux（测试脚本队列）。
 */
export function makeStreamFn(
  faux: ReturnType<typeof createFauxCore>,
  summaryResponses: FauxResponseStep[] = [
    fauxAssistantMessage("## 摘要\n- 已确认约束与行程要点已保留"),
  ],
): { streamFn: StreamFn; summary: SummaryControl } {
  let calls = 0;
  const streamFn: StreamFn = (model, context, options) => {
    if (!isSummaryRequest(context)) return faux.streamSimple(model, context, options);
    calls += 1;
    const summaryCore = createFauxCore({});
    summaryCore.setResponses(summaryResponses);
    return summaryCore.streamSimple(model, context, options);
  };
  return { streamFn, summary: { calls: () => calls } };
}

export interface PersistentFixtureOptions {
  config?: ExplorerConfig;
  userId?: string;
  sessionId?: string;
  /** 复用同一 SessionRepository（多实例/重开场景必传）。 */
  sessions?: SessionRepository;
  repository?: EventRepository;
  leaseTtlMs?: number;
  leaseRenewMs?: number;
  validate?: PlannerSessionOptions["validate"];
  maxCorrections?: number;
  compaction?: PersistentPlannerOptions["compaction"];
  /** 位置锚点解析 stub；缺省走 createPersistentPlanner 的真实 repository 实现。 */
  locationAnchor?: PersistentPlannerOptions["locationAnchor"];
  /** 缺省固定摘要；要自己排摘要响应时用 makeStreamFn 另行构造 streamFn。 */
  streamFn?: StreamFn;
}

/**
 * 持久化端到端：faux 模型 → 真实 search_events → 真实活动 SQLite →
 * 真实会话 SQLite（:memory:）→ 真实校验 → 租约/检查点/指针全链路。
 */
export async function makePersistent(
  t: TestContext,
  responses: FauxResponseStep[],
  options: PersistentFixtureOptions = {},
) {
  const repo = options.repository ?? (await makeRepo(t));
  const sessions = options.sessions ?? createSqliteSessionRepository(":memory:");
  if (!options.sessions) t.after(() => sessions.close());
  const faux = createFauxCore({});
  faux.setResponses(responses);
  const { streamFn, summary } = options.streamFn
    ? { streamFn: options.streamFn, summary: undefined }
    : makeStreamFn(faux);
  const session = await createPersistentPlanner({
    config: options.config ?? CONFIG,
    repository: repo,
    sessions,
    userId: options.userId ?? "u-test",
    sessionId: options.sessionId,
    leaseTtlMs: options.leaseTtlMs,
    leaseRenewMs: options.leaseRenewMs,
    validate: options.validate,
    maxCorrections: options.maxCorrections,
    compaction: options.compaction,
    locationAnchor: options.locationAnchor,
    streamFn,
    currentDate: BASE,
  });
  t.after(async () => {
    await session.close();
  });
  return { session, repo, sessions, faux, summary };
}

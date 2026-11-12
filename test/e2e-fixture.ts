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

/** A/B 双方案 envelope：plans 为 [{label,title,itinerary}]，顺序即 active 在前。 */
export function comparisonEnvelope(
  plans: { label: "A" | "B"; title: string; itinerary: unknown }[],
  constraints: Record<string, unknown> = { date: BASE },
): string {
  return JSON.stringify({ type: "comparison", constraints, plans });
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

/**
 * 记忆蒸馏旁路请求与正常请求也走同一个 streamFn：distill.ts 的模型输入是
 * 唯一一条 user 消息，文本以 `<memory>` 开头（其内还含 `<conversation>`，
 * 因此各分流点必须先查本判别再查 isSummaryRequest）。按"首条 user 消息
 * 以 <memory> 开头"分流，互不消耗响应。
 */
export function isDistillRequest(context: { messages: unknown[] }): boolean {
  const firstUser = (context.messages as Array<{ role?: string; content?: unknown }>).find(
    (message) => message.role === "user",
  );
  return typeof firstUser?.content === "string" && firstUser.content.startsWith("<memory>");
}

export interface SummaryControl {
  /** 旁路请求（摘要/蒸馏）计数（含重试）。 */
  calls: () => number;
}

/**
 * 三队列 streamFn：蒸馏请求 → 独立小队列，摘要请求 → 独立小队列
 * （两者都每次请求重建，同一批响应可反复消费），其余 → 主 faux
 * （测试脚本队列）。蒸馏判别必须在摘要之前：蒸馏输入也含
 * `<conversation>`，顺序反了会被吞进摘要队列。
 */
export function makeStreamFn(
  faux: ReturnType<typeof createFauxCore>,
  summaryResponses: FauxResponseStep[] = [
    fauxAssistantMessage("## 摘要\n- 已确认约束与行程要点已保留"),
  ],
  distillResponses: FauxResponseStep[] = [fauxAssistantMessage("UNCHANGED")],
): { streamFn: StreamFn; summary: SummaryControl; distill: SummaryControl } {
  let summaryCalls = 0;
  let distillCalls = 0;
  const streamFn: StreamFn = (model, context, options) => {
    if (isDistillRequest(context)) {
      distillCalls += 1;
      const distillCore = createFauxCore({});
      distillCore.setResponses(distillResponses);
      return distillCore.streamSimple(model, context, options);
    }
    if (!isSummaryRequest(context)) return faux.streamSimple(model, context, options);
    summaryCalls += 1;
    const summaryCore = createFauxCore({});
    summaryCore.setResponses(summaryResponses);
    return summaryCore.streamSimple(model, context, options);
  };
  return {
    streamFn,
    summary: { calls: () => summaryCalls },
    distill: { calls: () => distillCalls },
  };
}

export interface PersistentFixtureOptions {
  config?: ExplorerConfig;
  userId?: string;
  sessionId?: string;
  /** 新建对话标题（仅未传 sessionId 时生效）。 */
  title?: string;
  /** 编排入参：所建 run 的父 run / 回投会话 / 递归深度，透传 createPersistentPlanner。 */
  parentRunId?: string;
  replyToSessionId?: string;
  depth?: number;
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
  /** close 机会蒸馏后台执行；透传 PersistentPlannerOptions。 */
  detachDistill?: boolean;
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
  const { streamFn, summary, distill } = options.streamFn
    ? { streamFn: options.streamFn, summary: undefined, distill: undefined }
    : makeStreamFn(faux);
  const session = await createPersistentPlanner({
    config: options.config ?? CONFIG,
    repository: repo,
    sessions,
    userId: options.userId ?? "u-test",
    sessionId: options.sessionId,
    title: options.title,
    parentRunId: options.parentRunId,
    replyToSessionId: options.replyToSessionId,
    depth: options.depth,
    leaseTtlMs: options.leaseTtlMs,
    leaseRenewMs: options.leaseRenewMs,
    validate: options.validate,
    maxCorrections: options.maxCorrections,
    compaction: options.compaction,
    locationAnchor: options.locationAnchor,
    detachDistill: options.detachDistill,
    streamFn,
    currentDate: BASE,
  });
  t.after(async () => {
    await session.close();
  });
  return { session, repo, sessions, faux, summary, distill };
}

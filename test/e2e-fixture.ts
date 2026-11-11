import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createExplorerAgent } from "../src/agent/explorer-agent.ts";
import { PlannerSession } from "../src/agent/session.ts";
import type { ExplorerConfig } from "../src/config.ts";
import type { EventRepository } from "../src/data/repository.ts";
import { seedDatabase } from "../src/data/seed.ts";
import { createSqliteEventRepository } from "../src/data/sqlite.ts";
import type { Event } from "../src/data/types.ts";

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

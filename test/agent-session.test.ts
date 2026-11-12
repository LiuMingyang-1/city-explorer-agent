import { afterResource } from "./resource-cleanup-fixture.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createExplorerAgent } from "../src/agent/explorer-agent.ts";
import { PlannerSession } from "../src/agent/session.ts";
import type { ExplorerConfig } from "../src/config.ts";
import { seedDatabase } from "../src/data/seed.ts";
import { createSqliteEventRepository } from "../src/data/sqlite.ts";
import type { Event } from "../src/data/types.ts";
import type { Itinerary, PlanningConstraints } from "../src/itinerary/types.ts";
import type { ValidationResult } from "../src/itinerary/validation.ts";

const BASE = "2026-11-11";

const CONFIG: ExplorerConfig = {
  provider: "openai",
  model: "gpt-5.4",
  apiKey: "k",
  contextWindow: 128_000,
  maxTokens: 4096,
  dbPath: "unused.db",
};

/** 最小真实校验：结构 + 日期一致 + event_id 在库里。 */
function check(candidate: unknown, constraints: PlanningConstraints, events: Map<string, Event>): ValidationResult {
  const fail = (code: string, message: string, event_id?: string): ValidationResult => ({
    ok: false,
    issues: [{ code: code as never, message, event_id }],
  });
  const c = candidate as Partial<Itinerary> | null;
  if (!c || typeof c.date !== "string" || typeof c.summary !== "string" || !Array.isArray(c.stops)) {
    return fail("invalid_shape", "结构不对");
  }
  if (c.date !== constraints.date) {
    return fail("date_mismatch", `行程日期 ${c.date} 与要求 ${constraints.date} 不符`);
  }
  for (const s of c.stops) {
    if (!events.has(s.event_id)) return fail("unknown_event", `未知活动 ${s.event_id}`, s.event_id);
  }
  return { ok: true, issues: [], itinerary: candidate as Itinerary };
}

function envelope(itinerary: unknown, constraints: Partial<PlanningConstraints> = { date: BASE }): string {
  return JSON.stringify({ type: "itinerary", constraints, itinerary });
}

async function makeSession(t: TestContext, responses: FauxResponseStep[]) {
  const dir = mkdtempSync(join(tmpdir(), "explorer-session-"));
  afterResource(t, () => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "events.db");
  seedDatabase(dbPath, BASE);
  const repo = createSqliteEventRepository(dbPath);
  afterResource(t, () => repo.close());

  const faux = createFauxCore({});
  faux.setResponses(responses);
  const streamFn: StreamFn = (model, context, options) => faux.streamSimple(model, context, options);
  const agent = await createExplorerAgent({
    config: CONFIG,
    repository: repo,
    streamFn,
    currentDate: BASE,
  });
  // 注入最小校验，让会话机制测试独立于 task 05 的进度。
  return { session: new PlannerSession({ agent, repository: repo, validate: check }), repo, agent, faux };
}

test("clarification turn asks for the missing date", async (t) => {
  const { session } = await makeSession(t, [
    fauxAssistantMessage('{"type":"clarify","question":"想哪天去？"}'),
  ]);
  const turn = await session.prompt("帮我安排一下");
  assert.deepEqual(turn, { kind: "clarification", question: "想哪天去？" });
  assert.equal(session.itinerary, undefined);
});

test("itinerary turn runs the real tool chain and validates before committing", async (t) => {
  const { session, repo, faux } = await makeSession(t, []);
  const ev = (await repo.search({ date: BASE, category: "展览" }))[0];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("search_events", { date: BASE, category: "展览" })], {
      stopReason: "toolUse",
    }),
    (context) => {
      const toolResult = context.messages.find((m) => m.role === "toolResult");
      assert.ok(toolResult && JSON.stringify(toolResult.content).includes(ev.id));
      return fauxAssistantMessage(
        envelope({
          date: BASE,
          summary: "看展",
          stops: [{ event_id: ev.id, arrive_at: "10:00", leave_at: "11:30", reason: "r" }],
        }),
      );
    },
  ]);
  const turn = await session.prompt("周五上午看展");
  assert.equal(turn.kind, "itinerary");
  if (turn.kind !== "itinerary") return;
  assert.equal(turn.itinerary.stops[0].event_id, ev.id);
  assert.equal(session.itinerary?.stops[0].event_id, ev.id);
  assert.equal(faux.state.callCount, 2);
  assert.deepEqual(
    session.toolCalls.map((c) => [c.toolName, c.isError]),
    [["search_events", false]],
  );
  assert.deepEqual((session.toolCalls[0].args as { date: string }).date, BASE);
});

test("failed validation feeds issues back once and a fixed reply commits", async (t) => {
  const seen: string[] = [];
  const good = {
    date: BASE,
    summary: "s",
    stops: [{ event_id: "evt_001", arrive_at: "10:00", leave_at: "11:00", reason: "r" }],
  };
  const { session, repo } = await makeSession(t, [
    fauxAssistantMessage(envelope({ ...good, stops: [{ event_id: "evt_nope", arrive_at: "10:00", leave_at: "11:00", reason: "r" }] })),
    (context) => {
      const last = context.messages[context.messages.length - 1];
      seen.push(last.role === "user" ? JSON.stringify(last.content) : "not-user");
      return fauxAssistantMessage(envelope(good));
    },
  ]);
  const realId = (await repo.search({}))[0].id;
  good.stops[0].event_id = realId;
  const turn = await session.prompt("安排");
  assert.equal(turn.kind, "itinerary");
  assert.ok(seen[0].includes("未通过校验") && seen[0].includes("evt_nope"));
  assert.equal(session.itinerary?.stops[0].event_id, realId);
});

test("still-failing output errors after two corrections and keeps the old itinerary", async (t) => {
  const bad = envelope({ date: BASE, summary: "s", stops: [{ event_id: "evt_nope", arrive_at: "10:00", leave_at: "11:00", reason: "r" }] });
  const { session, faux } = await makeSession(t, [
    fauxAssistantMessage(bad),
    fauxAssistantMessage(bad),
    fauxAssistantMessage(bad),
  ]);
  const turn = await session.prompt("安排");
  assert.equal(turn.kind, "error");
  if (turn.kind === "error") assert.ok(turn.message.includes("evt_nope"));
  assert.equal(faux.state.callCount, 3); // 首次 + 2 轮纠正
  assert.equal(session.itinerary, undefined);
});

test("unparseable and model-error replies surface as error turns", async (t) => {
  const a = await makeSession(t, [
    fauxAssistantMessage("not json"),
    fauxAssistantMessage("still not json"),
    fauxAssistantMessage("nope"),
  ]);
  const turn1 = await a.session.prompt("hi");
  assert.equal(turn1.kind, "error");
  if (turn1.kind === "error") assert.ok(turn1.message.includes("格式"));

  const b = await makeSession(t, [
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }),
  ]);
  const turn2 = await b.session.prompt("hi");
  assert.deepEqual(turn2, { kind: "error", message: "provider down" });
});

test("system prompt reached the model with the injected current date", async (t) => {
  const { agent } = await makeSession(t, [fauxAssistantMessage('{"type":"clarify","question":"q"}')]);
  assert.ok(agent.state.systemPrompt.includes(BASE));
  assert.ok(agent.state.systemPrompt.includes('"clarify"'));
});

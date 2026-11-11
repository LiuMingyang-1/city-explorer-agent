import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { PlannerSession, createPlanner } from "../src/agent/session.ts";
import {
  BASE,
  CONFIG,
  envelope,
  exhibition,
  makeRepo,
  makeSession,
} from "./e2e-fixture.ts";

/**
 * 端到端：工具链与接线。
 * faux 模型 → 真实 search_events → 真实 SQLite → 真实校验 → 提交。
 * 单轮纠正见 agent-e2e-correction.test.ts；约束多轮见 agent-e2e-constraints.test.ts。
 */

test("valid model output passes the real validator and commits", async (t) => {
  const { session, repo, faux } = await makeSession(t, []);
  const ev = await exhibition(repo, BASE);
  // 起止都是 "YYYY-MM-DDTHH:MM"；取窗口内的一段到访。
  const arrive = ev.startAt.slice(11, 16);
  const leave = `${String(Number(arrive.slice(0, 2)) + 1).padStart(2, "0")}:${arrive.slice(3)}`;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("search_events", { date: BASE })], { stopReason: "toolUse" }),
    fauxAssistantMessage(
      envelope(
        { date: BASE, summary: "s", stops: [{ event_id: ev.id, arrive_at: arrive, leave_at: leave, reason: "r" }] },
        { date: BASE, availableStart: "09:00", availableEnd: "23:00" },
      ),
    ),
  ]);
  const turn = await session.prompt("安排");
  assert.equal(turn.kind, "itinerary");
  assert.equal(session.toolCalls.length, 1);
});

test("createPlanner wires agent + session in one call (the CLI entry)", async (t) => {
  const repo = await makeRepo(t);
  const faux = createFauxCore({});
  const streamFn: StreamFn = (model, context, options) => faux.streamSimple(model, context, options);
  const session = await createPlanner({ config: CONFIG, repository: repo, streamFn, currentDate: BASE });
  assert.ok(session instanceof PlannerSession);
  faux.setResponses([fauxAssistantMessage('{"type":"clarify","question":"哪天？"}')]);
  const turn = await session.prompt("随便");
  assert.equal(turn.kind, "clarification");
});

test("empty search results can still produce a valid empty itinerary", async (t) => {
  const { session, faux } = await makeSession(t, [
    fauxAssistantMessage(envelope({ date: BASE, summary: "当天没有符合的活动", stops: [] })),
  ]);
  const turn = await session.prompt("安排");
  assert.equal(turn.kind, "itinerary");
  if (turn.kind !== "itinerary") return;
  assert.deepEqual(turn.itinerary, { date: BASE, summary: "当天没有符合的活动", stops: [] });
  assert.equal(turn.constraints.date, BASE);
});

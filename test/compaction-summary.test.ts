import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
  type Api,
  fauxAssistantMessage,
  fauxToolCall,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { generateSummary } from "../src/compaction/summary.ts";
import { makeAgent, testModel, user } from "./compaction-fixture.test.ts";

test("summary is a standalone request with its own budget and domain prompt", async () => {
  const { agent, faux, model } = makeAgent();
  let seenContext: TranscriptContext | undefined;
  let seenOptions: SimpleStreamOptions | undefined;
  agent.streamFunction = (m: Model<Api>, c: TranscriptContext, o?: SimpleStreamOptions) => {
    seenContext = c;
    seenOptions = o;
    return faux.streamSimple(m, c, o);
  };
  faux.setResponses([fauxAssistantMessage("已确认 2026-11-14 行程摘要")]);
  const { summary, usage } = await generateSummary(
    agent,
    model,
    [user("帮我规划 2026-11-14 下午看展")],
    8_192,
  );
  assert.equal(summary, "已确认 2026-11-14 行程摘要");
  assert.ok(usage);
  assert.equal(seenOptions?.maxRetries, 0);
  assert.equal(seenOptions?.cacheRetention, "none");
  assert.equal(seenOptions?.maxTokens, 8_192);
  const first = seenContext?.messages[0];
  assert.equal(first?.role, "system");
  assert.match(JSON.stringify(first), /summarize conversations/);
  const last = seenContext?.messages.at(-1);
  assert.equal(last?.role, "user");
  const prompt = JSON.stringify(last);
  assert.match(prompt, /<conversation>/);
  assert.match(prompt, /event_id/);
  assert.match(prompt, /pending confirmation|still pending/);
  assert.match(prompt, /rejected/);
  assert.match(prompt, /itinerary/);
  assert.doesNotMatch(prompt, /read_session_history/);
});

test("retries share three attempts, quality retries once, provider retries disabled", async () => {
  const { agent, faux, model } = makeAgent();
  const budgets: number[] = [];
  agent.streamFunction = (m, c, options) => {
    assert.equal(options?.maxRetries, 0);
    budgets.push(options?.maxTokens ?? 0);
    return faux.streamSimple(m, c, options);
  };
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 temporarily unavailable" }),
    fauxAssistantMessage("Cut", { stopReason: "length" }),
    fauxAssistantMessage("Complete"),
  ]);
  assert.equal(
    (await generateSummary(agent, model, [user("history")], 100)).summary,
    "Complete",
  );
  assert.deepEqual(budgets, [100, 100, 200]);
  const before = faux.state.callCount;
  faux.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("")]);
  await assert.rejects(generateSummary(agent, model, [user("history")], 100), /empty/);
  assert.equal(faux.state.callCount - before, 2);
  for (const response of [
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 unauthorized" }),
    fauxAssistantMessage(fauxToolCall("search_events", { date: "2026-11-14" }), {
      stopReason: "toolUse",
    }),
  ]) {
    const count = faux.state.callCount;
    faux.setResponses([response]);
    await assert.rejects(generateSummary(agent, model, [user("history")], 100));
    assert.equal(faux.state.callCount, count + 1);
  }
  const count = faux.state.callCount;
  faux.setResponses(
    Array.from({ length: 3 }, () =>
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "503 temporarily unavailable",
      }),
    ),
  );
  await assert.rejects(generateSummary(agent, model, [user("history")], 100), /503/);
  assert.equal(faux.state.callCount, count + 3);
});

test("input that cannot fit the window fails before any request", async () => {
  const { agent, faux } = makeAgent();
  const tiny = testModel({ contextWindow: 1_000 });
  await assert.rejects(
    generateSummary(agent, tiny, [user("x".repeat(8_000))], 8_192),
    /does not fit/,
  );
  assert.equal(faux.state.callCount, 0);
});

test("summary budget clamps to the declared model maxTokens", async () => {
  const { agent, faux } = makeAgent();
  agent.streamFunction = (m, c, options) => {
    assert.equal(options?.maxTokens, 500);
    return faux.streamSimple(m, c, options);
  };
  faux.setResponses([
    fauxAssistantMessage("Cut", { stopReason: "length" }),
    fauxAssistantMessage("Complete"),
  ]);
  await generateSummary(agent, testModel({ maxTokens: 500 }), [user("history")], 100_000);
  assert.equal(faux.state.callCount, 2);
});

test("abort propagates before the request and during retry backoff", async () => {
  const { agent, faux, model } = makeAgent();
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(generateSummary(agent, model, [user("x")], 100, pre.signal));
  assert.equal(faux.state.callCount, 0);
  const ac = new AbortController();
  agent.streamFunction = (m, c, o) => {
    ac.abort();
    return faux.streamSimple(m, c, o);
  };
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 temporarily unavailable" }),
    fauxAssistantMessage("unreached"),
  ]);
  await assert.rejects(generateSummary(agent, model, [user("x")], 100, ac.signal), /abort/i);
  assert.equal(faux.state.callCount, 1);
});

test("summary generation never enters prepareRequest (no recursive compaction)", async () => {
  const { agent, faux, model } = makeAgent();
  let prepareCalls = 0;
  agent.prepareRequest = () => {
    prepareCalls++;
    return undefined;
  };
  faux.setResponses([fauxAssistantMessage("摘要")]);
  await generateSummary(agent, model, [user("历史")], 100);
  assert.equal(faux.state.callCount, 1);
  assert.equal(prepareCalls, 0);
});

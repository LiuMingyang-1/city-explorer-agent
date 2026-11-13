import { afterResource } from "./resource-cleanup-fixture.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { SEARCH_EVENTS_TOOL, createSearchEventsTool } from "../src/agent/tools.ts";
import { DELEGATE_TASK_TOOL, createDelegateTaskTool } from "../src/agent/delegate.ts";
import { buildSystemPrompt, localToday } from "../src/agent/prompt.ts";
import { createExplorerAgent } from "../src/agent/explorer-agent.ts";
import {
  extractEventIds,
  lastAssistantText,
  parsePlannerResponse,
  PlannerResponseError,
} from "../src/agent/response.ts";
import { seedDatabase } from "../src/data/seed.ts";
import { createSqliteEventRepository } from "../src/data/sqlite.ts";
import type { ExplorerConfig } from "../src/config.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { openMemoryRepo } from "./session-fixture.ts";

const BASE = "2026-11-11";

const CONFIG: ExplorerConfig = {
  provider: "openai",
  model: "gpt-5.4",
  apiKey: "k",
  contextWindow: 128_000,
  maxTokens: 4096,
  dbPath: "unused.db",
};

function seededRepo(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "explorer-agent-"));
  afterResource(t, () => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "events.db");
  seedDatabase(dbPath, BASE);
  const repo = createSqliteEventRepository(dbPath);
  afterResource(t, () => repo.close());
  return repo;
}

test("search_events tool queries the repository and returns event JSON", async (t) => {
  const repo = seededRepo(t);
  const tool = createSearchEventsTool(repo);
  assert.equal(tool.name, SEARCH_EVENTS_TOOL);
  const result = await tool.execute("call_1", { date: BASE, category: "展览" });
  assert.ok(result.details && result.details.count > 0);
  const events = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(events.length, result.details?.count);
  assert.ok(events.every((e: { category: string }) => e.category === "展览"));
  assert.ok(events[0].id && events[0].startAt && events[0].suggestedDurationMinutes);
});

test("search_events tool returns new budget/media fields from SQLite", async (t) => {
  const repo = seededRepo(t);
  const tool = createSearchEventsTool(repo);
  const result = await tool.execute("call_fields", { keyword: "织物" });
  const events = JSON.parse((result.content[0] as { text: string }).text);
  assert.ok(events.length > 0);
  const ev = events[0];
  for (const key of [
    "budgetMin", "budgetMax", "currency", "budgetNote", "guideUrl", "thumbnailUrl", "imageUrls",
  ]) {
    assert.ok(key in ev, `missing ${key} in tool output`);
  }
  // 与 repository 直读一致：付费区间、攻略与多图地址原样回传。
  const direct = (await repo.getByIds([ev.id])).get(ev.id);
  assert.equal(ev.budgetMin, direct?.budgetMin);
  assert.equal(ev.budgetMax, direct?.budgetMax);
  assert.ok(ev.budgetMin > 0, "expected a paid sample");
  assert.equal(ev.currency, "CNY");
  assert.equal(ev.guideUrl, direct?.guideUrl);
  assert.ok(ev.guideUrl.startsWith("https://"));
  assert.equal(ev.thumbnailUrl, direct?.thumbnailUrl);
  assert.deepEqual(ev.imageUrls, direct?.imageUrls);
  assert.ok(ev.imageUrls.length > 1, "expected multi-image sample");
});

test("search_events tool tolerates empty params and no matches", async (t) => {
  const repo = seededRepo(t);
  const tool = createSearchEventsTool(repo);
  const all = await tool.execute("c", {});
  assert.ok((all.details?.count ?? 0) > 0); // 无条件时返回库内活动（上限内）
  const none = await tool.execute("c", { keyword: "不存在的关键词" });
  assert.equal(none.details?.count, 0);
  assert.equal((none.content[0] as { text: string }).text, "[]");
});

test("system prompt injects current date and the output contract", () => {
  const prompt = buildSystemPrompt("2026-11-11");
  assert.ok(prompt.includes("2026-11-11"));
  assert.ok(prompt.includes('"clarify"') && prompt.includes('"itinerary"'));
  assert.ok(prompt.includes("constraints"));
  assert.equal(localToday(new Date(2026, 10, 11)), "2026-11-11");
});

test("system prompt stays byte-identical unless canDelegate is true", () => {
  assert.equal(buildSystemPrompt(BASE), buildSystemPrompt(BASE, {}));
  assert.equal(buildSystemPrompt(BASE), buildSystemPrompt(BASE, { canDelegate: false }));
  const delegated = buildSystemPrompt(BASE, { canDelegate: true });
  assert.notEqual(delegated, buildSystemPrompt(BASE));
  assert.ok(delegated.includes(DELEGATE_TASK_TOOL));
  assert.ok(delegated.includes("子任务委派"));
  assert.ok(delegated.startsWith(buildSystemPrompt(BASE).split("用户位置")[0]));
});

test("explorer agent mounts delegate_task only via extraTools/canDelegate", async (t) => {
  const repo = seededRepo(t);
  const plain = await createExplorerAgent({ config: CONFIG, repository: repo, currentDate: BASE });
  assert.deepEqual(plain.state.tools.map((tool) => tool.name), [SEARCH_EVENTS_TOOL]);
  assert.equal(plain.state.systemPrompt, buildSystemPrompt(BASE));
  assert.ok(!plain.state.systemPrompt.includes(DELEGATE_TASK_TOOL));

  const sessions = openMemoryRepo(t);
  const delegateTool = createDelegateTaskTool({
    getContext: () => undefined,
    repository: repo,
    sessions,
    spawnChild: async () => {
      throw new Error("unused in this test");
    },
  });
  const delegated = await createExplorerAgent({
    config: CONFIG,
    repository: repo,
    currentDate: BASE,
    canDelegate: true,
    extraTools: [delegateTool],
  });
  assert.deepEqual(delegated.state.tools.map((tool) => tool.name), [
    SEARCH_EVENTS_TOOL,
    DELEGATE_TASK_TOOL,
  ]);
  assert.equal(delegated.state.systemPrompt, buildSystemPrompt(BASE, { canDelegate: true }));

  // 挂了工具但没开提示词开关：提示词仍不提派发（防幻觉调用方向反过来才需要）。
  const silent = await createExplorerAgent({
    config: CONFIG,
    repository: repo,
    currentDate: BASE,
    canDelegate: false,
    extraTools: [delegateTool],
  });
  assert.deepEqual(silent.state.tools.map((tool) => tool.name), [
    SEARCH_EVENTS_TOOL,
    DELEGATE_TASK_TOOL,
  ]);
  assert.equal(silent.state.systemPrompt, buildSystemPrompt(BASE));
});

test("parsePlannerResponse parses clarify and itinerary envelopes", () => {
  const clarify = parsePlannerResponse('{"type":"clarify","question":"哪天去？"}');
  assert.deepEqual(clarify, { type: "clarify", question: "哪天去？" });

  const fenced = '```json\n{"type":"itinerary","constraints":{"date":"2026-11-14","availableStart":"13:00"},"itinerary":{"date":"2026-11-14","summary":"s","stops":[]}}\n```';
  const it = parsePlannerResponse(fenced);
  assert.equal(it.type, "itinerary");
  if (it.type === "itinerary") {
    assert.equal(it.constraints.date, "2026-11-14");
    assert.equal(it.constraints.availableStart, "13:00");
    assert.deepEqual(it.candidate, { date: "2026-11-14", summary: "s", stops: [] });
  }
});

test("parsePlannerResponse parses comparison envelope：A/B 双方案 + 共享 constraints", () => {
  const parsed = parsePlannerResponse(
    '{"type":"comparison","constraints":{"date":"2026-11-14","availableStart":"09:00"},' +
      '"plans":[' +
      '{"label":"A","title":"城墙经典","itinerary":{"date":"2026-11-14","summary":"a","stops":[]}},' +
      '{"label":"B","title":"博物馆深度","itinerary":{"date":"2026-11-14","summary":"b","stops":[]}}' +
      "]}",
  );
  assert.equal(parsed.type, "comparison");
  if (parsed.type !== "comparison") return;
  assert.equal(parsed.constraints.date, "2026-11-14");
  assert.equal(parsed.constraints.availableStart, "09:00");
  assert.equal(parsed.plans.length, 2);
  assert.deepEqual(
    parsed.plans.map((p) => [p.label, p.title]),
    [
      ["A", "城墙经典"],
      ["B", "博物馆深度"],
    ],
  );
  assert.deepEqual(parsed.plans[1].candidate, {
    date: "2026-11-14",
    summary: "b",
    stops: [],
  });
});

test("parsePlannerResponse rejects malformed comparison envelopes（plans 数组/label/title）", () => {
  const base =
    '{"type":"comparison","constraints":{"date":"2026-11-14"},"plans":__PLANS__}';
  for (const plans of [
    "[]", // 空数组
    '[{"label":"A","title":"a","itinerary":{}}]', // 只有一条
    '[{"label":"A","title":"a","itinerary":{}},{"label":"B","title":"b","itinerary":{}},{"label":"A","title":"c","itinerary":{}}]', // 三条
    '[{"label":"A","title":"a","itinerary":{}},{"label":"A","title":"b","itinerary":{}}]', // label 重复
    '[{"label":"C","title":"a","itinerary":{}},{"label":"B","title":"b","itinerary":{}}]', // label 非 A/B
    '[{"label":"A","title":" ","itinerary":{}},{"label":"B","title":"b","itinerary":{}}]', // title 空白
    '[{"label":"A","itinerary":{}},{"label":"B","title":"b","itinerary":{}}]', // 缺 title
    '[{"label":"A","title":"a"},{"label":"B","title":"b","itinerary":{}}]', // 缺 itinerary
    '["x",{"label":"B","title":"b","itinerary":{}}]', // 元素非对象
  ]) {
    assert.throws(
      () => parsePlannerResponse(base.replace("__PLANS__", plans)),
      PlannerResponseError,
      plans,
    );
  }
  // comparison 缺 constraints / constraints 不合法同样被拒。
  assert.throws(
    () => parsePlannerResponse('{"type":"comparison","plans":[{"label":"A","title":"a","itinerary":{}},{"label":"B","title":"b","itinerary":{}}]}'),
    PlannerResponseError,
  );
});

test("parseConstraints keeps null as explicit clear but rejects unreal values", () => {
  const ok = parsePlannerResponse(
    '{"type":"itinerary","constraints":{"date":"2026-11-14","availableStart":null},"itinerary":{"date":"2026-11-14","summary":"s","stops":[]}}',
  );
  assert.equal(ok.type, "itinerary");
  if (ok.type === "itinerary") assert.equal(ok.constraints.availableStart, null);

  for (const bad of [
    '{"type":"itinerary","constraints":{"date":"2026-02-30"},"itinerary":{}}',
    '{"type":"itinerary","constraints":{"date":"周六"},"itinerary":{}}',
    '{"type":"itinerary","constraints":{"date":"2026-11-14","availableStart":"99:00"},"itinerary":{}}',
    '{"type":"itinerary","constraints":{"date":"2026-11-14","availableEnd":"12:60"},"itinerary":{}}',
    '{"type":"itinerary","constraints":{"date":"2026-11-14","availableStart":13},"itinerary":{}}',
    '{"type":"itinerary","constraints":{"date":"2026-11-14","availableStart":"18:00","availableEnd":"13:00"},"itinerary":{}}',
  ]) {
    assert.throws(() => parsePlannerResponse(bad), PlannerResponseError, bad);
  }
});

test("parsePlannerResponse rejects non-envelope replies with a usable message", () => {
  for (const bad of [
    "not json at all",
    '{"date":"2026-11-14","summary":"x","stops":[]}', // 裸行程，无 envelope
    '{"type":"other"}',
    '{"type":"clarify"}',
    '{"type":"itinerary","itinerary":{}}', // 无 constraints
    '{"type":"itinerary","constraints":{"date":"周六"},"itinerary":{}}',
  ]) {
    assert.throws(() => parsePlannerResponse(bad), PlannerResponseError, bad);
  }
});

test("extractEventIds pulls unique event_id strings out of a candidate", () => {
  const candidate = {
    stops: [
      { event_id: "a" },
      { event_id: "b" },
      { event_id: "a" },
      { event_id: 3 },
      "nope",
    ],
  };
  assert.deepEqual(extractEventIds(candidate), ["a", "b"]);
  assert.deepEqual(extractEventIds({}), []);
  assert.deepEqual(extractEventIds(null), []);
});

test("lastAssistantText reads the trailing assistant message only", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "hi", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "第一部分" }, { type: "text", text: "第二部分" }],
      api: "openai-completions",
      provider: "openai",
      model: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 2,
    },
  ];
  assert.equal(lastAssistantText(messages), "第一部分第二部分");
  assert.equal(lastAssistantText(messages.slice(0, 1)), undefined);
});

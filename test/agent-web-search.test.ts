import assert from "node:assert/strict";
import { test } from "node:test";
import { SEARCH_EVENTS_TOOL } from "../src/agent/tools.ts";
import { ESTIMATE_TRAVEL_TOOL } from "../src/agent/travel-tool.ts";
import { createExplorerAgent } from "../src/agent/explorer-agent.ts";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import {
  createWebSearchTool,
  WEB_SEARCH_TOOL,
} from "../src/agent/web-search.ts";
import type { WebSearchDetails } from "../src/agent/web-search.ts";
import { loadConfig } from "../src/config.ts";
import type { ExplorerConfig } from "../src/config.ts";
import type { EventRepository } from "../src/data/repository.ts";

/**
 * web_search 工具与装配链路的离线测试：注入假 fetch 覆盖解析/截断、
 * HTTP 错误、超时与取消、无 key 路径，以及 explorer agent 按 key 挂载。
 */

const BASE = "2026-11-11";

const CONFIG: ExplorerConfig = {
  provider: "openai",
  model: "gpt-5.4",
  apiKey: "k",
  contextWindow: 128_000,
  maxTokens: 4096,
  dbPath: "unused.db",
};

function stubRepository(): EventRepository {
  return {
    search: async () => [],
    getByIds: async () => new Map(),
    close: () => {},
  };
}

interface FetchCall {
  input: string | URL | Request;
  init?: RequestInit;
}

/** 记录调用并按 handler 应答的 fetch 桩。 */
function stubFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response> | Response,
): { fetchFn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetchFn: ((input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(handler(input, init));
    }) as typeof fetch,
  };
}

/** 挂起直到 signal abort 的 fetch 桩：用 signal.reason reject，模拟真实 fetch 的中断语义。 */
function hangingFetch(): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rawResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rerank_score: 2.4,
    title: "标题",
    url: "https://example.com/a",
    snippet: "短摘录",
    summary: "面向模型阅读的长摘要",
    content: "",
    site_name: "Example",
    site_icon: null,
    date: null,
    authority: 3,
    ...overrides,
  };
}

function details(result: { content: unknown[] }): WebSearchDetails {
  return JSON.parse((result.content[0] as { text: string }).text) as WebSearchDetails;
}

// ---- web_search 工具 ----

test("web_search posts DeepSeek contract and maps compact results", async () => {
  const { fetchFn, calls } = stubFetch(() =>
    jsonResponse({ results: [rawResult(), rawResult({ title: "B", url: "https://b" })] }),
  );
  const tool = createWebSearchTool({ apiKey: "sk-test", fetchFn });
  assert.equal(tool.name, WEB_SEARCH_TOOL);

  const result = await tool.execute("t1", { query: "西安 陕历博 预约" });
  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);

  const call = calls[0];
  assert.equal(String(call.input), "https://api.deepseek.com/v1/tools/search");
  assert.equal(call.init?.method, "POST");
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer sk-test");
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    query: "西安 陕历博 预约",
    count: 5,
    need_content: false,
  });

  const payload = details(result);
  assert.equal(payload.query, "西安 陕历博 预约");
  assert.deepEqual(payload.results, [
    { title: "标题", url: "https://example.com/a", snippet: "面向模型阅读的长摘要" },
    { title: "B", url: "https://b", snippet: "面向模型阅读的长摘要" },
  ]);
});

test("web_search prefers summary then snippet, truncates and caps at 10", async () => {
  const long = "很　长".repeat(400) + "\n\n第二段　　结尾";
  const rows = [
    rawResult({ title: "t1", summary: long }),
    rawResult({ title: "t2", summary: "", snippet: "只有snippet" }),
    rawResult({ title: "t3", summary: "", snippet: "", content: " 只剩\n正文 " }),
    rawResult({ title: "", url: "https://no-title" }),
    rawResult({ title: "no-url", url: "" }),
    "not-an-object",
  ];
  // 13 条合法结果验证总数封顶 10。
  for (let i = 0; i < 12; i += 1) rows.push(rawResult({ title: `f${i}`, url: `https://f${i}` }));
  const { fetchFn } = stubFetch(() => jsonResponse({ results: rows }));
  const tool = createWebSearchTool({ apiKey: "k", fetchFn });

  const result = await tool.execute("t2", { query: "q", count: 50 });
  const payload = details(result);
  assert.equal(result.isError, false);
  assert.equal(payload.results?.length, 10);

  const first = payload.results?.[0];
  assert.equal(first?.snippet.length, 501);
  assert.ok(first?.snippet.endsWith("…"));
  assert.ok(!first?.snippet.includes("\n"));
  assert.equal(payload.results?.[1].snippet, "只有snippet");
  assert.equal(payload.results?.[2].snippet, "只剩 正文");
});

test("web_search clamps count to 1..10 and tolerates junk", async () => {
  const { fetchFn, calls } = stubFetch(() => jsonResponse({ results: [] }));
  const tool = createWebSearchTool({ apiKey: "k", fetchFn });

  await tool.execute("t3", { query: "q", count: 99 });
  assert.equal(JSON.parse(String(calls[0].init?.body)).count, 10);
  await tool.execute("t4", { query: "q", count: -3 });
  assert.equal(JSON.parse(String(calls[1].init?.body)).count, 1);
  await tool.execute("t5", { query: "q", count: 3.9 });
  assert.equal(JSON.parse(String(calls[2].init?.body)).count, 3);
  await tool.execute("t6", { query: "q", count: Number.NaN });
  assert.equal(JSON.parse(String(calls[3].init?.body)).count, 5);
});

test("web_search maps http errors and malformed responses to isError", async () => {
  const { fetchFn } = stubFetch(() => new Response("unauthorized", { status: 401 }));
  const tool = createWebSearchTool({ apiKey: "k", fetchFn });
  const denied = await tool.execute("t7", { query: "q" });
  assert.equal(denied.isError, true);
  assert.match(details(denied).error ?? "", /HTTP 401/);

  const malformed = createWebSearchTool({
    apiKey: "k",
    fetchFn: stubFetch(() => jsonResponse({ results: "not-an-array" })).fetchFn,
  });
  const bad = await malformed.execute("t8", { query: "q" });
  assert.equal(bad.isError, true);
  assert.match(details(bad).error ?? "", /格式异常/);

  const network = createWebSearchTool({
    apiKey: "k",
    fetchFn: stubFetch(() => {
      throw new Error("socket hang up");
    }).fetchFn,
  });
  const down = await network.execute("t9", { query: "q" });
  assert.equal(down.isError, true);
  assert.match(details(down).error ?? "", /socket hang up/);
});

test("web_search enforces hard timeout and honors caller abort", async () => {
  const tool = createWebSearchTool({ apiKey: "k", fetchFn: hangingFetch(), timeoutMs: 20 });
  const timedOut = await tool.execute("t10", { query: "q" });
  assert.equal(timedOut.isError, true);
  assert.match(details(timedOut).error ?? "", /超时/);

  const caller = new AbortController();
  const pending = tool.execute("t11", { query: "q" }, caller.signal);
  caller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.isError, true);
  assert.match(details(cancelled).error ?? "", /取消/);
});

test("web_search without key or empty query returns structured error, never throws", async () => {
  const { fetchFn, calls } = stubFetch(() => jsonResponse({ results: [] }));
  const tool = createWebSearchTool({ fetchFn });
  const noKey = await tool.execute("t12", { query: "q" });
  assert.equal(noKey.isError, true);
  assert.match(details(noKey).error ?? "", /未配置/);
  assert.equal(calls.length, 0);

  const keyed = createWebSearchTool({ apiKey: "  ", fetchFn });
  const blankKey = await keyed.execute("t13", { query: "q" });
  assert.equal(blankKey.isError, true);
  assert.equal(calls.length, 0);

  const empty = await keyed.execute("t14", { query: "   " });
  assert.equal(empty.isError, true);
  assert.match(details(empty).error ?? "", /不能为空/);
});

// ---- explorer agent 挂载 ----

test("explorer agent mounts web_search only when search is configured", async () => {
  const repo = stubRepository();

  // 无 key：不挂工具，提示词不含 web_search（实时问答规则也在挂载段内，
  // 未挂载时连工具名都不出现）。
  const plain = await createExplorerAgent({ config: CONFIG, repository: repo, currentDate: BASE });
  assert.deepEqual(
    plain.state.tools.map((t) => t.name),
    [SEARCH_EVENTS_TOOL],
  );
  assert.ok(!plain.state.systemPrompt.includes(WEB_SEARCH_TOOL));
  assert.ok(!plain.state.systemPrompt.includes("联网补盲"));

  // 有 key：挂工具，提示词附联网补盲边界。
  const keyed = await createExplorerAgent({
    config: { ...CONFIG, webSearchKey: "K" },
    repository: repo,
    currentDate: BASE,
  });
  assert.deepEqual(
    keyed.state.tools.map((t) => t.name),
    [SEARCH_EVENTS_TOOL, WEB_SEARCH_TOOL],
  );
  assert.ok(keyed.state.systemPrompt.includes(WEB_SEARCH_TOOL));
  assert.ok(keyed.state.systemPrompt.includes("event_id 只能来自 search_events"));

  // 无 key 但注入 fetch 桩：照样挂载（测试/替代实现路径）。
  const injected = await createExplorerAgent({
    config: CONFIG,
    repository: repo,
    currentDate: BASE,
    webSearchFetch: stubFetch(() => jsonResponse({ results: [] })).fetchFn,
  });
  assert.deepEqual(
    injected.state.tools.map((t) => t.name),
    [SEARCH_EVENTS_TOOL, WEB_SEARCH_TOOL],
  );

  // 有 key 但显式 webSearchFetch: null → 强制关闭联网搜索。
  const disabled = await createExplorerAgent({
    config: { ...CONFIG, webSearchKey: "K" },
    repository: repo,
    currentDate: BASE,
    webSearchFetch: null,
  });
  assert.deepEqual(
    disabled.state.tools.map((t) => t.name),
    [SEARCH_EVENTS_TOOL],
  );
  assert.ok(!disabled.state.systemPrompt.includes(WEB_SEARCH_TOOL));
  assert.ok(!disabled.state.systemPrompt.includes("联网补盲"));

  // 两个降级链可叠加：算路 + 联网搜索同时挂载。
  const both = await createExplorerAgent({
    config: { ...CONFIG, amapKey: "K", webSearchKey: "K" },
    repository: repo,
    currentDate: BASE,
  });
  assert.deepEqual(
    both.state.tools.map((t) => t.name),
    [SEARCH_EVENTS_TOOL, ESTIMATE_TRAVEL_TOOL, WEB_SEARCH_TOOL],
  );
});

test("system prompt stays byte-identical unless canWebSearch is true", () => {
  assert.equal(buildSystemPrompt(BASE), buildSystemPrompt(BASE, {}));
  assert.equal(buildSystemPrompt(BASE), buildSystemPrompt(BASE, { canWebSearch: false }));
  const searching = buildSystemPrompt(BASE, { canWebSearch: true });
  assert.ok(searching.includes(WEB_SEARCH_TOOL));
  assert.ok(searching.includes("联网补盲"));
  // 与既有开关可叠加：搜索段落在算路/委派段落之后照常追加。
  const all = buildSystemPrompt(BASE, {
    canDelegate: true,
    canEstimateTravel: true,
    canWebSearch: true,
  });
  assert.ok(all.includes("子任务委派") && all.includes(WEB_SEARCH_TOOL));
});

// ---- loadConfig 新环境变量 ----

test("loadConfig reads EXPLORER_WEB_SEARCH_KEY with DEEPSEEK_API_KEY fallback", () => {
  assert.equal(loadConfig({ EXPLORER_API_KEY: "k" }).webSearchKey, undefined);
  assert.equal(
    loadConfig({ EXPLORER_API_KEY: "k", DEEPSEEK_API_KEY: "ds" }).webSearchKey,
    "ds",
  );
  assert.equal(
    loadConfig({
      EXPLORER_API_KEY: "k",
      EXPLORER_WEB_SEARCH_KEY: "  ws  ",
      DEEPSEEK_API_KEY: "ds",
    }).webSearchKey,
    "ws",
  );
  // 空白视为未设置：仍回退 DEEPSEEK_API_KEY；两者皆空才是 undefined。
  assert.equal(
    loadConfig({
      EXPLORER_API_KEY: "k",
      EXPLORER_WEB_SEARCH_KEY: "   ",
      DEEPSEEK_API_KEY: "ds",
    }).webSearchKey,
    "ds",
  );
  assert.equal(
    loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_WEB_SEARCH_KEY: "   " }).webSearchKey,
    undefined,
  );
});

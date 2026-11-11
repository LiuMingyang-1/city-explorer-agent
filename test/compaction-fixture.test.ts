// compaction-* 测试共享的离线夹具：faux provider + 内存 Agent，不触真实 API、
// 不读 .env、不装新依赖。文件名带 .test 后缀只为保持在任务 03 的文件归属
// （test/compaction-*.test.ts）内；除末尾的夹具自测外不含用例。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type Api,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import type { CompactionOptions } from "../src/compaction/compact.ts";
import { compactionDefaults } from "../src/compaction/options.ts";

export const noUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function testModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "faux-model",
    name: "faux-model",
    api: "openai-completions",
    provider: "faux",
    baseUrl: "http://faux.invalid",
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 20_000,
    maxTokens: 8_192,
    ...overrides,
  };
}

/** Agent wired to the faux provider; streamFn can be replaced for inspection. */
export function makeAgent(model: Model<Api> = testModel()) {
  const faux = createFauxCore({});
  const agent = new Agent({
    initialState: { model, systemPrompt: "Test system prompt." },
    streamFn: (m, context, options) => faux.streamSimple(m, context, options),
    getApiKey: () => "unused",
  });
  return { agent, faux, model };
}

/**
 * 测试默认压缩参数：小 keepRecent/maxTokens 便于控制边界；
 * 覆盖字段通过 overrides 传入。
 */
export function makeOptions(overrides: Partial<CompactionOptions> = {}): CompactionOptions {
  return {
    ...compactionDefaults,
    compactionKeepRecentTokens: 100,
    maxTokens: 100,
    ...overrides,
  };
}

export const user = (content: string, timestamp = 1): AgentMessage => ({
  role: "user",
  content,
  timestamp,
});

export const system = (content = "Test system prompt.", timestamp = 0): AgentMessage => ({
  role: "system",
  content,
  timestamp,
});

/** assistant toolCall + 对应 toolResult 组成的不可分割批次。 */
export function toolBatch(label: string, size = 600): AgentMessage[] {
  const call = fauxToolCall("search_events", { date: "2026-11-14", keyword: label });
  return [
    fauxAssistantMessage(call, { stopReason: "toolUse" }),
    {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: `${label} ${"r".repeat(size)}` }],
      isError: false,
      timestamp: 2,
    },
  ];
}

test("fixture drives the agent fully offline", async () => {
  const { agent, faux } = makeAgent();
  faux.setResponses([fauxAssistantMessage("done")]);
  await agent.prompt("hello");
  assert.equal(faux.state.callCount, 1);
  assert.equal(agent.state.messages.at(-1)?.role, "assistant");
});

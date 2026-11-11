import assert from "node:assert/strict";
import { test } from "node:test";
import { createExplorerModels } from "../src/agent/model.ts";
import {
  compactionDefaults,
  loadCompactionOptions,
  resolveCompactionOptions,
} from "../src/compaction/options.ts";
import { loadConfig, type ExplorerConfig } from "../src/config.ts";

test("loadCompactionOptions defaults to 0.8 / 20000 / 8192", () => {
  assert.deepEqual(loadCompactionOptions({}), {
    compactionThreshold: 0.8,
    compactionKeepRecentTokens: 20_000,
    compactionMaxTokens: 8_192,
  });
  assert.deepEqual(compactionDefaults, loadCompactionOptions({}));
});

test("loadCompactionOptions reads EXPLORER_COMPACTION_* overrides", () => {
  assert.deepEqual(
    loadCompactionOptions({
      EXPLORER_COMPACTION_THRESHOLD: "0.5",
      EXPLORER_COMPACTION_KEEP_RECENT_TOKENS: "12000",
      EXPLORER_COMPACTION_MAX_TOKENS: "4096",
    }),
    {
      compactionThreshold: 0.5,
      compactionKeepRecentTokens: 12_000,
      compactionMaxTokens: 4_096,
    },
  );
});

test("loadCompactionOptions rejects out-of-range thresholds and non-integers", () => {
  for (const bad of ["0", "1", "1.5", "-0.3", "abc"])
    assert.throws(
      () => loadCompactionOptions({ EXPLORER_COMPACTION_THRESHOLD: bad }),
      /EXPLORER_COMPACTION_THRESHOLD/,
    );
  for (const name of [
    "EXPLORER_COMPACTION_KEEP_RECENT_TOKENS",
    "EXPLORER_COMPACTION_MAX_TOKENS",
  ] as const) {
    for (const bad of ["0", "-5", "4.5", "x"])
      assert.throws(
        () => loadCompactionOptions({ [name]: bad }),
        /must be a positive safe integer/,
      );
  }
});

test("resolveCompactionOptions fills defaults and the reply budget", () => {
  assert.deepEqual(resolveCompactionOptions({ maxTokens: 4_096 }), {
    compactionThreshold: 0.8,
    compactionKeepRecentTokens: 20_000,
    compactionMaxTokens: 8_192,
    maxTokens: 4_096,
  });
  assert.deepEqual(
    resolveCompactionOptions({
      maxTokens: 4_096,
      compaction: { compactionThreshold: 0.6, maxTokens: 2_048 },
    }),
    {
      compactionThreshold: 0.6,
      compactionKeepRecentTokens: 20_000,
      compactionMaxTokens: 8_192,
      maxTokens: 2_048,
    },
  );
  assert.throws(
    () =>
      resolveCompactionOptions({ maxTokens: 4_096, compaction: { compactionThreshold: 1 } }),
    /compactionThreshold/,
  );
  assert.throws(
    () =>
      resolveCompactionOptions({ maxTokens: 4_096, compaction: { compactionMaxTokens: 0 } }),
    /positive safe integer/,
  );
});

test("loadConfig exposes resolved compaction options", () => {
  const loaded = loadConfig({ EXPLORER_API_KEY: "k" });
  assert.deepEqual(loaded.compaction, {
    compactionThreshold: 0.8,
    compactionKeepRecentTokens: 20_000,
    compactionMaxTokens: 8_192,
    maxTokens: 4_096,
  });
  const tuned = loadConfig({
    EXPLORER_API_KEY: "k",
    EXPLORER_MAX_TOKENS: "2048",
    EXPLORER_COMPACTION_THRESHOLD: "0.6",
  });
  assert.equal(tuned.compaction?.maxTokens, 2_048);
  assert.equal(tuned.compaction?.compactionThreshold, 0.6);
  assert.throws(
    () => loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_COMPACTION_THRESHOLD: "2" }),
    /EXPLORER_COMPACTION_THRESHOLD/,
  );
});

function customConfig(overrides: Partial<ExplorerConfig> = {}): ExplorerConfig {
  return {
    provider: "openai",
    model: "my-model",
    baseUrl: "http://localhost:8080/v1",
    apiKey: "k",
    contextWindow: 128_000,
    maxTokens: 4_096,
    dbPath: "x.db",
    ...overrides,
  };
}

test("explicit config without compaction stays compatible and covers the summary budget", () => {
  const config = customConfig();
  const { model } = createExplorerModels(config);
  // 声明上限覆盖默认摘要预算 8192；普通回复的每请求预算仍是 config.maxTokens
  assert.equal(model.maxTokens, 8_192);
  assert.equal(Math.min(config.maxTokens, model.maxTokens), 4_096);
  assert.equal(config.maxTokens, 4_096);
});

test("declared maxTokens covers compactionMaxTokens but never the context window", () => {
  assert.equal(
    createExplorerModels(customConfig({ compaction: { compactionMaxTokens: 2_048 } })).model
      .maxTokens,
    4_096,
  );
  assert.equal(
    createExplorerModels(customConfig({ compaction: { compactionMaxTokens: 16_000 } })).model
      .maxTokens,
    16_000,
  );
  assert.equal(
    createExplorerModels(
      customConfig({ contextWindow: 10_000, compaction: { compactionMaxTokens: 16_000 } }),
    ).model.maxTokens,
    10_000,
  );
  // 标准 provider 的目录元数据不被 compaction 配置放大（gpt-5.4 目录值 128000）
  const catalog = createExplorerModels({
    provider: "openai",
    model: "gpt-5.4",
    apiKey: "k",
    contextWindow: 128_000,
    maxTokens: 4_096,
    dbPath: "x.db",
    compaction: { compactionMaxTokens: 200_000 },
  });
  assert.equal(catalog.model.maxTokens, 128_000);
});

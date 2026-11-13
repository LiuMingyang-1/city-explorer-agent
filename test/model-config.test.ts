import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createExplorerModels } from "../src/agent/model.ts";
import { loadConfig } from "../src/config.ts";
import type { ExplorerConfig } from "../src/config.ts";

function config(overrides: Partial<ExplorerConfig> = {}): ExplorerConfig {
  return {
    provider: "openai",
    model: "gpt-5.4",
    apiKey: "k",
    contextWindow: 128_000,
    maxTokens: 4096,
    dbPath: "data/events.db",
    ...overrides,
  };
}

test("loadConfig reads EXPLORER_* env with defaults", () => {
  const loaded = loadConfig({ EXPLORER_API_KEY: "k" });
  assert.equal(loaded.provider, "openai");
  assert.equal(loaded.model, "gpt-5.4");
  assert.equal(loaded.contextWindow, 128_000);
  assert.equal(loaded.maxTokens, 4096);
  assert.equal(loaded.apiKey, "k");
  assert.equal(loaded.baseUrl, undefined);
  assert.equal(loaded.userId, "local"); // 缺省本地演示用户
  assert.ok(loaded.sessionDbPath?.endsWith(join("data", "sessions.db")));
});

test("EXPLORER_USER_ID blank or whitespace falls back to 'local'", () => {
  for (const value of [undefined, "", "   ", " \t "]) {
    assert.equal(
      loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_USER_ID: value }).userId,
      "local",
    );
  }
  assert.equal(
    loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_USER_ID: "web-42" }).userId,
    "web-42",
  );
});

test("EXPLORER_SESSION_DB_PATH overrides the session db location", () => {
  const loaded = loadConfig({
    EXPLORER_API_KEY: "k",
    EXPLORER_SESSION_DB_PATH: "tmp/my-sessions.db",
  });
  assert.ok(loaded.sessionDbPath?.endsWith(join("tmp", "my-sessions.db")));
  // 会话库与活动库相互独立。
  assert.notEqual(loaded.sessionDbPath, loaded.dbPath);
});

test("EXPLORER_SESSION_ID pins a session; unset or blank falls back to undefined", () => {
  assert.equal(loadConfig({ EXPLORER_API_KEY: "k" }).sessionId, undefined);
  for (const value of ["", "   ", " \t "]) {
    assert.equal(
      loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_SESSION_ID: value }).sessionId,
      undefined,
    );
  }
  assert.equal(
    loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_SESSION_ID: "  sess-42  " }).sessionId,
    "sess-42",
  );
});

test("EXPLORER_MEMORY_MIN_USER_MESSAGES defaults to 3 and validates positive integers", () => {
  assert.equal(loadConfig({ EXPLORER_API_KEY: "k" }).memoryMinUserMessages, 3);
  assert.equal(
    loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_MEMORY_MIN_USER_MESSAGES: "7" })
      .memoryMinUserMessages,
    7,
  );
  for (const bad of ["abc", "0", "-5", "4.5"]) {
    assert.throws(
      () => loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_MEMORY_MIN_USER_MESSAGES: bad }),
      /EXPLORER_MEMORY_MIN_USER_MESSAGES/,
    );
  }
});

test("EXPLORER_SUBAGENT_* defaults to 8 / 120000 and validates positive integers", () => {
  const loaded = loadConfig({ EXPLORER_API_KEY: "k" });
  assert.equal(loaded.subagentMaxConcurrent, 8);
  assert.equal(loaded.subagentTimeoutMs, 120_000);
  const custom = loadConfig({
    EXPLORER_API_KEY: "k",
    EXPLORER_SUBAGENT_MAX_CONCURRENT: "4",
    EXPLORER_SUBAGENT_TIMEOUT_MS: "60000",
  });
  assert.equal(custom.subagentMaxConcurrent, 4);
  assert.equal(custom.subagentTimeoutMs, 60_000);
  for (const bad of ["abc", "0", "-5", "4.5"]) {
    assert.throws(
      () => loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_SUBAGENT_MAX_CONCURRENT: bad }),
      /EXPLORER_SUBAGENT_MAX_CONCURRENT/,
    );
    assert.throws(
      () => loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_SUBAGENT_TIMEOUT_MS: bad }),
      /EXPLORER_SUBAGENT_TIMEOUT_MS/,
    );
  }
});

test("loadConfig requires an API key", () => {
  assert.throws(() => loadConfig({}), /EXPLORER_API_KEY|OPENAI_API_KEY/);
});

test("loadConfig falls back to provider standard env key", () => {
  const loaded = loadConfig({ ANTHROPIC_API_KEY: "k", EXPLORER_PROVIDER: "anthropic" });
  assert.equal(loaded.provider, "anthropic");
  assert.equal(loaded.apiKey, "k");
  assert.equal(loaded.model, "claude-sonnet-4-6");
});

test("loadConfig requires EXPLORER_MODEL when EXPLORER_BASE_URL is set", () => {
  assert.throws(
    () => loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_BASE_URL: "http://localhost:8080" }),
    /EXPLORER_MODEL/,
  );
});

test("loadConfig validates EXPLORER_BASE_URL", () => {
  for (const bad of [
    "not a url",
    "ftp://example.com",
    "http://user:pass@example.com",
    "http://example.com/v1?x=1",
    "http://example.com/v1#frag",
  ]) {
    assert.throws(
      () =>
        loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_BASE_URL: bad, EXPLORER_MODEL: "m" }),
      /EXPLORER_BASE_URL/,
    );
  }
});

test("loadConfig rejects a custom provider without EXPLORER_BASE_URL", () => {
  assert.throws(
    () => loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_PROVIDER: "deepseek" }),
    /EXPLORER_PROVIDER.*EXPLORER_BASE_URL/,
  );
});

test("loadConfig rejects non-positive-integer numeric env", () => {
  for (const bad of ["abc", "0", "-5", "4.5"]) {
    assert.throws(
      () => loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_MAX_TOKENS: bad }),
      /EXPLORER_MAX_TOKENS/,
    );
    assert.throws(
      () => loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_CONTEXT_WINDOW: bad }),
      /EXPLORER_CONTEXT_WINDOW/,
    );
  }
});

test("createExplorerModels resolves a catalog model for a standard provider", () => {
  const { models, model } = createExplorerModels(config());
  assert.equal(model.id, "gpt-5.4");
  assert.equal(model.provider, "openai");
  assert.equal(model.api, "openai-responses");
  assert.equal(models.getModel("openai", "gpt-5.4"), model);
});

test("createExplorerModels builds a completions model for a custom OpenAI-compatible baseUrl", () => {
  const { model } = createExplorerModels(
    config({ model: "my-model", baseUrl: "http://localhost:8080/v1", maxTokens: 8192 }),
  );
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "http://localhost:8080/v1");
  assert.equal(model.maxTokens, 8192);
  assert.equal(model.contextWindow, 128_000);
});

test("createExplorerModels uses anthropic-messages for a custom anthropic baseUrl", () => {
  const { model } = createExplorerModels(
    config({
      provider: "anthropic",
      model: "claude-custom",
      baseUrl: "http://localhost:9090",
      contextWindow: 200_000,
    }),
  );
  assert.equal(model.api, "anthropic-messages");
  assert.equal(model.contextWindow, 200_000);
});

test("createExplorerModels throws for a model missing from the provider catalog", () => {
  assert.throws(
    () => createExplorerModels(config({ model: "no-such-model" })),
    /Unknown model: openai\/no-such-model/,
  );
});

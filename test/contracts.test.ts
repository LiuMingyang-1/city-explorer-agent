import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import type { Itinerary } from "../src/itinerary/types.ts";

test("loadConfig reads EXPLORER_* env", () => {
  const config = loadConfig({
    EXPLORER_API_KEY: "k",
    EXPLORER_MODEL: "test-model",
    EXPLORER_DB_PATH: "x.db",
  });
  assert.equal(config.provider, "openai");
  assert.equal(config.model, "test-model");
  assert.equal(config.maxTokens, 4096);
  assert.ok(config.dbPath.endsWith("x.db"));
});

test("loadConfig requires an API key", () => {
  assert.throws(() => loadConfig({}), /EXPLORER_API_KEY/);
});

test("Itinerary matches the output JSON shape from the plan", () => {
  const itinerary: Itinerary = {
    date: "2026-11-14",
    summary: "下午先看展，再到附近书店参加阅读活动",
    stops: [
      {
        event_id: "evt_023",
        arrive_at: "13:00",
        leave_at: "14:30",
        reason: "展览主题符合你的兴趣，预留九十分钟参观",
      },
    ],
  };
  assert.equal(itinerary.stops[0].event_id, "evt_023");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createUsageBaseline,
  estimateMessage,
  estimateMessages,
  estimateText,
  recentStart,
} from "../src/compaction/tokens.ts";
import { noUsage, testModel, toolBatch, user } from "./compaction-fixture.test.ts";

test("estimateText prices ASCII at 1/4 and other code points at 1.5", () => {
  assert.equal(estimateText("abcd"), 1);
  assert.equal(estimateText("中文"), 3);
  assert.equal(estimateText("😀"), 2);
  assert.equal(estimateText("abcd中文😀"), 6);
});

test("estimateMessage counts tool arguments and system sections/tools", () => {
  const message = fauxAssistantMessage(
    fauxToolCall("search_events", { keyword: "x".repeat(400) }),
  );
  assert.ok(estimateMessage(message) > 100);
  assert.ok(
    estimateMessage({
      role: "system",
      content: "",
      sections: { rules: "中".repeat(100) },
      timestamp: 0,
    }) > 150,
  );
});

test("recentStart keeps whole tool batches and honors the 1.2 boundary", () => {
  const small = user("a".repeat(100));
  const large = user("a".repeat(500));
  const target = estimateMessage(large) / 1.2;
  assert.equal(recentStart([small, large], target), 2);
  assert.equal(recentStart([small, large], target + 1), 1);
  const batch = toolBatch("展览", 600);
  const messages = [small, ...batch, small];
  const start = recentStart(messages, 150);
  assert.equal(start, messages.length - 1);
  // 超大最新批次不可拆 → 空尾部；目标足够大 → 整批保留
  assert.equal(recentStart(batch, 100), batch.length);
  assert.equal(recentStart(batch, 1000), 0);
});

test("usage baseline adds only post-observed messages and invalidates on model change", () => {
  const baseline = createUsageBaseline();
  const model = testModel();
  const context = [user("first"), user("second")];
  assert.equal(baseline.estimate(context, model), estimateMessages(context));
  const reply = fauxAssistantMessage("answer");
  reply.usage = {
    ...noUsage,
    input: 5_000,
    output: 100,
    cacheRead: 200,
    cacheWrite: 50,
    totalTokens: 5_350,
  };
  baseline.observe(reply, context, model);
  const appended = user("next");
  const grown = [...context, reply, appended];
  assert.equal(
    baseline.estimate(grown, model),
    5_350 + estimateMessages([reply, appended]),
  );
  // 不同对象引用（如恢复重建的消息）不再命中基线 → 全量估算
  const cloned = structuredClone(grown);
  assert.equal(baseline.estimate(cloned, model), estimateMessages(cloned));
  // 模型变化使基线失效
  assert.equal(
    baseline.estimate(grown, testModel({ maxTokens: 4_096 })),
    estimateMessages(grown),
  );
  baseline.clear();
  assert.equal(baseline.estimate(grown, model), estimateMessages(grown));
});

test("zero, error and non-assistant usage never seed the baseline", () => {
  const baseline = createUsageBaseline();
  const model = testModel();
  const context = [user("q")];
  const zero = fauxAssistantMessage("a");
  zero.usage = { ...noUsage };
  baseline.observe(zero, context, model);
  const failed = fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "401 unauthorized",
  });
  failed.usage = { ...noUsage, input: 9_000, totalTokens: 9_000 };
  baseline.observe(failed, context, model);
  baseline.observe(user("not assistant"), context, model);
  const grown = [...context, zero];
  assert.equal(baseline.estimate(grown, model), estimateMessages(grown));
});

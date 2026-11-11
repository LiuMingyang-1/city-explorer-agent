import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
  type Api,
  fauxAssistantMessage,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { compact } from "../src/compaction/compact.ts";
import { createUsageBaseline } from "../src/compaction/tokens.ts";
import {
  makeAgent,
  makeOptions,
  system,
  testModel,
  toolBatch,
  user,
} from "./compaction-fixture.test.ts";

test("auto mode is a no-op below the threshold and issues no request", async () => {
  const { agent, faux, model } = makeAgent(testModel({ contextWindow: 20_000 }));
  const raw = [user("small question")];
  const result = await compact({
    agent,
    model,
    messages: [system(), ...raw],
    raw,
    baseline: createUsageBaseline(),
    options: makeOptions(),
    manual: false,
  });
  assert.equal(result, undefined);
  assert.equal(faux.state.callCount, 0);
});

test("auto compaction fires at the 80% threshold and accepts an empty kept tail", async () => {
  const { agent, faux, model } = makeAgent(testModel({ contextWindow: 20_000 }));
  const sys = system("s".repeat(2_000));
  const raw = [user("q".repeat(64_000))];
  let summaryBudget: number | undefined;
  agent.streamFunction = (m: Model<Api>, c: TranscriptContext, o?: SimpleStreamOptions) => {
    summaryBudget = o?.maxTokens;
    assert.match(JSON.stringify(c.messages), /qqqq/);
    return faux.streamSimple(m, c, o);
  };
  faux.setResponses([fauxAssistantMessage("早前讨论已纳入摘要")]);
  const result = await compact({
    agent,
    model,
    messages: [sys, ...raw],
    raw,
    baseline: createUsageBaseline(),
    options: makeOptions(),
    manual: false,
  });
  assert.equal(faux.state.callCount, 1);
  // 摘要预算独立：不是普通回复预算（options.maxTokens = 100）
  assert.ok(summaryBudget !== undefined && summaryBudget > 100 && summaryBudget <= 8_192);
  assert.ok(result);
  assert.equal(result.firstKept, raw.length + 1); // 空尾部：全部原文都被摘要覆盖
  assert.equal(result.replacement[0]?.role, "system");
  assert.equal(result.replacement[1]?.role, "user");
  assert.match(JSON.stringify(result.replacement[1]), /早前讨论已纳入摘要/);
  // 摘要消息是普通 user 历史资料，不承诺尚未实现的 read_session_history 工具
  assert.doesNotMatch(JSON.stringify(result.replacement[1]), /read_session_history/);
  assert.ok(result.tokensAfter < result.tokensBefore);
  assert.equal(raw.length, 1); // 输入不被改写
});

test("auto compaction also fires when the next request would not fit", async () => {
  const { agent, faux, model } = makeAgent(
    testModel({ contextWindow: 20_000, maxTokens: 18_000 }),
  );
  const sys = system();
  const raw = [user("a".repeat(8_000)), user("b".repeat(8_000))];
  let summaryBudget: number | undefined;
  agent.streamFunction = (m: Model<Api>, c: TranscriptContext, o?: SimpleStreamOptions) => {
    summaryBudget = o?.maxTokens;
    return faux.streamSimple(m, c, o);
  };
  faux.setResponses([fauxAssistantMessage("摘要")]);
  const result = await compact({
    agent,
    model,
    messages: [sys, ...raw],
    raw,
    baseline: createUsageBaseline(),
    options: makeOptions({ maxTokens: 18_000 }),
    manual: false,
  });
  assert.ok(result);
  assert.equal(summaryBudget, 8_192); // compactionMaxTokens，与回复预留无关
  assert.equal(result.firstKept, raw.length + 1);
  assert.equal(faux.state.callCount, 1);
});

test("kept tail never splits an assistant toolCall/toolResult batch", async () => {
  const { agent, faux, model } = makeAgent(testModel({ contextWindow: 20_000 }));
  const raw = [
    user("帮我规划 11-14 行程"),
    user("x".repeat(4_000)),
    ...toolBatch("展览", 2_000),
    user("最新的问题"),
  ];
  const messages = [system(), ...raw];
  // 边界预算盖住整个批次：firstKept 指向 assistant（批次头），不是 toolResult
  faux.setResponses([fauxAssistantMessage("摘要")]);
  const wide = await compact({
    agent,
    model,
    messages,
    raw,
    baseline: createUsageBaseline(),
    options: makeOptions({ compactionKeepRecentTokens: 600 }),
    manual: true,
  });
  assert.ok(wide);
  assert.equal(wide.firstKept, 3);
  assert.equal(raw[wide.firstKept - 1]?.role, "assistant");
  assert.notEqual(raw[wide.firstKept - 1]?.role, "toolResult");
  assert.deepEqual(wide.replacement.slice(2), raw.slice(2));
  // 预算小到只留最后一条：边界落在 toolResult 之后，不切进批次中间
  faux.setResponses([fauxAssistantMessage("摘要")]);
  const narrow = await compact({
    agent,
    model,
    messages,
    raw,
    baseline: createUsageBaseline(),
    options: makeOptions({ compactionKeepRecentTokens: 20 }),
    manual: true,
  });
  assert.ok(narrow);
  assert.equal(narrow.firstKept, 5);
  assert.equal(raw[narrow.firstKept - 1]?.role, "user");
  assert.deepEqual(narrow.replacement.slice(2), raw.slice(4));
});

test("a boundary outside the raw history rejects before any summary request", async () => {
  const { agent, faux, model } = makeAgent();
  await assert.rejects(
    compact({
      agent,
      model,
      messages: [user("earlier"), user("b".repeat(400))],
      raw: [user("kept")],
      baseline: createUsageBaseline(),
      options: makeOptions(),
      manual: true,
    }),
    /not in the session history/,
  );
  assert.equal(faux.state.callCount, 0);
});

test("manual compaction with nothing old enough returns undefined", async () => {
  const { agent, faux, model } = makeAgent();
  const raw = [user("only message")];
  const result = await compact({
    agent,
    model,
    messages: [system(), ...raw],
    raw,
    baseline: createUsageBaseline(),
    options: makeOptions(),
    manual: true,
  });
  assert.equal(result, undefined);
  assert.equal(faux.state.callCount, 0);
});

test("unfittable context with nothing to cut throws without a request", async () => {
  const { agent, faux, model } = makeAgent(testModel({ contextWindow: 3_000 }));
  const raw = [user("hi")];
  await assert.rejects(
    compact({
      agent,
      model,
      messages: [system("s".repeat(8_000)), ...raw],
      raw,
      baseline: createUsageBaseline(),
      options: makeOptions(),
      manual: true,
    }),
    /do not fit/,
  );
  assert.equal(faux.state.callCount, 0);
});

test("a non-shrinking candidate throws and produces no replacement", async () => {
  const { agent, faux, model } = makeAgent(testModel({ contextWindow: 20_000 }));
  const sys = system("s".repeat(2_000));
  const raw = [user("q".repeat(11_000))];
  const messages = [sys, ...raw];
  faux.setResponses([fauxAssistantMessage("x".repeat(20_000))]);
  const before = [...messages];
  await assert.rejects(
    compact({
      agent,
      model,
      messages,
      raw,
      baseline: createUsageBaseline(),
      options: makeOptions(),
      manual: true,
    }),
    /did not reduce/,
  );
  assert.deepEqual(messages, before);
  assert.equal(faux.state.callCount, 1); // 单次生成，不循环凑目标
});

test("candidate must leave room for the next request plus output budget", async () => {
  const { agent, faux, model } = makeAgent(
    testModel({ contextWindow: 6_000, maxTokens: 5_000 }),
  );
  const sys = system("s".repeat(2_000));
  const raw = [user("q".repeat(11_000))];
  faux.setResponses([fauxAssistantMessage("摘要")]);
  await assert.rejects(
    compact({
      agent,
      model,
      messages: [sys, ...raw],
      raw,
      baseline: createUsageBaseline(),
      options: makeOptions({ maxTokens: 5_000 }),
      manual: true,
    }),
    /did not reduce/,
  );
  assert.equal(faux.state.callCount, 1);
});

test("consecutive compactions advance firstKept and stay monotonic", async () => {
  const { agent, faux, model } = makeAgent(testModel({ contextWindow: 20_000 }));
  const sys = system("s".repeat(300));
  const raw = [user("一".repeat(1_500)), user("二".repeat(1_500)), user("三".repeat(1_500))];
  faux.setResponses([fauxAssistantMessage("摘要一")]);
  const first = await compact({
    agent,
    model,
    messages: [sys, ...raw],
    raw,
    baseline: createUsageBaseline(),
    options: makeOptions({ compactionKeepRecentTokens: 2_300 }),
    manual: true,
  });
  assert.ok(first);
  assert.equal(first.firstKept, 3);
  // 第二轮：raw 继续追加（原始消息永不删除），上下文 = 上次 replacement + 新消息
  const more = [user("四".repeat(1_500)), user("五".repeat(1_500))];
  const raw2 = [...raw, ...more];
  const messages2 = [...first.replacement, ...more];
  faux.setResponses([fauxAssistantMessage("摘要二")]);
  const second = await compact({
    agent,
    model,
    messages: messages2,
    raw: raw2,
    checkpoint: first,
    baseline: createUsageBaseline(),
    options: makeOptions({ compactionKeepRecentTokens: 2_300 }),
    manual: true,
  });
  assert.ok(second);
  assert.ok(second.firstKept > first.firstKept);
  assert.equal(second.firstKept, 5);
  assert.equal(raw2.length, 5);
  // 无新增历史时再压缩：边界不回退，返回 undefined 而不产出空检查点
  const third = await compact({
    agent,
    model,
    messages: second.replacement,
    raw: raw2,
    checkpoint: second,
    baseline: createUsageBaseline(),
    options: makeOptions({ compactionKeepRecentTokens: 2_300 }),
    manual: true,
  });
  assert.equal(third, undefined);
  assert.equal(faux.state.callCount, 2); // 两轮各一次摘要，无额外请求
});

test("compact honors a pre-aborted signal and propagates aborts mid-summary", async () => {
  const { agent, faux, model } = makeAgent(testModel({ contextWindow: 20_000 }));
  const sys = system("s".repeat(2_000));
  const raw = [user("q".repeat(11_000))];
  const input = {
    agent,
    model,
    messages: [sys, ...raw],
    raw,
    baseline: createUsageBaseline(),
    options: makeOptions(),
    manual: true,
  };
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(compact({ ...input, signal: pre.signal }));
  assert.equal(faux.state.callCount, 0);
  const ac = new AbortController();
  agent.streamFunction = (m, c, o) => {
    ac.abort();
    return faux.streamSimple(m, c, o);
  };
  faux.setResponses([fauxAssistantMessage("摘要")]);
  await assert.rejects(compact({ ...input, signal: ac.signal }), /abort/i);
  assert.equal(faux.state.callCount, 1);
});

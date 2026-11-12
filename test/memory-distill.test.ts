import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { distillMemory } from "../src/memory/distill.ts";
import { makeAgent } from "./compaction-fixture.test.ts";
import {
  assistantMessage,
  makeUser,
  mustAcquire,
  openMemoryRepo,
  seedMessages,
  toolResultMessage,
  userMessage,
} from "./session-fixture.ts";

/**
 * 记忆蒸馏离线测试：:memory: sqlite + 真实 SessionRepository 造会话/消息
 * 记录，模型侧用 faux provider（同 compaction-fixture），不触真实 API。
 */

async function makeDistill(t: TestContext) {
  const sessions = openMemoryRepo(t);
  const { user, main } = await makeUser(sessions);
  const writer = await mustAcquire(sessions, user.userId, main.sessionId);
  const { agent, faux, model } = makeAgent();
  return { sessions, user, main, writer, agent, faux, model };
}

test("新 user 消息不足门槛 → skipped，无模型调用、不写库", async (t) => {
  const { sessions, user, main, writer, agent, faux } = await makeDistill(t);
  await seedMessages(sessions, writer, user.userId, main.sessionId, ["你好", "再看一个"]);
  const outcome = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
  });
  assert.equal(outcome.status, "skipped");
  assert.match(outcome.reason ?? "", /未达门槛/);
  assert.equal(outcome.throughMessageSeq, undefined);
  assert.equal(faux.state.callCount, 0);
  assert.equal(await sessions.getUserMemory(user.userId), undefined);
});

test("成功蒸馏：content 落库、through = 该批最后一条 message_seq", async (t) => {
  const { sessions, user, main, writer, agent, faux } = await makeDistill(t);
  let seen: TranscriptContext | undefined;
  agent.streamFunction = (m, c, o) => {
    seen = c;
    return faux.streamSimple(m, c, o);
  };
  await seedMessages(sessions, writer, user.userId, main.sessionId, [
    "我住在西安，周末喜欢看展",
    assistantMessage("{\"itinerary\":{\"summary\":\"下午看展\"}}", {
      toolCalls: [{ id: "call-1" }],
      stopReason: "toolUse",
    }),
    toolResultMessage("call-1"),
    "偏好下午出门，不喜欢早起",
    assistantMessage("{\"itinerary\":{\"summary\":\"书店半天\"}}"),
    "好的就按这个来",
  ]);
  faux.setResponses([
    fauxAssistantMessage("## 用户\n常驻西安\n\n## 偏好\n偏爱展览、下午出门\n\n## 足迹\n2026-11-15 下午看展\n"),
  ]);
  const outcome = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
  });
  assert.equal(outcome.status, "updated");
  const memory = await sessions.getUserMemory(user.userId);
  assert.ok(memory);
  assert.match(memory.content, /## 用户\n常驻西安/);
  assert.equal(memory.sourceSessionId, main.sessionId);
  // 该批最后一条（含 toolResult）的 message_seq
  const records = await sessions.listMessagesFrom(user.userId, main.sessionId, 1);
  const lastSeq = records.at(-1)?.messageSeq;
  assert.equal(memory.throughMessageSeq, lastSeq);
  assert.equal(outcome.throughMessageSeq, lastSeq);
  // 请求含既有文档与新消息；toolResult 不进输入
  const prompt = JSON.stringify(seen);
  assert.match(prompt, /<memory>/);
  assert.match(prompt, /<conversation>/);
  assert.match(prompt, /住在西安/);
  assert.doesNotMatch(prompt, /toolResult/);
});

test("UNCHANGED → content 不变、游标照推", async (t) => {
  const { sessions, user, main, writer, agent, faux } = await makeDistill(t);
  await seedMessages(sessions, writer, user.userId, main.sessionId, [
    "我住在西安",
    "喜欢展览",
    "周末有空",
  ]);
  faux.setResponses([
    fauxAssistantMessage("## 用户\n常驻西安\n\n## 偏好\n喜欢展览\n\n## 足迹\n"),
  ]);
  const first = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
  });
  assert.equal(first.status, "updated");
  const before = await sessions.getUserMemory(user.userId);
  assert.ok(before);

  await seedMessages(sessions, writer, user.userId, main.sessionId, [
    "今天随便逛逛",
    "去公园走走",
    "晚上回家吃饭",
  ]);
  faux.setResponses([fauxAssistantMessage("UNCHANGED")]);
  const second = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
  });
  assert.equal(second.status, "unchanged");
  const after = await sessions.getUserMemory(user.userId);
  assert.ok(after);
  assert.equal(after.content, before.content);
  const lastSeq = (await sessions.listMessagesFrom(user.userId, main.sessionId, 1)).at(-1)
    ?.messageSeq;
  assert.equal(after.throughMessageSeq, lastSeq);
  assert.ok(after.throughMessageSeq > before.throughMessageSeq);
});

test("新消息超 maxRecords → 只喂最早一批，下轮从游标接续", async (t) => {
  const { sessions, user, main, writer, agent, faux } = await makeDistill(t);
  const prompts: string[] = [];
  agent.streamFunction = (m, c, o) => {
    prompts.push(JSON.stringify(c));
    return faux.streamSimple(m, c, o);
  };
  await seedMessages(
    sessions,
    writer,
    user.userId,
    main.sessionId,
    ["消息一", "消息二", "消息三", "消息四", "消息五", "消息六"],
  );
  faux.setResponses([
    fauxAssistantMessage("## 用户\nu\n\n## 偏好\np\n\n## 足迹\nf\n"),
    fauxAssistantMessage("## 用户\nu2\n\n## 偏好\np\n\n## 足迹\nf\n"),
  ]);
  const first = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
    maxRecords: 4,
  });
  assert.equal(first.status, "updated");
  assert.equal(first.throughMessageSeq, 4);
  assert.match(prompts[0], /消息一/);
  assert.match(prompts[0], /消息四/);
  assert.doesNotMatch(prompts[0], /消息五/);
  let memory = await sessions.getUserMemory(user.userId);
  assert.equal(memory?.throughMessageSeq, 4);

  const second = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
    maxRecords: 4,
    minNewUserMessages: 2,
  });
  assert.equal(second.status, "updated");
  assert.equal(second.throughMessageSeq, 6);
  assert.doesNotMatch(prompts[1], /消息四/);
  assert.match(prompts[1], /消息五/);
  assert.match(prompts[1], /消息六/);
  memory = await sessions.getUserMemory(user.userId);
  assert.equal(memory?.throughMessageSeq, 6);
});

test("模型输出垃圾（无小节/空）→ error、不写库不推游标", async (t) => {
  const { sessions, user, main, writer, agent, faux } = await makeDistill(t);
  await seedMessages(sessions, writer, user.userId, main.sessionId, [
    "我住在西安",
    "喜欢展览",
    "周末有空",
  ]);
  faux.setResponses([fauxAssistantMessage("随便一句没有小节的话")]);
  const garbage = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
  });
  assert.equal(garbage.status, "error");
  assert.equal(await sessions.getUserMemory(user.userId), undefined);

  // 空输出质量重试一次后仍空 → error
  const callsBefore = faux.state.callCount;
  faux.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("")]);
  const empty = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
  });
  assert.equal(empty.status, "error");
  assert.equal(faux.state.callCount, callsBefore + 2, "空输出应真的触发一次质量重试");
  assert.equal(await sessions.getUserMemory(user.userId), undefined);
});

test("row.sourceSessionId 与传入 sessionId 不同 → 游标重置从头蒸", async (t) => {
  const { sessions, user, main, writer, agent, faux } = await makeDistill(t);
  await seedMessages(
    sessions,
    writer,
    user.userId,
    main.sessionId,
    Array.from({ length: 8 }, (_, i) => `主会话消息${i + 1}`),
  );
  faux.setResponses([
    fauxAssistantMessage("## 用户\nu\n\n## 偏好\np\n\n## 足迹\nf\n"),
    fauxAssistantMessage("## 用户\nu\n\n## 偏好\np\n\n## 足迹\nf\n"),
  ]);
  const first = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
  });
  assert.equal(first.status, "updated");
  assert.equal(first.throughMessageSeq, 8);

  // 换 child 会话：游标不沿用主会话的 8，从 0 重蒸
  const child = await sessions.createChildSession(writer, user.userId, {
    parentSessionId: main.sessionId,
  });
  const childWriter = await mustAcquire(sessions, user.userId, child.sessionId, "worker-2");
  await seedMessages(sessions, childWriter, user.userId, child.sessionId, [
    "子会话消息一",
    "子会话消息二",
    "子会话消息三",
  ]);
  const second = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: child.sessionId,
  });
  assert.equal(second.status, "updated");
  assert.equal(second.throughMessageSeq, 3);
  const memory = await sessions.getUserMemory(user.userId);
  assert.equal(memory?.sourceSessionId, child.sessionId);
  assert.equal(memory?.throughMessageSeq, 3);
});

test("maxRecords ≤ 0 → 空批直接 skipped，无模型调用、不写库", async (t) => {
  const { sessions, user, main, writer, agent, faux } = await makeDistill(t);
  await seedMessages(sessions, writer, user.userId, main.sessionId, ["a", "b", "c"]);
  const outcome = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
    maxRecords: 0,
  });
  assert.equal(outcome.status, "skipped");
  assert.match(outcome.reason ?? "", /本批为空/);
  assert.equal(outcome.throughMessageSeq, undefined);
  assert.equal(faux.state.callCount, 0);
  assert.equal(await sessions.getUserMemory(user.userId), undefined);
});

test("error/skipped 不推游标：恢复后从同一游起重蒸", async (t) => {
  const { sessions, user, main, writer, agent, faux } = await makeDistill(t);
  await seedMessages(sessions, writer, user.userId, main.sessionId, ["a", "b"]);
  const skipped = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
  });
  assert.equal(skipped.status, "skipped");
  // 补一条跨门槛后从头蒸，through 覆盖全部 4 条
  await seedMessages(sessions, writer, user.userId, main.sessionId, ["c", "d"]);
  faux.setResponses([fauxAssistantMessage("## 用户\nu\n\n## 偏好\np\n\n## 足迹\nf\n")]);
  const outcome = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
  });
  assert.equal(outcome.status, "updated");
  assert.equal(outcome.throughMessageSeq, 4);
});

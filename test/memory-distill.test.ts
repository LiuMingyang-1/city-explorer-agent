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
  validPlan,
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
    minNewUserMessages: 3,
  });
  assert.equal(outcome.status, "skipped");
  assert.match(outcome.reason ?? "", /未达保底门槛/);
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
    minNewUserMessages: 3,
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
    minNewUserMessages: 3,
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
    minNewUserMessages: 3,
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
    minNewUserMessages: 3,
    maxRecords: 4,
    maxBatches: 1,
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
    minNewUserMessages: 3,
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
    minNewUserMessages: 3,
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
    minNewUserMessages: 3,
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
    minNewUserMessages: 3,
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
    minNewUserMessages: 3,
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
    minNewUserMessages: 3,
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
    minNewUserMessages: 3,
  });
  assert.equal(outcome.status, "updated");
  assert.equal(outcome.throughMessageSeq, 4);
});

test("超长蒸馏输出 → error，原文与游标保持不变", async (t) => {
  const { sessions, user, main, writer, agent, faux } = await makeDistill(t);
  const original = "## 用户\n常驻西安\n\n## 偏好\n对花生过敏\n\n## 足迹\n2026-11-10 看展\n";
  await sessions.putUserMemory(user.userId, {
    content: original,
    sourceSessionId: main.sessionId,
    throughMessageSeq: 0,
  });
  await seedMessages(sessions, writer, user.userId, main.sessionId, [
    "我住在西安",
    "喜欢展览",
    "周末有空",
  ]);
  // 回归：重要约束（对花生过敏）位于最长小节尾部——持久层不得剪裁正文。
  faux.setResponses([
    fauxAssistantMessage(
      `## 用户\n常驻西安\n\n## 偏好\n${"甲".repeat(3990)}\n对花生过敏\n\n## 足迹\n2026-11-10 看展\n`,
    ),
  ]);
  const outcome = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
    minNewUserMessages: 3,
  });
  assert.equal(outcome.status, "error");
  assert.equal(outcome.throughMessageSeq, undefined);
  const memory = await sessions.getUserMemory(user.userId);
  assert.equal(memory?.content, original);
  assert.equal(memory?.throughMessageSeq, 0);
});

test("无固定小节的垃圾输出 → error，原文与游标不被覆盖", async (t) => {
  const { sessions, user, main, writer, agent, faux } = await makeDistill(t);
  const original = "## 用户\n常驻西安\n\n## 偏好\n对花生过敏\n\n## 足迹\n2026-11-10 看展\n";
  await sessions.putUserMemory(user.userId, {
    content: original,
    sourceSessionId: main.sessionId,
    throughMessageSeq: 0,
  });
  await seedMessages(sessions, writer, user.userId, main.sessionId, [
    "我住在西安",
    "喜欢展览",
    "周末有空",
  ]);
  faux.setResponses([fauxAssistantMessage("## 错误\n服务暂时不可用")]);
  const outcome = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
    minNewUserMessages: 3,
  });
  assert.equal(outcome.status, "error");
  const memory = await sessions.getUserMemory(user.userId);
  assert.equal(memory?.content, original);
  assert.equal(memory?.throughMessageSeq, 0);
});

test("缺失固定小节的输出从既有文档继承，不抹除旧节", async (t) => {
  const { sessions, user, main, writer, agent, faux } = await makeDistill(t);
  const original = "## 用户\n常驻西安\n\n## 偏好\n对花生过敏\n\n## 足迹\n2026-11-10 看展\n";
  await sessions.putUserMemory(user.userId, {
    content: original,
    sourceSessionId: main.sessionId,
    throughMessageSeq: 0,
  });
  await seedMessages(sessions, writer, user.userId, main.sessionId, [
    "搬到东京了",
    "还是喜欢展览",
    "周末有空",
  ]);
  faux.setResponses([fauxAssistantMessage("## 用户\n常驻东京\n\n## 偏好\n对花生过敏\n")]);
  const outcome = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
    minNewUserMessages: 3,
  });
  assert.equal(outcome.status, "updated");
  const memory = await sessions.getUserMemory(user.userId);
  assert.ok(memory);
  assert.match(memory.content, /## 用户\n常驻东京/);
  assert.match(memory.content, /## 偏好\n对花生过敏/);
  // 模型省略的足迹小节从既有文档继承，不被补空抹除。
  assert.match(memory.content, /## 足迹\n2026-11-10 看展/);
});

test("单条超长消息：分片送完才推进游标，可恢复前进不阻断", async (t) => {
  const { sessions, user, main, writer, agent, faux } = await makeDistill(t);
  await seedMessages(sessions, writer, user.userId, main.sessionId, [
    "长".repeat(20_000),
    "b",
    "c",
  ]);
  const doc = "## 用户\n常驻西安\n\n## 偏好\n对花生过敏\n\n## 足迹\n2026-11-10 看展\n";
  faux.setResponses([
    fauxAssistantMessage(doc),
    fauxAssistantMessage(doc),
    fauxAssistantMessage(doc),
    fauxAssistantMessage(doc),
    fauxAssistantMessage(doc),
  ]);
  const outcome = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
    minNewUserMessages: 3,
    maxInputChars: 8_000,
  });
  assert.equal(outcome.status, "updated");
  // 游标越过全部 3 条：超长记录分片全部进模型，b/c 正常进入后续批。
  assert.equal(outcome.throughMessageSeq, 3);
  assert.ok(faux.state.callCount >= 2, "超长记录应分片成多次模型调用");
  const memory = await sessions.getUserMemory(user.userId);
  assert.ok(memory);
  assert.equal(memory.throughMessageSeq, 3);
});

test("累计超限：序列化总长严格 ≤ 上限，分多批逐批推进游标", async (t) => {
  const { sessions, user, main, writer, agent, faux } = await makeDistill(t);
  await seedMessages(sessions, writer, user.userId, main.sessionId, [
    "a".repeat(7_000),
    "b".repeat(7_000),
    "c",
  ]);
  const doc = "## 用户\nu\n\n## 偏好\np\n\n## 足迹\nf\n";
  faux.setResponses([fauxAssistantMessage(doc), fauxAssistantMessage(doc)]);
  const outcome = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
    minNewUserMessages: 3,
    maxInputChars: 8_000,
  });
  assert.equal(outcome.status, "updated");
  assert.equal(outcome.throughMessageSeq, 3);
  assert.equal(faux.state.callCount, 2, "7000+7000+3 → 两批");
});

test("分片数超硬上限的超长消息：明示跳过（打运维日志）且不阻断", async (t) => {
  const { sessions, user, main, writer, agent, faux } = await makeDistill(t);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (msg: unknown) => warnings.push(String(msg)));
  await seedMessages(sessions, writer, user.userId, main.sessionId, [
    "x".repeat(140_000),
    "b",
    "c",
  ]);
  faux.setResponses([
    fauxAssistantMessage("## 用户\nu\n\n## 偏好\np\n\n## 足迹\nf\n"),
  ]);
  const outcome = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
    minNewUserMessages: 3,
    maxInputChars: 8_000,
  });
  assert.equal(outcome.status, "updated");
  assert.equal(outcome.throughMessageSeq, 3);
  assert.equal(faux.state.callCount, 1, "超长记录明示跳过，b/c 正常蒸馏");
  const memory = await sessions.getUserMemory(user.userId);
  assert.ok(memory);
  assert.doesNotMatch(memory.content, /蒸馏记录/, "跳过事件不再写进记忆文档");
  assert.ok(
    warnings.some((w) => w.includes("seq=1")),
    "跳过事件应打 console.warn 运维日志",
  );
});

test("出新方案即触发蒸馏：1 条 user 消息 + plan 标注记录，不受保底门槛限制", async (t) => {
  const { sessions, user, main, writer, agent, faux } = await makeDistill(t);
  await seedMessages(sessions, writer, user.userId, main.sessionId, ["我想看展"]);
  const planRecord = await sessions.appendMessage(writer, user.userId, main.sessionId, {
    payload: { message: assistantMessage('{"type":"itinerary"}') },
  });
  await sessions.commitValidatedPlan(
    writer,
    user.userId,
    main.sessionId,
    planRecord.recordId,
    validPlan(),
  );
  faux.setResponses([
    fauxAssistantMessage("## 用户\nu\n\n## 偏好\np\n\n## 足迹\nf\n"),
  ]);
  const outcome = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
  });
  assert.equal(outcome.status, "updated");
  assert.equal(outcome.throughMessageSeq, 2);
  assert.equal(faux.state.callCount, 1, "游标后有 plan 标注即触发，不管消息数");
});

test("存量文档残留的蒸馏记录节：模型照抄也被 normalize 丢弃，不再延续", async (t) => {
  const { sessions, user, main, writer, agent, faux } = await makeDistill(t);
  await sessions.putUserMemory(user.userId, {
    content:
      "## 用户\n常驻西安\n\n## 偏好\n喜欢展览\n\n## 足迹\nf\n\n## 蒸馏记录\n- 蒸馏跳过 seq=9\n",
    sourceSessionId: main.sessionId,
    throughMessageSeq: 0,
  });
  await seedMessages(sessions, writer, user.userId, main.sessionId, ["a", "b", "c"]);
  // 残留节随文档原文进 <memory> 输入，模型可能照抄——normalize 丢弃同名节。
  faux.setResponses([
    fauxAssistantMessage(
      "## 用户\n常驻西安\n\n## 偏好\n喜欢展览\n\n## 足迹\nf\n\n## 蒸馏记录\n- 蒸馏跳过 seq=9\n",
    ),
  ]);
  const outcome = await distillMemory({
    agent,
    sessions,
    userId: user.userId,
    sessionId: main.sessionId,
    minNewUserMessages: 3,
  });
  assert.equal(outcome.status, "updated");
  const memory = await sessions.getUserMemory(user.userId);
  assert.ok(memory);
  assert.doesNotMatch(memory.content, /蒸馏记录/, "审计节机制已移除，残留节不得延续");
  assert.match(memory.content, /## 足迹\nf\n$/);
});

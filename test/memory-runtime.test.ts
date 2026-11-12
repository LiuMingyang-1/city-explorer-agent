import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { PlannerSession } from "../src/agent/session.ts";
import type { SessionRepository } from "../src/session/repository.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";
import { isDistillRequest, makePersistent } from "./e2e-fixture.ts";
import { messageRecords } from "./persistent-fixture.ts";
import { makeUser, mustAcquire, openMemoryRepo } from "./session-fixture.ts";

/**
 * 长期记忆接入持久运行时：reload 把 user_memory.content 渲染进 system 的
 * memory_context 节（main/child 同规则、不落库）；main 会话 close 时机会
 * 蒸馏（≥3 条新 user 消息门槛），失败吞掉不破坏收尾。
 * 蒸馏请求与会话回复走同一个 streamFn，按 <memory> 标记分流到独立队列。
 */

const clarify = () => fauxAssistantMessage('{"type":"clarify","question":"好的"}');

const distilledDoc = () =>
  "## 用户\n常驻西安\n\n## 偏好\n喜欢展览、下午出门\n\n## 足迹\n2026-11-15 下午看展\n";

/** 当前生效 system 消息中的 memory_context 节文本；无该节 → null/undefined。 */
function memorySection(session: PlannerSession): string | null | undefined {
  const system = session.agent.state.messages.find((m) => m.role === "system") as
    | SystemMessage
    | undefined;
  return system?.sections?.["memory_context"];
}

/** 蒸馏走独立 faux 队列（与摘要分流同法）；主队列只供会话内回复。 */
function routeDistill(
  main: ReturnType<typeof createFauxCore>,
  distill: ReturnType<typeof createFauxCore>,
): StreamFn {
  return (model, context, options) =>
    (isDistillRequest(context) ? distill : main).streamSimple(model, context, options);
}

/** close 后写租约应已释放：其他写者能拿到租约。 */
async function assertLeaseFree(
  sessions: SessionRepository,
  userId: string,
  sessionId: string,
): Promise<void> {
  const probe = await sessions.acquireLease(userId, sessionId, "probe", 60_000);
  assert.ok(probe, "close 后写租约应已释放");
  await sessions.releaseLease(probe, userId, sessionId);
}

test("user_memory 有行：system 注入 memory_context（标题+原文）；无行：无该节", async (t) => {
  const sessions = openMemoryRepo(t);
  await makeUser(sessions);
  const doc = "## 用户\n常驻西安，周末出行\n\n## 偏好\n喜欢展览、步行\n\n## 足迹\n";
  await sessions.putUserMemory("u-test", {
    content: doc,
    sourceSessionId: null,
    throughMessageSeq: 0,
  });
  const { session } = await makePersistent(t, [clarify()], { sessions });
  const section = memorySection(session);
  assert.ok(section, "system 消息应有 memory_context 节");
  assert.match(section, /## 用户长期记忆（跨会话持久数据，背景参考）/);
  assert.ok(section.includes(doc), "节内应含文档原文");

  // 轮次内 reload 重读：注入持续生效；文档只进 system 节，不落消息表。
  await session.prompt("随便逛逛");
  assert.ok(memorySection(session)?.includes(doc));
  const stored = JSON.stringify(await messageRecords(sessions, session.sessionId as string));
  assert.ok(!stored.includes("常驻西安"), "记忆文档不落消息表");

  // 同库另一用户无 memory 行 → 无该节，不串记忆。
  const other = await makePersistent(t, [], { sessions, userId: "u-other" });
  assert.ok(memorySection(other.session) == null);
});

test("≥3 条新 user 消息：close 触发蒸馏，文档落库、游标推进、重开注入", async (t) => {
  const sessions = openMemoryRepo(t);
  const main = createFauxCore({});
  main.setResponses([clarify(), clarify(), clarify()]);
  const distill = createFauxCore({});
  distill.setResponses([fauxAssistantMessage(distilledDoc())]);
  const { session } = await makePersistent(t, [], {
    sessions,
    streamFn: routeDistill(main, distill),
  });
  await session.prompt("我住在西安，周末喜欢看展");
  await session.prompt("偏好下午出门，不喜欢早起");
  await session.prompt("好的就按这个来");
  assert.equal(distill.state.callCount, 0, "close 前不应触发蒸馏");

  await session.close();
  assert.equal(distill.state.callCount, 1, "close 应触发一次蒸馏");
  const memory = await sessions.getUserMemory("u-test");
  assert.ok(memory);
  assert.match(memory.content, /## 用户\n常驻西安/);
  assert.match(memory.content, /喜欢展览、下午出门/);
  assert.equal(memory.sourceSessionId, session.sessionId);
  const lastSeq = (
    await sessions.listMessagesFrom("u-test", session.sessionId as string, 1)
  ).at(-1)?.messageSeq;
  assert.ok(lastSeq && lastSeq > 0);
  assert.equal(memory.throughMessageSeq, lastSeq);

  // 重开：蒸馏产出的文档随 reload 注入 system section。
  const reopened = await makePersistent(t, [], { sessions });
  assert.match(memorySection(reopened.session) ?? "", /常驻西安/);
});

test("新 user 消息不足 3 条：close 不蒸馏、不留 memory 行", async (t) => {
  const sessions = openMemoryRepo(t);
  const main = createFauxCore({});
  main.setResponses([clarify(), clarify()]);
  const distill = createFauxCore({});
  distill.setResponses([fauxAssistantMessage(distilledDoc())]);
  const { session } = await makePersistent(t, [], {
    sessions,
    streamFn: routeDistill(main, distill),
  });
  await session.prompt("你好");
  await session.prompt("再看看");
  await session.close();
  assert.equal(distill.state.callCount, 0, "未达门槛不应调用蒸馏模型");
  assert.equal(await sessions.getUserMemory("u-test"), undefined);
});

test("蒸馏模型请求失败：close 照常 resolve、租约释放、不留 memory 行", async (t) => {
  const sessions = openMemoryRepo(t);
  const main = createFauxCore({});
  main.setResponses([clarify(), clarify(), clarify()]);
  const streamFn: StreamFn = (model, context, options) => {
    if (isDistillRequest(context)) throw new Error("蒸馏模型不可用");
    return main.streamSimple(model, context, options);
  };
  const { session } = await makePersistent(t, [], { sessions, streamFn });
  for (const text of ["甲", "乙", "丙"]) await session.prompt(text);
  await assert.doesNotReject(session.close());
  assert.equal(await sessions.getUserMemory("u-test"), undefined);
  await assertLeaseFree(sessions, "u-test", session.sessionId as string);
});

test("蒸馏写库抛错被吞掉：close 照常 resolve、租约释放", async (t) => {
  const inner = createSqliteSessionRepository(":memory:");
  t.after(() => inner.close());
  // 蒸馏本体 reject 的情形：putUserMemory 故障不经 distill 内部兜底，
  // 直接考验运行时的 try/catch；getUserMemory 读取不受影响。
  const sessions: SessionRepository = {
    ...inner,
    putUserMemory: () => Promise.reject(new Error("user_memory 写入故障")),
  };
  const main = createFauxCore({});
  main.setResponses([clarify(), clarify(), clarify()]);
  const distill = createFauxCore({});
  distill.setResponses([fauxAssistantMessage(distilledDoc())]);
  const { session } = await makePersistent(t, [], {
    sessions,
    streamFn: routeDistill(main, distill),
  });
  for (const text of ["甲", "乙", "丙"]) await session.prompt(text);
  await assert.doesNotReject(session.close());
  assert.equal(distill.state.callCount, 1, "蒸馏确已走到模型调用");
  await assertLeaseFree(sessions, "u-test", session.sessionId as string);
});

test("child 会话：memory_context 注入同规则生效，close 不触发蒸馏", async (t) => {
  const sessions = openMemoryRepo(t);
  const { main: mainSession } = await makeUser(sessions, "u-child");
  const writer = await mustAcquire(sessions, "u-child", mainSession.sessionId);
  const child = await sessions.createChildSession(writer, "u-child", {
    parentSessionId: mainSession.sessionId,
  });
  await sessions.releaseLease(writer, "u-child", mainSession.sessionId);
  const doc = "## 用户\n常驻西安\n\n## 偏好\n喜欢展览\n\n## 足迹\n";
  await sessions.putUserMemory("u-child", {
    content: doc,
    sourceSessionId: null,
    throughMessageSeq: 0,
  });
  const main = createFauxCore({});
  main.setResponses([clarify(), clarify(), clarify()]);
  const distill = createFauxCore({});
  distill.setResponses([fauxAssistantMessage(distilledDoc())]);
  const { session } = await makePersistent(t, [], {
    sessions,
    userId: "u-child",
    sessionId: child.sessionId,
    streamFn: routeDistill(main, distill),
  });
  // 长期记忆注入与会话类型无关：child 的 system 同样带 memory_context。
  assert.match(memorySection(session) ?? "", /常驻西安/);
  for (const text of ["甲", "乙", "丙"]) await session.prompt(text);
  await session.close();
  assert.equal(distill.state.callCount, 0, "child close 不得触发蒸馏");
  const memory = await sessions.getUserMemory("u-child");
  assert.equal(memory?.content, doc, "蒸馏未运行，既有记忆行原样保留");
  assert.equal(memory?.throughMessageSeq, 0);
});

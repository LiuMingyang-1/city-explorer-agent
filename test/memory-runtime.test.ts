import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { runtimeSystemMessage } from "../src/agent/persistent/context.ts";
import type { PlannerSession } from "../src/agent/session.ts";
import type { SessionRepository } from "../src/session/repository.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";
import { isDistillRequest, makePersistent } from "./e2e-fixture.ts";
import { messageRecords } from "./persistent-fixture.ts";
import { makeUser, mustAcquire, openMemoryRepo } from "./session-fixture.ts";

/**
 * 长期记忆接入持久运行时：reload 把 user_memory.content 渲染进 system 的
 * memory_context 节（main/child 同规则、不落库）；main 会话 close 时机会
 * 蒸馏（游标后有新方案即触发，否则 ≥3 条新 user 消息保底），失败吞掉
 * 不破坏收尾。
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

test("memory_context 注入按行截到 ≤4000 字符：超大文档不整块吃上下文", () => {
  const long = ["## 用户", ...Array.from({ length: 200 }, (_, i) => `第${i}行${"长".repeat(30)}`)].join(
    "\n",
  );
  const message = runtimeSystemMessage(
    undefined,
    undefined,
    "confirmed",
    undefined,
    long,
  ) as SystemMessage;
  const section = message.sections?.["memory_context"] ?? "";
  const header = "## 用户长期记忆（跨会话持久数据，背景参考）\n";
  assert.ok(section.startsWith(header));
  const doc = section.slice(header.length);
  assert.ok(doc.length <= 4_000, "注入的记忆文档不超过 4000 字符");
  assert.ok(doc.length < long.length, "确已发生截断");
  // 截断只落在行边界：结果是原文完整行前缀，下一字符必是换行。
  assert.ok(long.startsWith(doc) && long[doc.length] === "\n");
});

test("攒够保底消息（≥3 条）：close 触发蒸馏，文档落库、游标推进、新对话注入", async (t) => {
  const sessions = openMemoryRepo(t);
  const main = createFauxCore({});
  main.setResponses(Array.from({ length: 3 }, clarify));
  const distill = createFauxCore({});
  distill.setResponses([fauxAssistantMessage(distilledDoc())]);
  const { session } = await makePersistent(t, [], {
    sessions,
    streamFn: routeDistill(main, distill),
  });
  for (const text of ["我住在西安，周末喜欢看展", "偏好下午出门，不喜欢早起", "好的就按这个来"])
    await session.prompt(text);
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

  // 新对话（不传 sessionId）：记忆是用户级，蒸馏产出的文档随 reload 注入。
  const reopened = await makePersistent(t, [], { sessions });
  assert.notEqual(reopened.session.sessionId, session.sessionId);
  assert.match(memorySection(reopened.session) ?? "", /常驻西安/);
});

/** 轮询等待条件成立（后台蒸馏等异步收尾的断言用）。 */
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    assert.ok(Date.now() < deadline, "等待后台操作超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("detachDistill：close 立即 resolve，蒸馏后台完成落库", async (t) => {
  const sessions = openMemoryRepo(t);
  const main = createFauxCore({});
  main.setResponses(Array.from({ length: 3 }, clarify));
  const distill = createFauxCore({});
  distill.setResponses([fauxAssistantMessage(distilledDoc())]);
  const { session } = await makePersistent(t, [], {
    sessions,
    streamFn: routeDistill(main, distill),
    detachDistill: true,
  });
  for (const text of ["1", "2", "3"]) await session.prompt(text);
  await session.close();
  await assertLeaseFree(sessions, "u-test", session.sessionId as string);
  // close 不等待蒸馏：后台蒸馏稍后完成并写库。
  await waitFor(() => distill.state.callCount === 1);
  await waitFor(async () => (await sessions.getUserMemory("u-test")) !== undefined);
  const memory = await sessions.getUserMemory("u-test");
  assert.match(memory?.content ?? "", /常驻西安/);
});

test("detachDistill：在途蒸馏期间的 close 进每用户串行尾随队列，末轮不丢", async (t) => {
  const sessions = openMemoryRepo(t);
  const main = createFauxCore({});
  main.setResponses(Array.from({ length: 9 }, clarify));
  const distill = createFauxCore({});
  distill.setResponses([
    fauxAssistantMessage(distilledDoc()),
    fauxAssistantMessage(distilledDoc()),
    fauxAssistantMessage(distilledDoc()),
  ]);
  // 首轮蒸馏由闸门扣住在途；StreamFn 允许返回 Promise，await 即阻塞。
  let distillCalls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const streamFn: StreamFn = async (model, context, options) => {
    if (isDistillRequest(context)) {
      distillCalls += 1;
      await gate;
      return distill.streamSimple(model, context, options);
    }
    return main.streamSimple(model, context, options);
  };
  const opts = { sessions, streamFn, detachDistill: true };

  // 对话 A：3 条 user 消息触发保底；close 不阻塞，蒸馏在闸门内在途。
  const a = await makePersistent(t, [], opts);
  const sidA = a.session.sessionId as string;
  for (const text of ["a1", "a2", "a3"]) await a.session.prompt(text);
  await a.session.close();
  await waitFor(() => distillCalls === 1);

  // 在途期间：重开 A 再攒 3 条（同 sessionId）+ 新对话 B 也攒 3 条，
  // 两次 close 都不得被丢弃——进队尾随等前序完成顺次执行。
  const a2 = await makePersistent(t, [], { ...opts, sessionId: sidA });
  for (const text of ["a4", "a5", "a6"]) await a2.session.prompt(text);
  const b = await makePersistent(t, [], opts);
  const sidB = b.session.sessionId as string;
  for (const text of ["b1", "b2", "b3"]) await b.session.prompt(text);
  await Promise.all([a2.session.close(), b.session.close()]);
  release();

  // 三个触发各自蒸到模型：A 在途 + A' 与 B 尾随（同 sessionId 合并、
  // 不同 sessionId 并存）。末轮（B）写库后游标覆盖到 B 的最新消息。
  await waitFor(() => distillCalls === 3);
  await waitFor(
    async () => (await sessions.getUserMemory("u-test"))?.sourceSessionId === sidB,
  );
  const memory = await sessions.getUserMemory("u-test");
  const lastB = (await sessions.listMessagesFrom("u-test", sidB, 1)).at(-1)?.messageSeq;
  assert.equal(memory?.throughMessageSeq, lastB);
});

test("detachDistill：交错 close 按最新顺序排水（X 在途，A→B→A' 执行成 X→B→A'）", async (t) => {
  const sessions = openMemoryRepo(t);
  const main = createFauxCore({});
  main.setResponses(Array.from({ length: 12 }, clarify));
  const distill = createFauxCore({});
  distill.setResponses([
    fauxAssistantMessage(distilledDoc()),
    fauxAssistantMessage(distilledDoc()),
    fauxAssistantMessage(distilledDoc()),
  ]);
  // X 的蒸馏由闸门扣住在途；每个蒸馏请求按输入消息文本标记所属会话，
  // 以此断言实际排水顺序。同 sessionId 合并必须移到队尾。
  const order: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const streamFn: StreamFn = async (model, context, options) => {
    if (isDistillRequest(context)) {
      const text = JSON.stringify(context.messages);
      order.push(
        text.includes("x-1") ? "X" : text.includes("b-1") ? "B" : text.includes("a-4") ? "A" : "?",
      );
      await gate;
      return distill.streamSimple(model, context, options);
    }
    return main.streamSimple(model, context, options);
  };
  const opts = { sessions, streamFn, detachDistill: true };

  const x = await makePersistent(t, [], opts);
  for (const text of ["x-1", "x-2", "x-3"]) await x.session.prompt(text);
  await x.session.close();
  await waitFor(() => order.length === 1);

  // 在途期间依次 close：A（第 1 轮）→ B → 重开 A 追加末轮再 close。
  const a = await makePersistent(t, [], opts);
  const sidA = a.session.sessionId as string;
  for (const text of ["a-1", "a-2", "a-3"]) await a.session.prompt(text);
  await a.session.close();
  const b = await makePersistent(t, [], opts);
  for (const text of ["b-1", "b-2", "b-3"]) await b.session.prompt(text);
  await b.session.close();
  const a2 = await makePersistent(t, [], { ...opts, sessionId: sidA });
  for (const text of ["a-4", "a-5", "a-6"]) await a2.session.prompt(text);
  await a2.session.close();
  release();

  // 严格顺序 X → B → A（最新轮）：A 的合并任务必须移到队尾，
  // 最终记忆与游标落到最后一次 close 的 A 末轮，而非较早的 B。
  await waitFor(() => order.length === 3);
  assert.deepEqual(order, ["X", "B", "A"]);
  await waitFor(
    async () => (await sessions.getUserMemory("u-test"))?.sourceSessionId === sidA,
  );
  const memory = await sessions.getUserMemory("u-test");
  const lastA = (await sessions.listMessagesFrom("u-test", sidA, 1)).at(-1)?.messageSeq;
  assert.equal(memory?.throughMessageSeq, lastA);
});

test("无新方案且新 user 消息不足保底（<3 条）：close 不蒸馏、不留 memory 行", async (t) => {
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
  main.setResponses(Array.from({ length: 3 }, clarify));
  const streamFn: StreamFn = (model, context, options) => {
    if (isDistillRequest(context)) throw new Error("蒸馏模型不可用");
    return main.streamSimple(model, context, options);
  };
  const { session } = await makePersistent(t, [], { sessions, streamFn });
  for (let i = 0; i < 3; i++) await session.prompt(`消息${i}`);
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
  main.setResponses(Array.from({ length: 3 }, clarify));
  const distill = createFauxCore({});
  distill.setResponses([fauxAssistantMessage(distilledDoc())]);
  const { session } = await makePersistent(t, [], {
    sessions,
    streamFn: routeDistill(main, distill),
  });
  for (let i = 0; i < 3; i++) await session.prompt(`消息${i}`);
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
  main.setResponses(Array.from({ length: 10 }, clarify));
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
  for (let i = 0; i < 10; i++) await session.prompt(`消息${i}`);
  await session.close();
  assert.equal(distill.state.callCount, 0, "child close 不得触发蒸馏");
  const memory = await sessions.getUserMemory("u-child");
  assert.equal(memory?.content, doc, "蒸馏未运行，既有记忆行原样保留");
  assert.equal(memory?.throughMessageSeq, 0);
});

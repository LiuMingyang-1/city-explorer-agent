import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { PlannerSession } from "../src/agent/session.ts";
import type { SessionRepository } from "../src/session/repository.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";
import { createChatService } from "../src/web/service.ts";
import type { ManagedChatService } from "../src/web/service.ts";
import { BASE, CONFIG, isDistillRequest, makePersistent, makeRepo, makeStreamFn } from "./e2e-fixture.ts";
import { messageRecords } from "./persistent-fixture.ts";
import { fakeClock, userMessage } from "./session-fixture.ts";

/**
 * 用户位置注入：location 经 prompt options 透传，持久运行时在租约内重建
 * system 的 location_context 节（坐标 + 就近场馆锚点），随轮次更新、
 * 不落 raw/消息表；锚点解析失败降级为无锚点，不影响本轮。
 */

const clarify = () => fauxAssistantMessage('{"type":"clarify","question":"好的"}');

/** 当前生效 system 消息中的 location_context 节文本；无该节 → undefined。 */
function locationSection(session: PlannerSession): string | null | undefined {
  const system = session.agent.state.messages.find((m) => m.role === "system") as
    | SystemMessage
    | undefined;
  return system?.sections?.["location_context"];
}

test("prompt 带 location：system 注入 location_context（坐标+锚点），且不落库", async (t) => {
  const { session, sessions } = await makePersistent(t, [clarify()], {
    locationAnchor: async () => "距「测试场馆」约 1.23 公里",
  });
  const turn = await session.prompt("附近逛逛", { location: { lat: 31.19, lng: 121.47 } });
  assert.equal(turn.kind, "clarification");
  const section = locationSection(session);
  assert.ok(section, "system 消息应有 location_context 节");
  assert.match(section, /用户当前位置/);
  assert.match(section, /31\.19000/);
  assert.match(section, /121\.47000/);
  assert.match(section, /距「测试场馆」约 1\.23 公里/);

  // 位置只进内存 system 节：消息表里没有坐标串与锚点文本。
  const stored = JSON.stringify(await messageRecords(sessions, session.sessionId as string));
  assert.ok(!stored.includes("31.19000") && !stored.includes("121.47000"));
  assert.ok(!stored.includes("用户当前位置") && !stored.includes("测试场馆"));
});

test("location 随轮次更新并重算锚点；本轮不带则沿用上轮", async (t) => {
  const { session } = await makePersistent(t, [clarify(), clarify(), clarify()], {
    locationAnchor: async (lat, lng) => `锚点(${lat},${lng})`,
  });
  await session.prompt("第一轮", { location: { lat: 31.19, lng: 121.47 } });
  const first = locationSection(session) ?? "";
  assert.match(first, /31\.19000/);
  assert.match(first, /锚点\(31\.19,121\.47\)/);

  await session.prompt("第二轮带新位置", { location: { lat: 31.25, lng: 121.44 } });
  const updated = locationSection(session) ?? "";
  assert.match(updated, /31\.25000/);
  assert.match(updated, /锚点\(31\.25,121\.44\)/);
  assert.doesNotMatch(updated, /31\.19/);

  // 第三轮不带 location：沿用上轮坐标与锚点。
  await session.prompt("第三轮不带位置");
  const kept = locationSection(session) ?? "";
  assert.match(kept, /31\.25000/);
  assert.match(kept, /锚点\(31\.25,121\.44\)/);
});

test("缺省锚点用活动库最近场馆：30km 内给锚点文案，远端坐标无锚点", async (t) => {
  const { session } = await makePersistent(t, [clarify(), clarify()]);
  // 种子场馆 西岸美术馆（模拟）坐标原地 → 最近距离恰为 0 公里。
  await session.prompt("在美术馆边上", { location: { lat: 31.1895, lng: 121.4702 } });
  assert.match(locationSection(session) ?? "", /距「西岸美术馆（模拟）」约 0 公里/);

  // 南半球坐标距全部种子场馆数千公里 → 只有坐标，无锚点行。
  await session.prompt("第二轮", { location: { lat: -33.87, lng: 151.21 } });
  const far = locationSection(session) ?? "";
  assert.match(far, /-33\.87000；经度：151\.21000/);
  assert.doesNotMatch(far, /距「/);
});

/**
 * 真实 createChatService + 默认 createPersistentPlanner + faux 的最小接线：
 * service.send 每次都新建持久化 planner 并 close，模型请求统一经 streamFn，
 * seen 记下每个请求实际看到的 system.sections.location_context（无该节 → null）。
 */
async function openLocationService(
  t: TestContext,
  sessions: SessionRepository,
  responses: FauxResponseStep[],
): Promise<{ service: ManagedChatService; seen: (string | null | undefined)[] }> {
  const repository = await makeRepo(t);
  const faux = createFauxCore({});
  faux.setResponses(responses);
  const { streamFn: scripted } = makeStreamFn(faux);
  const seen: (string | null | undefined)[] = [];
  const streamFn: StreamFn = (model, context, options) => {
    // 会话收尾的蒸馏旁路请求同样经过 streamFn：system 是蒸馏提示词、
    // 不带 location_context，且不算一轮会话请求，不计入 seen。
    if (!isDistillRequest(context)) {
      const system = context.messages.find((m) => m.role === "system") as
        | SystemMessage
        | undefined;
      seen.push(system?.sections?.["location_context"] ?? null);
    }
    return scripted(model, context, options);
  };
  const service = createChatService({
    config: CONFIG,
    repository,
    sessions,
    streamFn,
    currentDate: BASE,
  });
  t.after(async () => {
    await service.shutdown();
  });
  return { service, seen };
}

const hasLat = (section: string | null | undefined, lat: number) =>
  (section ?? "").includes(`纬度：${lat.toFixed(5)}`);

/**
 * 跨请求沿用：坐标随 run.input 快照落库，新实例 reload 时按"已落地消息
 * 序号最大的 location run"恢复最近位置（与 created_at/时钟无关），锚点重解。
 */
test("service 跨请求沿用最近位置：新实例从 run.input 恢复，更新与用户隔离正确", async (t) => {
  const clock = fakeClock();
  const sessions = createSqliteSessionRepository(":memory:", { now: clock.now });
  t.after(() => sessions.close());
  const { service, seen } = await openLocationService(t, sessions, [
    clarify(),
    clarify(),
    clarify(),
    clarify(),
    clarify(),
  ]);

  // 首轮带位置：坐标注入本轮 system section。
  await service.send("u-a", "附近逛逛", { location: { lat: 34.27, lng: 108.95 } });
  assert.ok(hasLat(seen[0], 34.27));

  // 次轮不带位置：planner 是全新实例，须从会话库恢复同一坐标。
  clock.advance(1_000);
  await service.send("u-a", "明天下午，还是附近");
  assert.ok(hasLat(seen[1], 34.27));

  // 新位置覆盖旧值，之后的轮次沿用新坐标。
  clock.advance(1_000);
  await service.send("u-a", "换地方了", { location: { lat: 31.2, lng: 121.5 } });
  assert.ok(hasLat(seen[2], 31.2));
  clock.advance(1_000);
  await service.send("u-a", "那附近呢");
  assert.ok(hasLat(seen[3], 31.2));

  // 另一用户的会话没有 location run：无该节，不串 u-a 的位置。
  await service.send("u-b", "附近");
  assert.equal(seen[4], null);

  // 坐标只进 system section 与 run.input 快照：history 还原的消息不含坐标。
  const history = await service.history("u-a");
  assert.ok(!JSON.stringify(history).includes("34.27"));
});

test("同时间戳下最近位置按落库消息序号判定：冻结时钟多次更新仍取最新", async (t) => {
  // 固定时钟让所有 run 的 created_at 完全相同（ORDER BY 退到 run_id
  // 随机次序）：新旧只能由 message_seq 判定，多次更新后仍是最后上报者。
  const sessions = createSqliteSessionRepository(":memory:", {
    now: () => new Date("2026-11-12T00:00:00.000Z"),
  });
  t.after(() => sessions.close());
  const { service, seen } = await openLocationService(t, sessions, [
    clarify(),
    clarify(),
    clarify(),
    clarify(),
    clarify(),
    clarify(),
  ]);
  for (let i = 1; i <= 3; i++) {
    await service.send("u", `第${i}处`, { location: { lat: i, lng: 0 } });
    assert.ok(hasLat(seen.at(-1), i), `第${i}处应注入 lat=${i}`);
    await service.send("u", "还是附近");
    assert.ok(hasLat(seen.at(-1), i), `沿用应恢复 lat=${i}`);
  }
});

test("时钟回拨不改新旧判定：created_at 更早的 run 仍按消息序号算最新", async (t) => {
  const clock = fakeClock("2026-11-12T00:00:00.000Z");
  const sessions = createSqliteSessionRepository(":memory:", { now: clock.now });
  t.after(() => sessions.close());
  const { service, seen } = await openLocationService(t, sessions, [
    clarify(),
    clarify(),
    clarify(),
    clarify(),
  ]);
  await service.send("u", "第一处", { location: { lat: 1, lng: 0 } });
  await service.send("u", "还是附近");

  // 时钟回拨一天：第二处 run 的 created_at 比第一处更早，按时间排序会错。
  clock.set("2026-11-11T00:00:00.000Z");
  await service.send("u", "第二处", { location: { lat: 2, lng: 0 } });
  await service.send("u", "还是附近");
  assert.ok(hasLat(seen[3], 2), "应按落库序号恢复 lat=2 而非 lat=1");
});

test("上报未落地的 run（没有任何落库消息）不参与最近位置恢复", async (t) => {
  const clock = fakeClock();
  const sessions = createSqliteSessionRepository(":memory:", { now: clock.now });
  t.after(() => sessions.close());
  const repository = await makeRepo(t);
  const userId = "u-test";
  await sessions.createUser({ userId });
  const main = await sessions.getMainSession(userId);
  const writer = (await sessions.acquireLease(userId, main.sessionId, "seed", 60_000))!;
  // 两条已落地位置（旧→新），随后一条坐标更新却没有任何消息的 run——
  // 建 run 后取消/失败时上报未落地，不能覆盖已生效的最近位置。
  const runOld = await sessions.createRun(writer, userId, {
    sessionId: main.sessionId,
    input: { text: "旧", requestId: null, location: { lat: 1, lng: 0 } },
    startImmediately: true,
  });
  await sessions.appendMessage(writer, userId, main.sessionId, {
    payload: { message: userMessage("旧") },
    runId: runOld.runId,
  });
  clock.advance(1_000);
  const runNew = await sessions.createRun(writer, userId, {
    sessionId: main.sessionId,
    input: { text: "新", requestId: null, location: { lat: 2, lng: 0 } },
    startImmediately: true,
  });
  await sessions.appendMessage(writer, userId, main.sessionId, {
    payload: { message: userMessage("新") },
    runId: runNew.runId,
  });
  clock.advance(1_000);
  await sessions.createRun(writer, userId, {
    sessionId: main.sessionId,
    input: { text: "未落地", requestId: null, location: { lat: 3, lng: 0 } },
    startImmediately: true,
  });
  await sessions.releaseLease(writer, userId, main.sessionId);

  const { session } = await makePersistent(t, [clarify()], {
    sessions,
    repository,
    locationAnchor: async () => undefined,
  });
  await session.prompt("再来");
  const section = locationSection(session) ?? "";
  assert.match(section, /纬度：2\.00000/);
  assert.doesNotMatch(section, /纬度：1\.00000|纬度：3\.00000/);
});

test("锚点解析抛错降级为无锚点，不影响本轮", async (t) => {
  const { session } = await makePersistent(t, [clarify()], {
    locationAnchor: async () => {
      throw new Error("锚点服务不可用");
    },
  });
  const turn = await session.prompt("附近", { location: { lat: 31.2, lng: 121.5 } });
  assert.equal(turn.kind, "clarification");
  const section = locationSection(session) ?? "";
  assert.match(section, /31\.20000/);
  assert.doesNotMatch(section, /锚点参考|距「/);
});

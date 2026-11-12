import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { PlannerSession } from "../src/agent/session.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";
import { createChatService } from "../src/web/service.ts";
import { BASE, CONFIG, makePersistent, makeRepo, makeStreamFn } from "./e2e-fixture.ts";
import { messageRecords } from "./persistent-fixture.ts";
import { fakeClock } from "./session-fixture.ts";

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
 * 跨请求沿用：service.send 每次都新建持久化 planner 并 close，"最近位置"
 * 不能只活在一个 PersistentRuntime 实例里——坐标随 run.input 快照落库，
 * 新实例 reload 时从会话最新一条带 location 的 run 恢复，锚点重解。
 * 这里走真实 createChatService + 默认 createPersistentPlanner + faux，
 * 直接观察 streamFn context.messages 里 system 的 location_context 节。
 */
test("service 跨请求沿用最近位置：新实例从 run.input 恢复，更新与用户隔离正确", async (t) => {
  const clock = fakeClock();
  const repo = await makeRepo(t);
  const sessions = createSqliteSessionRepository(":memory:", { now: clock.now });
  t.after(() => sessions.close());
  const faux = createFauxCore({});
  faux.setResponses([clarify(), clarify(), clarify(), clarify(), clarify()]);
  const { streamFn: scripted } = makeStreamFn(faux);
  // 记录每个模型请求实际看到的 location_context 节文本（无该节 → null）。
  const seen: (string | null | undefined)[] = [];
  const streamFn: StreamFn = (model, context, options) => {
    const system = context.messages.find((m) => m.role === "system") as
      | SystemMessage
      | undefined;
    seen.push(system?.sections?.["location_context"] ?? null);
    return scripted(model, context, options);
  };
  const service = createChatService({
    config: CONFIG,
    repository: repo,
    sessions,
    streamFn,
    currentDate: BASE,
  });
  t.after(async () => {
    await service.shutdown();
  });

  // 首轮带位置：坐标注入本轮 system section。
  await service.send("u-a", "附近逛逛", { location: { lat: 34.27, lng: 108.95 } });
  assert.match(seen[0] ?? "", /34\.27000；经度：108\.95000/);

  // 次轮不带位置：planner 是全新实例，须从会话库恢复同一坐标。
  clock.advance(1_000); // 保证两条 run 的 created_at 严格递增
  await service.send("u-a", "明天下午，还是附近");
  assert.match(seen[1] ?? "", /34\.27000；经度：108\.95000/);

  // 新位置覆盖旧值，之后的轮次沿用新坐标。
  clock.advance(1_000);
  await service.send("u-a", "换地方了", { location: { lat: 31.2, lng: 121.5 } });
  assert.match(seen[2] ?? "", /31\.20000；经度：121\.50000/);
  clock.advance(1_000);
  await service.send("u-a", "那附近呢");
  assert.match(seen[3] ?? "", /31\.20000；经度：121\.50000/);

  // 另一用户的会话没有 location run：无该节，不串 u-a 的位置。
  await service.send("u-b", "附近");
  assert.equal(seen[4], null);

  // 坐标只进 system section 与 run.input 快照：history 还原的消息不含坐标。
  const history = await service.history("u-a");
  assert.ok(!JSON.stringify(history).includes("34.27"));
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

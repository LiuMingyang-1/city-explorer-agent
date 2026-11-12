import assert from "node:assert/strict";
import { test } from "node:test";
import { SEARCH_EVENTS_TOOL } from "../src/agent/tools.ts";
import { createExplorerAgent } from "../src/agent/explorer-agent.ts";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import { AmapRoutingError } from "../src/routing/amap.ts";
import {
  createEstimateTravelTool,
  ESTIMATE_TRAVEL_TOOL,
} from "../src/agent/travel-tool.ts";
import type { EstimateTravelDetails } from "../src/agent/travel-tool.ts";
import { loadConfig } from "../src/config.ts";
import type { ExplorerConfig } from "../src/config.ts";
import type { EventRepository } from "../src/data/repository.ts";
import type { Event } from "../src/data/types.ts";
import type { RouteComputer, RouteRequest, RoutedLeg } from "../src/routing/types.ts";

/**
 * estimate_travel 工具与装配链路的离线测试：桩 RouteComputer +
 * 桩 EventRepository，覆盖工具降级与 explorer agent 按 key 挂载。
 */

const BASE = "2026-11-11";
const DAY = "2026-11-15";

const CONFIG: ExplorerConfig = {
  provider: "openai",
  model: "gpt-5.4",
  apiKey: "k",
  contextWindow: 128_000,
  maxTokens: 4096,
  dbPath: "unused.db",
};

function fakeEvent(id: string, overrides: Partial<Event> = {}): Event {
  return {
    id,
    title: `活动${id}`,
    description: "desc",
    category: "展览",
    venueName: `场馆${id}`,
    address: "addr",
    latitude: 34.249,
    longitude: 108.94,
    startAt: `${DAY}T13:00`,
    endAt: `${DAY}T18:00`,
    suggestedDurationMinutes: 90,
    budgetMin: 0,
    budgetMax: 0,
    currency: "CNY",
    budgetNote: null,
    guideUrl: null,
    thumbnailUrl: null,
    imageUrls: [],
    ...overrides,
  };
}

function stubRepository(events: Event[]): EventRepository {
  const byId = new Map(events.map((e) => [e.id, e]));
  return {
    search: async () => events,
    getByIds: async (ids) =>
      new Map(ids.flatMap((id) => (byId.has(id) ? [[id, byId.get(id)!]] : []))),
    close: () => {},
  };
}

function stubRouter(
  impl: (req: RouteRequest) => Promise<RoutedLeg> | RoutedLeg,
): { router: RouteComputer; calls: RouteRequest[] } {
  const calls: RouteRequest[] = [];
  return {
    calls,
    router: {
      route: (req) => {
        calls.push(req);
        return Promise.resolve(impl(req));
      },
    },
  };
}

function details(result: { content: unknown[] }): EstimateTravelDetails {
  return JSON.parse((result.content[0] as { text: string }).text) as EstimateTravelDetails;
}

// ---- estimate_travel 工具 ----

test("estimate_travel returns duration/distance/mode and auto-picks walking", async () => {
  const near = fakeEvent("a");
  const close = fakeEvent("b", { latitude: 34.252, longitude: 108.946 }); // ~645m
  const { router, calls } = stubRouter(() => ({
    durationSeconds: 600,
    distanceMeters: 640,
    geometry: null,
  }));
  const tool = createEstimateTravelTool({ router, repository: stubRepository([near, close]) });
  assert.equal(tool.name, ESTIMATE_TRAVEL_TOOL);

  const result = await tool.execute("t1", { from_event_id: "a", to_event_id: "b" });
  assert.equal(result.isError, false);
  assert.deepEqual(details(result), {
    duration_seconds: 600,
    distance_meters: 640,
    mode: "walking",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, "walking");
  assert.deepEqual(calls[0].origin, { lat: 34.249, lng: 108.94 });
  assert.deepEqual(calls[0].destination, { lat: 34.252, lng: 108.946 });
});

test("estimate_travel auto-picks transit for far stops and honors explicit mode", async () => {
  const a = fakeEvent("a");
  const far = fakeEvent("far", { latitude: 34.35, longitude: 108.95 }); // ~11km
  const { router, calls } = stubRouter(() => ({
    durationSeconds: 1800,
    distanceMeters: 11500,
    geometry: null,
  }));
  const tool = createEstimateTravelTool({ router, repository: stubRepository([a, far]) });

  const auto = await tool.execute("t2", { from_event_id: "a", to_event_id: "far" });
  assert.equal(details(auto).mode, "transit");
  assert.equal(calls[0].mode, "transit");

  // 显式 mode 覆盖阈值选择；自定义阈值也生效（645m > 300m → transit）。
  const explicit = await tool.execute("t3", {
    from_event_id: "a",
    to_event_id: "far",
    mode: "walking",
  });
  assert.equal(details(explicit).mode, "walking");
  assert.equal(calls[1].mode, "walking");

  const strict = createEstimateTravelTool({
    router,
    repository: stubRepository([a, fakeEvent("b", { latitude: 34.252, longitude: 108.946 })]),
    transitThresholdM: 300,
  });
  const res = await strict.execute("t4", { from_event_id: "a", to_event_id: "b" });
  assert.equal(details(res).mode, "transit");
});

test("estimate_travel returns structured errors and never throws", async () => {
  const a = fakeEvent("a");
  const { router } = stubRouter(() => {
    throw new AmapRoutingError("timeout", "高德算路超时（8s）");
  });
  const repo = stubRepository([a]);
  const tool = createEstimateTravelTool({ router, repository: repo });

  const missing = await tool.execute("t5", { from_event_id: "a", to_event_id: "ghost" });
  assert.equal(missing.isError, true);
  const missingPayload = details(missing);
  assert.equal(missingPayload.error_code, "missing_event");
  assert.match(missingPayload.error ?? "", /ghost/);

  const empty = await tool.execute("t6", { from_event_id: "", to_event_id: "a" });
  assert.equal(empty.isError, true);
  assert.match(details(empty).error ?? "", /不能为空/);

  const badMode = await tool.execute("t7", {
    from_event_id: "a",
    to_event_id: "a",
    mode: "drive" as "walking",
  });
  assert.equal(badMode.isError, true);
  assert.match(details(badMode).error ?? "", /walking\/transit/);

  const routed = await tool.execute("t8", { from_event_id: "a", to_event_id: "a" });
  assert.equal(routed.isError, true);
  const payload = details(routed);
  assert.equal(payload.error_code, "timeout");
  assert.match(payload.error ?? "", /超时/);
});

// ---- explorer agent 挂载 ----

test("explorer agent mounts estimate_travel only when routing is configured", async () => {
  const repo = stubRepository([fakeEvent("a")]);

  // 无 key：不挂工具，提示词保留「无路线计算工具」段落。
  const plain = await createExplorerAgent({ config: CONFIG, repository: repo, currentDate: BASE });
  assert.deepEqual(
    plain.state.tools.map((t) => t.name),
    [SEARCH_EVENTS_TOOL],
  );
  assert.ok(plain.state.systemPrompt.includes("目前没有路线计算工具"));
  assert.ok(!plain.state.systemPrompt.includes("estimate_travel"));

  // 有 key：自动建高德客户端并挂工具，提示词换成算路准则。
  const keyed = await createExplorerAgent({
    config: { ...CONFIG, amapKey: "K", amapTransitCity: "西安" },
    repository: repo,
    currentDate: BASE,
  });
  assert.deepEqual(
    keyed.state.tools.map((t) => t.name),
    [SEARCH_EVENTS_TOOL, ESTIMATE_TRAVEL_TOOL],
  );
  assert.ok(keyed.state.systemPrompt.includes("estimate_travel"));
  assert.ok(!keyed.state.systemPrompt.includes("目前没有路线计算工具"));

  // 无 key 但注入算路桩：照样挂载（测试/替代 provider 路径）。
  const { router } = stubRouter(() => ({ durationSeconds: 1, distanceMeters: 1, geometry: null }));
  const injected = await createExplorerAgent({
    config: CONFIG,
    repository: repo,
    currentDate: BASE,
    travelRouter: router,
  });
  assert.deepEqual(
    injected.state.tools.map((t) => t.name),
    [SEARCH_EVENTS_TOOL, ESTIMATE_TRAVEL_TOOL],
  );

  // 有 key 但显式 travelRouter: null → 强制关闭算路。
  const disabled = await createExplorerAgent({
    config: { ...CONFIG, amapKey: "K" },
    repository: repo,
    currentDate: BASE,
    travelRouter: null,
  });
  assert.deepEqual(
    disabled.state.tools.map((t) => t.name),
    [SEARCH_EVENTS_TOOL],
  );
  assert.ok(disabled.state.systemPrompt.includes("目前没有路线计算工具"));
});

test("system prompt stays byte-identical unless canEstimateTravel is true", () => {
  assert.equal(buildSystemPrompt(BASE), buildSystemPrompt(BASE, {}));
  assert.equal(buildSystemPrompt(BASE), buildSystemPrompt(BASE, { canEstimateTravel: false }));
  const routed = buildSystemPrompt(BASE, { canEstimateTravel: true });
  assert.ok(routed.includes(ESTIMATE_TRAVEL_TOOL));
  assert.ok(!routed.includes("目前没有路线计算工具"));
  // 两个开关可叠加：delegate 段落在算路段落之后照常追加。
  const both = buildSystemPrompt(BASE, { canDelegate: true, canEstimateTravel: true });
  assert.ok(both.includes("子任务委派") && both.includes(ESTIMATE_TRAVEL_TOOL));
});

// ---- loadConfig 新环境变量 ----

test("loadConfig reads EXPLORER_AMAP_* and threshold env", () => {
  const bare = loadConfig({ EXPLORER_API_KEY: "k" });
  assert.equal(bare.amapKey, undefined);
  assert.equal(bare.amapTransitCity, undefined);
  assert.equal(bare.routeTransitThresholdM, 3000);

  const loaded = loadConfig({
    EXPLORER_API_KEY: "k",
    EXPLORER_AMAP_KEY: "  amap-key  ",
    EXPLORER_AMAP_TRANSIT_CITY: "西安",
    EXPLORER_ROUTE_TRANSIT_THRESHOLD_M: "5000",
  });
  assert.equal(loaded.amapKey, "amap-key");
  assert.equal(loaded.amapTransitCity, "西安");
  assert.equal(loaded.routeTransitThresholdM, 5000);

  for (const bad of ["abc", "0", "-5", "4.5"]) {
    assert.throws(
      () => loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_ROUTE_TRANSIT_THRESHOLD_M: bad }),
      /EXPLORER_ROUTE_TRANSIT_THRESHOLD_M/,
    );
  }
  // 空白 key 视为未配置。
  assert.equal(
    loadConfig({ EXPLORER_API_KEY: "k", EXPLORER_AMAP_KEY: "   " }).amapKey,
    undefined,
  );
});

/**
 * GET /api/events 离线测试：真实 HTTP server → createChatHandler →
 * createChatService → 真实活动 SQLite（临时定制库，窗口/坐标可控）+
 * 真实会话 SQLite（:memory:）。不打模型、不读 .env、不碰仓库 data/。
 * 覆盖：date / from-to 窗口交集、bbox 过滤、limit、参数校验、契约形状。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import type { EventRepository } from "../src/data/repository.ts";
import { createSqliteEventRepository, ensureEventsSchema } from "../src/data/sqlite.ts";
import type { SessionRepository } from "../src/session/repository.ts";
import { createSqliteSessionRepository } from "../src/session/sqlite.ts";
import { createChatHandler } from "../src/web/http.ts";
import { createChatService, type ManagedChatService } from "../src/web/service.ts";
import { CONFIG } from "./e2e-fixture.ts";
import { call, cookieUserId, withCookie } from "./web-e2e-fixture.ts";

/** 服务端"今天"：注入 currentDate 固定，保证无参默认窗口断言确定。 */
const TODAY = "2026-11-14";

interface SeedEvent {
  id: string;
  startAt: string;
  endAt: string;
  lat: number;
  lng: number;
  title?: string;
  category?: string;
  venue?: string;
}

/**
 * 坐标分两组：曲江一带（lng≈108.9x、lat≈34.2x）与 evt_far 的北京坐标
 * （bbox 过滤的界外对照）；窗口覆盖单日/跨日/次日/过期四种形态。
 */
const SEED: SeedEvent[] = [
  // 跨 11-13 ~ 11-16 的多日窗口。
  {
    id: "evt_span",
    startAt: "2026-11-13T10:00",
    endAt: "2026-11-16T18:00",
    lat: 34.255,
    lng: 108.965,
    title: "跨日联展",
    venue: "曲江展厅",
  },
  // 仅 11-14 当天。
  {
    id: "evt_morning",
    startAt: "2026-11-14T09:00",
    endAt: "2026-11-14T12:00",
    lat: 34.25,
    lng: 108.96,
    title: "上午专场",
    venue: "美术馆",
  },
  // 仅 11-14 当天但坐标在北京：bbox 用例的界外点。
  {
    id: "evt_far",
    startAt: "2026-11-14T15:00",
    endAt: "2026-11-14T18:00",
    lat: 39.904,
    lng: 116.407,
    title: "同城异地",
    venue: "北京馆",
  },
  // 仅 11-15。
  {
    id: "evt_next",
    startAt: "2026-11-15T14:00",
    endAt: "2026-11-15T17:00",
    lat: 34.3,
    lng: 109.0,
    title: "次日分享",
    venue: "书屋",
  },
  // 11-14 之前的过期活动（任何近期窗口都不该命中）。
  {
    id: "evt_past",
    startAt: "2026-11-10T10:00",
    endAt: "2026-11-10T12:00",
    lat: 34.252,
    lng: 108.962,
    title: "过期旧展",
    venue: "旧馆",
  },
];

interface Stack {
  base: string;
  server: Server;
  service: ManagedChatService;
  repository: EventRepository;
  sessions: SessionRepository;
}

/** 写一个可控种子的活动库文件并起整栈；t.after 幂等收尾。 */
async function openStack(t: TestContext): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), "explorer-events-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "events.db");
  const db = new DatabaseSync(dbPath);
  ensureEventsSchema(db);
  const insert = db.prepare(
    `INSERT INTO events (id, title, description, category, venue_name, address,
       latitude, longitude, start_at, end_at, suggested_duration_minutes)
     VALUES (?, ?, 'd', ?, ?, 'a', ?, ?, ?, ?, 60)`,
  );
  for (const e of SEED) {
    insert.run(
      e.id,
      e.title ?? e.id,
      e.category ?? "展览",
      e.venue ?? "v",
      e.lat,
      e.lng,
      e.startAt,
      e.endAt,
    );
  }
  db.close();
  const repository = createSqliteEventRepository(dbPath);
  const sessions = createSqliteSessionRepository(":memory:");
  const service = createChatService({
    config: CONFIG,
    repository,
    sessions,
    currentDate: TODAY,
  });
  const server = createServer(createChatHandler(service, { onError: () => {} }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const stack: Stack = {
    base: `http://127.0.0.1:${port}`,
    server,
    service,
    repository,
    sessions,
  };
  t.after(async () => {
    await new Promise<void>((resolve) => stack.server.close(() => resolve()));
    await stack.service.shutdown();
    stack.sessions.close();
    stack.repository.close();
  });
  return stack;
}

const get = (stack: Stack, path: string, uid?: string) =>
  call(stack.base, path, uid === undefined ? {} : { headers: withCookie(uid) });

const eventIds = (body: unknown): string[] =>
  (body as { events: Array<{ event_id: string }> }).events.map((e) => e.event_id);

test("date 参数：返回当日可参加活动（含跨日窗口），按 start_at 排序，字段为 EventView 契约", async (t) => {
  const stack = await openStack(t);
  const reply = await get(stack, "/api/events?date=2026-11-14");
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["cache-control"], "no-store");
  const body = reply.json() as { events: Array<Record<string, unknown>> };
  assert.deepEqual(eventIds(body), ["evt_span", "evt_morning", "evt_far"]);
  // snake_case 线上契约：字段映射自存储层 Event，不透传 camelCase 键。
  const first = body.events[0];
  assert.equal(first.event_id, "evt_span");
  assert.equal(first.venue_name, "曲江展厅");
  assert.equal(first.start_at, "2026-11-13T10:00");
  assert.equal(first.end_at, "2026-11-16T18:00");
  assert.equal(first.suggested_duration_minutes, 60);
  assert.equal(first.id, undefined);
  assert.equal(first.venueName, undefined);
  assert.equal(first.startAt, undefined);
  // 首访照常签发匿名身份 cookie。
  assert.match(cookieUserId(reply) ?? "", /^[0-9a-f]{32}$/);
});

test("无日期参数：默认按服务端今天（currentDate）过滤", async (t) => {
  const stack = await openStack(t);
  const reply = await get(stack, "/api/events");
  assert.equal(reply.status, 200);
  // 与显式 ?date=TODAY 完全同集。
  assert.deepEqual(eventIds(reply.json()), ["evt_span", "evt_morning", "evt_far"]);
  // 未知查询参数不影响已知键解析（与 history 的 query 处理同口径）。
  const extra = await get(stack, "/api/events?date=2026-11-15&utm_source=x");
  assert.equal(extra.status, 200);
  assert.deepEqual(eventIds(extra.json()), ["evt_span", "evt_next"]);
});

test("from/to 日期范围：窗口与区间有交集即命中", async (t) => {
  const stack = await openStack(t);
  const reply = await get(stack, "/api/events?from=2026-11-15&to=2026-11-16");
  assert.equal(reply.status, 200);
  // evt_span 终点不早于 from、evt_next 落在区间内；evt_morning/evt_far 已结束。
  assert.deepEqual(eventIds(reply.json()), ["evt_span", "evt_next"]);
  // 开区间边界本身即"闭区间"：to=11-15 仍含当日起始的 evt_next。
  const same = await get(stack, "/api/events?from=2026-11-15&to=2026-11-15");
  assert.deepEqual(eventIds(same.json()), ["evt_span", "evt_next"]);
  // 区间落在所有窗口之外 → 空列表而非错误。
  const empty = await get(stack, "/api/events?from=2026-12-01&to=2026-12-31");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json(), { events: [] });
});

test("bbox 过滤：只返回 GCJ-02 包围盒内的活动", async (t) => {
  const stack = await openStack(t);
  // 覆盖曲江一带（lng 108.9~109.1、lat 34.2~34.4）；evt_far 在北京出盒。
  const reply = await get(stack, "/api/events?date=2026-11-14&bbox=108.9,34.2,109.1,34.4");
  assert.equal(reply.status, 200);
  assert.deepEqual(eventIds(reply.json()), ["evt_span", "evt_morning"]);
  // 盒内无活动的合法 bbox → 空列表。
  const empty = await get(stack, "/api/events?bbox=100,30,101,31");
  assert.deepEqual(eventIds(empty.json()), []);
});

test("limit：截断返回条数；缺省按契约默认，上限内合法值放行", async (t) => {
  const stack = await openStack(t);
  const one = await get(stack, "/api/events?date=2026-11-14&limit=1");
  assert.equal(one.status, 200);
  assert.deepEqual(eventIds(one.json()), ["evt_span"]); // 截断仍按 start_at 排序取前 N 条
  const max = await get(stack, "/api/events?date=2026-11-14&limit=500");
  assert.equal(max.status, 200);
  assert.equal(eventIds(max.json()).length, 3);
});

test("参数校验：日期互斥/缺对/非法/区间倒挂、畸形 bbox、非法/超限 limit、重复键一律 400", async (t) => {
  const stack = await openStack(t);
  for (const query of [
    "date=2026-11-14&from=2026-11-14&to=2026-11-15", // date 与 from/to 互斥
    "date=2026-11-14&to=2026-11-15",
    "date=2026-11-14&from=2026-11-14",
    "from=2026-11-15", // 缺 to
    "to=2026-11-15", // 缺 from
    "date=2026-02-30", // 非法历法日
    "date=2026-13-01",
    "date=2026/11/14",
    "date=",
    "from=abc&to=2026-11-15",
    "from=2026-11-16&to=2026-11-15", // 区间倒挂
    "bbox=1,2,3", // 分量不足
    "bbox=1,2,3,4,5", // 分量过多
    "bbox=1,2,3,abc", // 非数字
    "bbox=108,34,,35", // 空分量
    "bbox=108,34,107,35", // minLng > maxLng
    "bbox=108,95,109,96", // lat 越界
    "bbox=181,34,182,35", // lng 越界
    "limit=0",
    "limit=-1",
    "limit=1.5",
    "limit=abc",
    "limit=501", // 超契约上限
    "limit=",
    "date=2026-11-14&date=2026-11-15", // 键重复
    "bbox=1,2,3,4&bbox=1,2,3,4",
    "limit=10&limit=20",
  ]) {
    const reply = await get(stack, `/api/events?${query}`);
    assert.equal(reply.status, 400, query);
    assert.equal(typeof (reply.json() as { error?: unknown }).error, "string");
  }
  // 全部 400 后服务仍正常。
  const ok = await get(stack, "/api/events?date=2026-11-14");
  assert.equal(ok.status, 200);
});

test("路由与方法：POST → 405 + Allow、未知路径 → 404", async (t) => {
  const stack = await openStack(t);
  const wrongMethod = await call(stack.base, "/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "GET");
  const trailing = await get(stack, "/api/events/");
  assert.equal(trailing.status, 404);
  const unknown = await get(stack, "/api/nope");
  assert.equal(unknown.status, 404);
});

test("活动库全局共享：不同 cookie 用户看到同一列表", async (t) => {
  const stack = await openStack(t);
  const uidA = "a".repeat(32);
  const uidB = "b".repeat(32);
  const a = await get(stack, "/api/events?date=2026-11-14", uidA);
  const b = await get(stack, "/api/events?date=2026-11-14", uidB);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(a.json(), b.json());
});

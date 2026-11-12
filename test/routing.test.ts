import assert from "node:assert/strict";
import { test } from "node:test";
import type { Event } from "../src/data/types.ts";
import type { ItineraryStop } from "../src/itinerary/types.ts";
import {
  AmapRoutingError,
  createAmapRouter,
  decodePolyline,
} from "../src/routing/amap.ts";
import {
  DEFAULT_TRANSIT_THRESHOLD_M,
  haversineMeters,
  pickTravelMode,
} from "../src/routing/geo.ts";
import { computePlanLegs, DEFAULT_LEG_BUFFER_SECONDS } from "../src/routing/legs.ts";
import type { RouteComputer, RouteRequest, RoutedLeg } from "../src/routing/types.ts";

/**
 * 高德算路链路离线单元测试：fetch 桩覆盖正常/超时/各类失败，
 * computePlanLegs 用 RouteComputer 桩，全程不发真实请求。
 */

const DAY = "2026-11-15";

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

function stop(event_id: string): ItineraryStop {
  return { event_id, arrive_at: "13:00", leave_at: "14:00", reason: "r" };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** fetch 桩：记录 URL，按 handler 返回响应。 */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const urls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    return handler(url, init);
  }) as typeof fetch;
  return { fetchFn, urls };
}

/** 挂起直到请求 signal abort 的 fetch 桩（超时路径用）。 */
function hangingFetch(): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) return reject(init.signal.reason);
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), {
        once: true,
      });
    })) as typeof fetch;
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

const WALKING_OK = {
  status: "1",
  info: "OK",
  infocode: "10000",
  route: {
    origin: "108.94,34.249",
    destination: "108.946,34.252",
    paths: [
      {
        distance: "860",
        duration: "720",
        steps: [
          { instruction: "向东走", polyline: "108.94,34.249;108.942,34.249" },
          { instruction: "向北走", polyline: "108.942,34.249;108.946,34.252" },
        ],
      },
    ],
  },
};

const TRANSIT_OK = {
  status: "1",
  info: "OK",
  route: {
    transits: [
      {
        duration: "1800",
        distance: "12000",
        walking_distance: "500",
        segments: [
          {
            walking: {
              steps: [{ polyline: "108.94,34.25;108.941,34.25" }],
            },
            bus: {
              buslines: [{ name: "地铁2号线", polyline: "108.941,34.25;108.95,34.3" }],
            },
            railway: [],
          },
        ],
      },
    ],
  },
};

// ---- decodePolyline / geo ----

test("decodePolyline parses lng,lat pairs and skips malformed points", () => {
  assert.deepEqual(decodePolyline("108.94,34.249;108.942,34.252"), [
    [108.94, 34.249],
    [108.942, 34.252],
  ]);
  assert.deepEqual(decodePolyline(""), []);
  assert.deepEqual(decodePolyline("bad;108.9,34.2;108.9"), [[108.9, 34.2]]);
});

test("haversineMeters is sane and pickTravelMode honors the threshold", () => {
  // 0.01° 纬度差约 1112 米。
  const d = haversineMeters({ lat: 34.25, lng: 108.94 }, { lat: 34.26, lng: 108.94 });
  assert.ok(d > 1000 && d < 1200, `got ${d}`);
  assert.equal(pickTravelMode(3000), "walking");
  assert.equal(pickTravelMode(3001), "transit");
  assert.equal(pickTravelMode(400, 300), "transit");
  assert.equal(DEFAULT_TRANSIT_THRESHOLD_M, 3000);
});

// ---- createAmapRouter ----

test("amap router walking request hits the walking endpoint and decodes geometry", async () => {
  const { fetchFn, urls } = stubFetch(() => jsonResponse(WALKING_OK));
  const router = createAmapRouter({ key: "K", fetchFn });
  const leg = await router.route({
    origin: { lat: 34.249, lng: 108.94 },
    destination: { lat: 34.252, lng: 108.946 },
    mode: "walking",
  });
  assert.equal(leg.durationSeconds, 720);
  assert.equal(leg.distanceMeters, 860);
  assert.deepEqual(leg.geometry, {
    type: "LineString",
    coordinates: [
      [108.94, 34.249],
      [108.942, 34.249],
      [108.946, 34.252],
    ],
  });
  assert.equal(urls.length, 1);
  const url = new URL(urls[0]);
  assert.equal(url.pathname, "/v3/direction/walking");
  assert.equal(url.searchParams.get("key"), "K");
  assert.equal(url.searchParams.get("origin"), "108.94,34.249");
  assert.equal(url.searchParams.get("destination"), "108.946,34.252");
});

test("amap router transit request sends city and merges segment polylines", async () => {
  const { fetchFn, urls } = stubFetch(() => jsonResponse(TRANSIT_OK));
  const router = createAmapRouter({ key: "K", city: "西安", fetchFn });
  const leg = await router.route({
    origin: { lat: 34.25, lng: 108.94 },
    destination: { lat: 34.3, lng: 108.95 },
    mode: "transit",
  });
  assert.equal(leg.durationSeconds, 1800);
  assert.equal(leg.distanceMeters, 12000);
  assert.deepEqual(leg.geometry?.coordinates, [
    [108.94, 34.25],
    [108.941, 34.25],
    [108.95, 34.3],
  ]);
  const url = new URL(urls[0]);
  assert.equal(url.pathname, "/v3/direction/transit/integrated");
  assert.equal(url.searchParams.get("city"), "西安");
});

test("amap router without city omits the city param", async () => {
  const { fetchFn, urls } = stubFetch(() => jsonResponse(TRANSIT_OK));
  const router = createAmapRouter({ key: "K", fetchFn });
  await router.route({
    origin: { lat: 34.25, lng: 108.94 },
    destination: { lat: 34.3, lng: 108.95 },
    mode: "transit",
  });
  assert.equal(new URL(urls[0]).searchParams.get("city"), null);
});

test("amap router maps failures to stable error codes", async () => {
  const cases: Array<{ body: unknown; status?: number; mode?: "walking" | "transit"; code: string }> = [
    { body: { status: "0", info: "INVALID_USER_KEY", infocode: "10001" }, code: "amap_error" },
    { body: { status: "1", route: { paths: [] } }, mode: "walking", code: "no_path" },
    { body: { status: "1", route: { transits: [] } }, code: "no_path" },
    { body: { status: "1" }, code: "no_path" },
    {
      body: { status: "1", route: { paths: [{ steps: [] }] } },
      mode: "walking",
      code: "bad_response",
    },
    { body: "oops", status: 500, code: "http_error" },
  ];
  for (const c of cases) {
    const { fetchFn } = stubFetch(() => jsonResponse(c.body, c.status ?? 200));
    const router = createAmapRouter({ key: "K", fetchFn });
    await assert.rejects(
      router.route({
        origin: { lat: 34.25, lng: 108.94 },
        destination: { lat: 34.3, lng: 108.95 },
        mode: c.mode ?? "transit",
      }),
      (error: unknown) => {
        assert.ok(error instanceof AmapRoutingError);
        assert.equal(error.code, c.code);
        return true;
      },
      `expected ${c.code}`,
    );
  }
});

test("amap router enforces the per-request timeout", async () => {
  const router = createAmapRouter({ key: "K", fetchFn: hangingFetch(), timeoutMs: 30 });
  await assert.rejects(
    router.route({
      origin: { lat: 34.25, lng: 108.94 },
      destination: { lat: 34.251, lng: 108.941 },
      mode: "walking",
    }),
    (error: unknown) => {
      assert.ok(error instanceof AmapRoutingError);
      assert.equal(error.code, "timeout");
      return true;
    },
  );
});

test("amap router forwards caller abort as aborted", async () => {
  const router = createAmapRouter({ key: "K", fetchFn: hangingFetch(), timeoutMs: 60_000 });
  const caller = new AbortController();
  const pending = router.route(
    {
      origin: { lat: 34.25, lng: 108.94 },
      destination: { lat: 34.251, lng: 108.941 },
      mode: "walking",
    },
    caller.signal,
  );
  setTimeout(() => caller.abort(), 20);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof AmapRoutingError);
    assert.equal(error.code, "aborted");
    return true;
  });
});

test("createAmapRouter requires a non-empty key", () => {
  assert.throws(() => createAmapRouter({ key: "" }), AmapRoutingError);
});

// ---- computePlanLegs ----

test("computePlanLegs routes adjacent stops in order and picks mode by distance", async () => {
  const near = fakeEvent("a");
  const mid = fakeEvent("b", { latitude: 34.252, longitude: 108.946 }); // ~645m
  const far = fakeEvent("c", { latitude: 34.35, longitude: 108.95 }); // ~11km
  const eventsById = new Map([near, mid, far].map((e) => [e.id, e]));
  const { router, calls } = stubRouter((req) => ({
    durationSeconds: req.mode === "walking" ? 600 : 1800,
    distanceMeters: req.mode === "walking" ? 640 : 11500,
    geometry: { type: "LineString", coordinates: [[108.94, 34.249]] },
  }));

  const legs = await computePlanLegs([stop("a"), stop("b"), stop("c")], eventsById, { router });
  assert.equal(legs.length, 2);
  assert.deepEqual(
    legs.map((l) => [l.from_event_id, l.to_event_id]),
    [
      ["a", "b"],
      ["b", "c"],
    ],
  );
  assert.deepEqual(
    calls.map((c) => c.mode),
    ["walking", "transit"],
  );
  const walk = legs[0];
  assert.equal(walk.status, "ok");
  assert.equal(walk.provider, "amap");
  assert.equal(walk.mode, "walking");
  assert.equal(walk.duration_seconds, 600);
  assert.equal(walk.distance_meters, 640);
  assert.equal(walk.buffer_seconds, DEFAULT_LEG_BUFFER_SECONDS);
  assert.deepEqual(walk.geometry, { type: "LineString", coordinates: [[108.94, 34.249]] });
  assert.equal(walk.error_code, null);
  assert.equal(legs[1].mode, "transit");
  assert.equal(legs[1].status, "ok");
});

test("computePlanLegs without a router marks every leg skipped", async () => {
  const eventsById = new Map([
    ["a", fakeEvent("a")],
    ["b", fakeEvent("b", { latitude: 34.252, longitude: 108.946 })],
  ]);
  const legs = await computePlanLegs([stop("a"), stop("b")], eventsById);
  assert.equal(legs.length, 1);
  assert.equal(legs[0].status, "skipped");
  assert.equal(legs[0].provider, "none");
  assert.equal(legs[0].error_code, "routing_disabled");
  assert.equal(legs[0].mode, "walking"); // mode 仍按距离选出
  assert.equal(legs[0].duration_seconds, null);
  assert.equal(legs[0].geometry, null);
});

test("computePlanLegs marks legs with missing events as skipped", async () => {
  const eventsById = new Map([["a", fakeEvent("a")]]);
  const { router, calls } = stubRouter(() => {
    throw new Error("must not be called");
  });
  const legs = await computePlanLegs([stop("a"), stop("ghost")], eventsById, { router });
  assert.equal(legs[0].status, "skipped");
  assert.equal(legs[0].error_code, "missing_event");
  assert.equal(calls.length, 0);
});

test("computePlanLegs degrades a single failed leg without failing the plan", async () => {
  const eventsById = new Map([
    ["a", fakeEvent("a")],
    ["b", fakeEvent("b", { latitude: 34.252, longitude: 108.946 })],
    ["c", fakeEvent("c", { latitude: 34.253, longitude: 108.947 })],
  ]);
  const { router } = stubRouter((req) => {
    if (req.destination.lat === 34.252) {
      throw new AmapRoutingError("timeout", "高德算路超时（8s）");
    }
    return { durationSeconds: 300, distanceMeters: 200, geometry: null };
  });
  const legs = await computePlanLegs([stop("a"), stop("b"), stop("c")], eventsById, {
    router,
    bufferSeconds: 120,
  });
  assert.equal(legs[0].status, "error");
  assert.equal(legs[0].error_code, "timeout");
  assert.equal(legs[0].provider, "none");
  assert.equal(legs[0].geometry, null);
  assert.equal(legs[0].buffer_seconds, 120);
  assert.equal(legs[1].status, "ok");
  assert.equal(legs[1].geometry, null); // 算路成功但接口没给轨迹
});

test("computePlanLegs maps non-amap errors to route_error and empty stops to []", async () => {
  const eventsById = new Map([
    ["a", fakeEvent("a")],
    ["b", fakeEvent("b")],
  ]);
  const { router } = stubRouter(() => {
    throw new Error("boom");
  });
  const legs = await computePlanLegs([stop("a"), stop("b")], eventsById, { router });
  assert.equal(legs[0].status, "error");
  assert.equal(legs[0].error_code, "route_error");
  assert.deepEqual(await computePlanLegs([stop("a")], eventsById, { router }), []);
  assert.deepEqual(await computePlanLegs([], eventsById, { router }), []);
});

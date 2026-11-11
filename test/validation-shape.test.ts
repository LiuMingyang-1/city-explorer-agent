import assert from "node:assert/strict";
import { test } from "node:test";
import { validateItinerary } from "../src/itinerary/validation.ts";
import {
  DAY,
  NO_LIMITS,
  eventsOf,
  makeEvent,
  makeItinerary,
  makeStop,
} from "./validation-fixtures.ts";

test("valid itinerary passes and is echoed back", () => {
  const result = validateItinerary(makeItinerary(), NO_LIMITS, eventsOf(makeEvent()));
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.itinerary, {
    date: DAY,
    summary: "下午看展",
    stops: [makeStop()],
  });
});

test("non-object candidates are invalid_shape", () => {
  for (const candidate of [null, "itinerary", 42, [], [makeStop()]]) {
    const result = validateItinerary(candidate, NO_LIMITS, new Map());
    assert.equal(result.ok, false, JSON.stringify(candidate));
    assert.equal(result.itinerary, undefined);
    assert.ok(result.issues.length > 0);
    assert.ok(result.issues.every((i) => i.code === "invalid_shape"));
  }
});

test("wrong field types are invalid_shape", () => {
  const cases = [
    makeItinerary({ date: 20261114 }),
    makeItinerary({ summary: undefined }),
    makeItinerary({ summary: null }),
    makeItinerary({ stops: "none" }),
    makeItinerary({ stops: ["not-an-object"] }),
    makeItinerary({ stops: [makeStop({ event_id: 23 })] }),
    makeItinerary({ stops: [makeStop({ event_id: "" })] }),
    makeItinerary({ stops: [makeStop({ reason: 0 })] }),
  ];
  for (const candidate of cases) {
    const result = validateItinerary(candidate, NO_LIMITS, eventsOf(makeEvent()));
    assert.equal(result.ok, false, JSON.stringify(candidate));
    assert.ok(result.issues.every((i) => i.code === "invalid_shape"));
  }
});

test("unreal dates and malformed times are invalid_shape", () => {
  const cases = [
    makeItinerary({ date: "2026-02-30" }),
    makeItinerary({ date: "2026-13-01" }),
    makeItinerary({ date: "14/11/2026" }),
    makeItinerary({ stops: [makeStop({ arrive_at: "7:00" })] }),
    makeItinerary({ stops: [makeStop({ leave_at: "24:00" })] }),
    makeItinerary({ stops: [makeStop({ leave_at: "12:60" })] }),
  ];
  for (const candidate of cases) {
    const result = validateItinerary(candidate, NO_LIMITS, eventsOf(makeEvent()));
    assert.equal(result.ok, false, JSON.stringify(candidate));
    assert.ok(result.issues.every((i) => i.code === "invalid_shape"));
  }
});

test("leave_at must be later than arrive_at", () => {
  for (const [arrive_at, leave_at] of [["15:00", "14:00"], ["14:00", "14:00"]]) {
    const result = validateItinerary(
      makeItinerary({ stops: [makeStop({ arrive_at, leave_at })] }),
      NO_LIMITS,
      eventsOf(makeEvent()),
    );
    assert.equal(result.ok, false, `${arrive_at}-${leave_at}`);
    assert.ok(result.issues.every((i) => i.code === "invalid_shape"));
  }
});

test("empty stops are allowed", () => {
  const result = validateItinerary(
    { date: DAY, summary: "当天没有合适的活动", stops: [] },
    NO_LIMITS,
    new Map(),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.itinerary?.stops, []);
});

test("structural problems short-circuit semantic checks", () => {
  // event_id 不存在本该是 unknown_event，但 stops 结构先失败就只报 invalid_shape。
  const result = validateItinerary(
    makeItinerary({ stops: [makeStop({ arrive_at: "25:00" })] }),
    NO_LIMITS,
    new Map(),
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.every((i) => i.code === "invalid_shape"));
});

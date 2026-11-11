import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlanningConstraints } from "../src/itinerary/types.ts";
import { validateItinerary } from "../src/itinerary/validation.ts";
import {
  DAY,
  NO_LIMITS,
  eventsOf,
  makeEvent,
  makeItinerary,
  makeStop,
} from "./validation-fixtures.ts";

test("unknown event ids are reported with the id", () => {
  const result = validateItinerary(makeItinerary(), NO_LIMITS, new Map());
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((i) => i.code), ["unknown_event"]);
  assert.equal(result.issues[0].event_id, "evt_001");
});

test("itinerary date must match the requested date", () => {
  const event = makeEvent({ startAt: "2026-11-15T10:00", endAt: "2026-11-15T18:00" });
  const result = validateItinerary(
    makeItinerary({ date: "2026-11-15" }),
    NO_LIMITS, // 用户要求 11-14，行程排在 11-15
    eventsOf(event),
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === "date_mismatch"));
});

test("event not attendable on the itinerary date is date_mismatch", () => {
  // 活动窗口完全在另一天 → date_mismatch 而不是 outside_event_window。
  const event = makeEvent({ startAt: "2026-11-15T10:00", endAt: "2026-11-15T18:00" });
  const result = validateItinerary(makeItinerary(), NO_LIMITS, eventsOf(event));
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((i) => i.code), ["date_mismatch"]);
});

test("visit outside the event window is outside_event_window", () => {
  const events = eventsOf(makeEvent()); // 10:00–18:00
  for (const [arrive_at, leave_at] of [["09:00", "10:30"], ["17:30", "19:00"]]) {
    const result = validateItinerary(
      makeItinerary({ stops: [makeStop({ arrive_at, leave_at })] }),
      NO_LIMITS,
      events,
    );
    assert.equal(result.ok, false, `${arrive_at}-${leave_at}`);
    assert.deepEqual(result.issues.map((i) => i.code), ["outside_event_window"]);
  }
  // 边界 inclusive：与窗口完全重合的到访合法。
  const edge = validateItinerary(
    makeItinerary({ stops: [makeStop({ arrive_at: "10:00", leave_at: "18:00" })] }),
    NO_LIMITS,
    events,
  );
  assert.equal(edge.ok, true);
});

test("visit outside user availability is outside_availability", () => {
  const constraints: PlanningConstraints = {
    date: DAY,
    availableStart: "13:00",
    availableEnd: "18:00",
  };
  // 活动窗口放宽到 09:00–22:00，使 stop 只违反可用时间。
  const events = eventsOf(makeEvent({ startAt: `${DAY}T09:00`, endAt: `${DAY}T22:00` }));
  for (const [arrive_at, leave_at] of [["10:30", "12:00"], ["17:00", "18:30"]]) {
    const result = validateItinerary(
      makeItinerary({ stops: [makeStop({ arrive_at, leave_at })] }),
      constraints,
      events,
    );
    assert.equal(result.ok, false, `${arrive_at}-${leave_at}`);
    assert.deepEqual(result.issues.map((i) => i.code), ["outside_availability"]);
  }
  // 边界 inclusive：正好贴着可用时间两端合法。
  const edge = validateItinerary(
    makeItinerary({ stops: [makeStop({ arrive_at: "13:00", leave_at: "18:00" })] }),
    constraints,
    events,
  );
  assert.equal(edge.ok, true);
});

test("malformed or reversed constraint bounds are rejected, not ignored", () => {
  // 行程本身完全合法（10:00–11:00 落在 09:00–22:00 窗口内），只因约束非法被拒。
  const events = eventsOf(makeEvent({ startAt: `${DAY}T09:00`, endAt: `${DAY}T22:00` }));
  const fine = makeItinerary({ stops: [makeStop({ arrive_at: "10:00", leave_at: "11:00" })] });
  for (const constraints of [
    { date: DAY, availableStart: "99:00", availableEnd: "99:99" },
    { date: DAY, availableStart: "25:00" },
    { date: DAY, availableEnd: "12:60" },
    { date: DAY, availableStart: "18:00", availableEnd: "13:00" },
    { date: "2026-02-30" },
  ]) {
    const result = validateItinerary(fine, constraints, events);
    assert.equal(result.ok, false, JSON.stringify(constraints));
    assert.equal(result.itinerary, undefined);
    assert.ok(result.issues.every((i) => i.code === "invalid_constraints"));
  }
});

test("invalid constraints reject even an empty-stops itinerary", () => {
  // P2 回归：逆序边界 + 空 stops 不能再返回 ok:true。
  const result = validateItinerary(
    { date: DAY, summary: "当天没有合适的活动", stops: [] },
    { date: DAY, availableStart: "18:00", availableEnd: "13:00" },
    new Map(),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((i) => i.code), ["invalid_constraints"]);
});

test("missing availability bounds means the whole day is usable", () => {
  const earlyBird = makeEvent({ startAt: `${DAY}T06:00`, endAt: `${DAY}T23:30` });
  const result = validateItinerary(
    makeItinerary({ stops: [makeStop({ arrive_at: "07:00", leave_at: "08:00" })] }),
    NO_LIMITS,
    eventsOf(earlyBird),
  );
  assert.equal(result.ok, true);
});

test("cross-day event windows compare as local datetimes on the itinerary date", () => {
  // 跨日演出：11-14 20:00 到 11-15 02:00。
  const overnight = makeEvent({
    id: "evt_night",
    startAt: "2026-11-14T20:00",
    endAt: "2026-11-15T02:00",
  });
  const events = eventsOf(overnight);

  // 首日晚间到访合法。
  const evening = validateItinerary(
    makeItinerary({
      stops: [makeStop({ event_id: "evt_night", arrive_at: "21:00", leave_at: "23:00" })],
    }),
    NO_LIMITS,
    events,
  );
  assert.equal(evening.ok, true);

  // 次日凌晨到访（窗口尾部）同样合法。
  const pastMidnight = validateItinerary(
    makeItinerary({
      date: "2026-11-15",
      stops: [makeStop({ event_id: "evt_night", arrive_at: "00:30", leave_at: "01:30" })],
    }),
    { date: "2026-11-15" },
    events,
  );
  assert.equal(pastMidnight.ok, true);

  // 次日窗口已结束后的到访判 outside_event_window。
  const tooLate = validateItinerary(
    makeItinerary({
      date: "2026-11-15",
      stops: [makeStop({ event_id: "evt_night", arrive_at: "10:00", leave_at: "11:00" })],
    }),
    { date: "2026-11-15" },
    events,
  );
  assert.equal(tooLate.ok, false);
  assert.deepEqual(tooLate.issues.map((i) => i.code), ["outside_event_window"]);

  // 多日市集（13–16 日整天）覆盖行程日，任意时刻到访合法。
  const multiDay = makeEvent({
    id: "evt_fair",
    startAt: "2026-11-13T09:00",
    endAt: "2026-11-16T21:00",
  });
  const midday = validateItinerary(
    makeItinerary({
      stops: [makeStop({ event_id: "evt_fair", arrive_at: "12:00", leave_at: "13:00" })],
    }),
    NO_LIMITS,
    eventsOf(multiDay),
  );
  assert.equal(midday.ok, true);
});

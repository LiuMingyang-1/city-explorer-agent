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

test("stops must not overlap in visit order", () => {
  const a = makeEvent({ id: "evt_a" });
  const b = makeEvent({ id: "evt_b" });
  const events = eventsOf(a, b);

  const overlapping = validateItinerary(
    makeItinerary({
      stops: [
        makeStop({ event_id: "evt_a", arrive_at: "13:00", leave_at: "15:00" }),
        makeStop({ event_id: "evt_b", arrive_at: "14:30", leave_at: "16:00" }),
      ],
    }),
    NO_LIMITS,
    events,
  );
  assert.equal(overlapping.ok, false);
  assert.deepEqual(overlapping.issues.map((i) => i.code), ["stop_overlap"]);
  assert.equal(overlapping.issues[0].event_id, "evt_b");

  // 顺序写反（第二站早于第一站结束）同样算重叠。
  const outOfOrder = validateItinerary(
    makeItinerary({
      stops: [
        makeStop({ event_id: "evt_a", arrive_at: "15:00", leave_at: "16:00" }),
        makeStop({ event_id: "evt_b", arrive_at: "13:00", leave_at: "14:00" }),
      ],
    }),
    NO_LIMITS,
    events,
  );
  assert.equal(outOfOrder.ok, false);
  assert.ok(outOfOrder.issues.some((i) => i.code === "stop_overlap"));

  // 首尾相接（leave_at == 下一站 arrive_at）不算重叠。
  const backToBack = validateItinerary(
    makeItinerary({
      stops: [
        makeStop({ event_id: "evt_a", arrive_at: "13:00", leave_at: "14:00" }),
        makeStop({ event_id: "evt_b", arrive_at: "14:00", leave_at: "15:30" }),
      ],
    }),
    NO_LIMITS,
    events,
  );
  assert.equal(backToBack.ok, true);
});

test("not ok results collect every issue and omit the itinerary", () => {
  const known = makeEvent({ id: "evt_a", startAt: `${DAY}T09:00`, endAt: `${DAY}T20:00` });
  const result = validateItinerary(
    makeItinerary({
      stops: [
        makeStop({ event_id: "evt_ghost", arrive_at: "13:00", leave_at: "14:00" }),
        makeStop({ event_id: "evt_a", arrive_at: "13:30", leave_at: "18:30" }),
      ],
    }),
    { date: DAY, availableEnd: "18:00" },
    eventsOf(known),
  );
  assert.equal(result.ok, false);
  assert.equal(result.itinerary, undefined);
  assert.deepEqual(result.issues.map((i) => i.code), [
    "unknown_event",
    "outside_availability",
    "stop_overlap",
  ]);
});

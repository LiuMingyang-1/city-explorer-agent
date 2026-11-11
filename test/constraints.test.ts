import assert from "node:assert/strict";
import { test } from "node:test";
import {
  constraintProblems,
  isCalendarDate,
  isClockTime,
  mergeConstraints,
} from "../src/itinerary/constraints.ts";

test("isCalendarDate / isClockTime accept only real dates and clock times", () => {
  assert.ok(isCalendarDate("2026-11-14"));
  assert.ok(!isCalendarDate("2026-02-30"));
  assert.ok(!isCalendarDate("2026-13-01"));
  assert.ok(!isCalendarDate("14/11/2026"));
  assert.ok(!isCalendarDate(20261114));
  assert.ok(isClockTime("00:00") && isClockTime("23:59"));
  for (const bad of ["24:00", "12:60", "99:00", "99:99", "7:00", "ab:cd", 1300]) {
    assert.ok(!isClockTime(bad), JSON.stringify(bad));
  }
});

test("constraintProblems flags fake dates, unreal clocks and reversed bounds", () => {
  assert.deepEqual(constraintProblems({ date: "2026-11-14" }), []);
  assert.deepEqual(
    constraintProblems({ date: "2026-11-14", availableStart: "13:00" }),
    [],
  );
  assert.deepEqual(
    constraintProblems({ date: "2026-11-14", availableStart: "13:00", availableEnd: "18:00" }),
    [],
  );
  for (const c of [
    { date: "2026-02-30" },
    { date: "周六" },
    { date: "2026-11-14", availableStart: "99:00" },
    { date: "2026-11-14", availableEnd: "99:99" },
    { date: "2026-11-14", availableEnd: "12:60" },
    { date: "2026-11-14", availableStart: "18:00", availableEnd: "13:00" },
    { date: "2026-11-14", availableStart: "13:00", availableEnd: "13:00" },
  ]) {
    assert.ok(constraintProblems(c).length > 0, JSON.stringify(c));
  }
});

test("mergeConstraints inherits missing fields and applies explicit updates", () => {
  const confirmed = { date: "2026-11-14", availableStart: "13:00", availableEnd: "18:00" };
  // 补丁缺省字段 → 沿用已确认值
  assert.deepEqual(mergeConstraints(confirmed, { date: "2026-11-14" }), confirmed);
  // 显式新值覆盖（"晚一小时" 更新 start，end 仍沿用）
  assert.deepEqual(
    mergeConstraints(confirmed, { date: "2026-11-14", availableStart: "14:00" }),
    { date: "2026-11-14", availableStart: "14:00", availableEnd: "18:00" },
  );
  // 换日期但未提时段 → 原时段继续生效（用户要改时段需明说）
  assert.deepEqual(mergeConstraints(confirmed, { date: "2026-11-15" }), {
    date: "2026-11-15",
    availableStart: "13:00",
    availableEnd: "18:00",
  });
});

test("mergeConstraints treats null as explicit clear and works without prev", () => {
  const confirmed = { date: "2026-11-14", availableStart: "13:00", availableEnd: "18:00" };
  // null 显式清除，不会回填已确认值
  assert.deepEqual(
    mergeConstraints(confirmed, { date: "2026-11-14", availableStart: null }),
    { date: "2026-11-14", availableEnd: "18:00" },
  );
  assert.deepEqual(
    mergeConstraints(confirmed, { date: "2026-11-14", availableStart: null, availableEnd: null }),
    { date: "2026-11-14" },
  );
  // 没有已确认约束：补丁原样生效；null 等价于没给
  assert.deepEqual(
    mergeConstraints(undefined, { date: "2026-11-14", availableStart: "09:00" }),
    { date: "2026-11-14", availableStart: "09:00" },
  );
  assert.deepEqual(
    mergeConstraints(undefined, { date: "2026-11-14", availableStart: null }),
    { date: "2026-11-14" },
  );
});

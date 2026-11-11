import type { PlanningConstraints } from "./types.ts";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;

/** value 是否为 "YYYY-MM-DD" 形式的真实日历日期（拒绝 02-30 等）。 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  return (
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day
  );
}

/** value 是否为 "HH:MM" 形式的真实时钟时间（00:00–23:59）。 */
export function isClockTime(value: unknown): value is string {
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) return false;
  const [hour, minute] = value.split(":").map(Number);
  return hour <= 23 && minute <= 59;
}

/**
 * 模型单轮上报的约束补丁（response.ts 解析产物）：
 * 字符串=设置或更新该字段；null=用户明确放开该限制（显式清除）；
 * 字段缺省=未提及，交给 mergeConstraints 沿用已确认值。date 每轮必填。
 */
export interface ConstraintsPatch {
  date: string;
  availableStart?: string | null;
  availableEnd?: string | null;
}

const BOUND_FIELDS = ["availableStart", "availableEnd"] as const;

/**
 * 已确认约束 + 本轮补丁 → 本轮生效约束。
 * - 补丁给字符串：显式更新（"晚一小时"走这条路覆盖 availableStart）。
 * - 补丁给 null：用户明确放开，清除该字段（不再沿用）。
 * - 补丁缺省：沿用 prev；换日期不影响时段继承（用户没说就视为原时段仍有效）。
 */
export function mergeConstraints(
  prev: PlanningConstraints | undefined,
  patch: ConstraintsPatch,
): PlanningConstraints {
  const merged: PlanningConstraints = { date: patch.date };
  for (const field of BOUND_FIELDS) {
    const value = patch[field];
    if (value === null) continue;
    const effective = value !== undefined ? value : prev?.[field];
    if (effective !== undefined) merged[field] = effective;
  }
  return merged;
}

/**
 * 校验一组约束本身是否合法：date 为真实日历日期；时段边界为真实时钟；
 * 两端齐全时要求 availableStart 早于 availableEnd。返回中文问题列表
 * （空数组=合法），供 validateItinerary 判 invalid_constraints。
 */
export function constraintProblems(constraints: PlanningConstraints): string[] {
  const problems: string[] = [];
  const show = (value: unknown) => JSON.stringify(value) ?? "undefined";
  if (!isCalendarDate(constraints.date)) {
    problems.push(`constraints.date 必须是真实日期 "YYYY-MM-DD"，得到 ${show(constraints.date)}`);
  }
  for (const field of BOUND_FIELDS) {
    const value = constraints[field];
    if (value !== undefined && !isClockTime(value)) {
      problems.push(`constraints.${field} 必须是真实时钟 "HH:MM"，得到 ${show(value)}`);
    }
  }
  if (
    isClockTime(constraints.availableStart) &&
    isClockTime(constraints.availableEnd) &&
    constraints.availableStart >= constraints.availableEnd
  ) {
    problems.push(
      `constraints.availableStart（${constraints.availableStart}）必须早于 availableEnd（${constraints.availableEnd}）`,
    );
  }
  return problems;
}

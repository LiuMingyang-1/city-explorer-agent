import type { Event } from "../data/types.ts";
import { constraintProblems, isCalendarDate, isClockTime } from "./constraints.ts";
import type { Itinerary, ItineraryStop, PlanningConstraints } from "./types.ts";

export type ValidationCode =
  | "invalid_shape" // 不是约定的行程 JSON 结构
  | "invalid_constraints" // 约束本身非法（假日期/假时钟/时段逆序）
  | "unknown_event" // event_id 不在数据库中
  | "date_mismatch" // 行程或活动日期与要求日期不符
  | "outside_event_window" // 到访时间超出活动可参加时段
  | "outside_availability" // 到访时间超出用户可用时间段
  | "stop_overlap"; // 各站时间相互重叠

export interface ValidationIssue {
  code: ValidationCode;
  message: string;
  event_id?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** ok 时为通过结构检查的行程，否则为 undefined。 */
  itinerary?: Itinerary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 用普通代码校验模型输出的行程。candidate 为 JSON.parse 后的原始值，
 * 先做结构检查再逐站核对；events 由调用方用 repository.getByIds 取回，
 * 覆盖 candidate 中出现的全部 event_id。
 *
 * 时间全部按本地时间字符串比较：Event.startAt/endAt 是 "YYYY-MM-DDTHH:MM"，
 * stop 的 arrive_at/leave_at 是行程当日 "HH:MM"，拼成 `${date}T${time}` 后
 * 字典序即时间序。跨日活动窗口（如 20:00–次日 02:00 的演出）因此天然支持：
 * 次日 00:30–01:30 的到访落在窗口内，而次日晚上的到访会被判出界。
 */
export function validateItinerary(
  candidate: unknown,
  constraints: PlanningConstraints,
  events: Map<string, Event>,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const fail = (code: ValidationCode, message: string, event_id?: string) => {
    issues.push(event_id ? { code, message, event_id } : { code, message });
  };
  const show = (value: unknown) => JSON.stringify(value) ?? "undefined";

  // 约束是校验基准：本身非法（含空 stops 的情况）直接拒绝，不把坏边界当成全天可用。
  for (const problem of constraintProblems(constraints)) {
    fail("invalid_constraints", problem);
  }
  if (issues.length > 0) return { ok: false, issues };

  if (!isRecord(candidate)) {
    fail("invalid_shape", `行程必须是包含 date/summary/stops 的对象，得到 ${show(candidate)}`);
    return { ok: false, issues };
  }

  if (!isCalendarDate(candidate.date)) {
    fail("invalid_shape", `date 必须是真实日期 "YYYY-MM-DD"，得到 ${show(candidate.date)}`);
  }
  if (typeof candidate.summary !== "string") {
    fail("invalid_shape", `summary 必须是字符串，得到 ${show(candidate.summary)}`);
  }
  if (!Array.isArray(candidate.stops)) {
    fail("invalid_shape", `stops 必须是数组，得到 ${show(candidate.stops)}`);
    return { ok: false, issues };
  }

  // 逐站结构检查：字段类型正确、时间为真实时钟时间、leave_at 晚于 arrive_at。
  const stops: ItineraryStop[] = [];
  candidate.stops.forEach((value, index) => {
    const where = `stops[${index}]`;
    if (!isRecord(value)) {
      fail("invalid_shape", `${where} 必须是对象，得到 ${show(value)}`);
      return;
    }
    const eventId = typeof value.event_id === "string" ? value.event_id : undefined;
    let valid = true;
    if (!eventId) {
      fail("invalid_shape", `${where}.event_id 必须是非空字符串，得到 ${show(value.event_id)}`);
      valid = false;
    }
    for (const field of ["arrive_at", "leave_at"] as const) {
      if (!isClockTime(value[field])) {
        fail("invalid_shape", `${where}.${field} 必须是 "HH:MM" 时钟时间，得到 ${show(value[field])}`, eventId);
        valid = false;
      }
    }
    if (typeof value.reason !== "string") {
      fail("invalid_shape", `${where}.reason 必须是字符串，得到 ${show(value.reason)}`, eventId);
      valid = false;
    }
    if (valid && (value.leave_at as string) <= (value.arrive_at as string)) {
      fail("invalid_shape", `${where} 的 leave_at 必须晚于 arrive_at`, eventId);
      valid = false;
    }
    if (valid) {
      stops.push({
        event_id: eventId as string,
        arrive_at: value.arrive_at as string,
        leave_at: value.leave_at as string,
        reason: value.reason as string,
      });
    }
  });

  // 结构有问题先返回，不继续做语义检查。
  if (issues.length > 0) return { ok: false, issues };

  const itinerary: Itinerary = {
    date: candidate.date as string,
    summary: candidate.summary as string,
    stops,
  };

  if (itinerary.date !== constraints.date) {
    fail("date_mismatch", `行程日期 ${itinerary.date} 与要求的 ${constraints.date} 不符`);
  }

  // 约束已通过 constraintProblems：边界一定是真实时钟或 undefined，可直接比较。
  const availStart = constraints.availableStart;
  const availEnd = constraints.availableEnd;
  const availLabel = `${availStart ?? "00:00"}–${availEnd ?? "23:59"}`;

  stops.forEach((stop, index) => {
    const where = `stops[${index}](${stop.event_id})`;
    const event = events.get(stop.event_id);
    if (!event) {
      fail("unknown_event", `${where} 的活动不存在`, stop.event_id);
      return;
    }
    // 活动窗口与行程当日有交集才可在该日参加（与 repository.search 一致）。
    if (event.startAt.slice(0, 10) > itinerary.date || event.endAt.slice(0, 10) < itinerary.date) {
      fail("date_mismatch", `${where} 的活动时段 ${event.startAt}–${event.endAt} 不覆盖行程日期`, stop.event_id);
      return;
    }
    if (`${itinerary.date}T${stop.arrive_at}` < event.startAt ||
        `${itinerary.date}T${stop.leave_at}` > event.endAt) {
      fail("outside_event_window", `${where} 到访 ${stop.arrive_at}–${stop.leave_at} 超出活动时段 ${event.startAt}–${event.endAt}`, stop.event_id);
    }
    if ((availStart !== undefined && stop.arrive_at < availStart) ||
        (availEnd !== undefined && stop.leave_at > availEnd)) {
      fail("outside_availability", `${where} 到访 ${stop.arrive_at}–${stop.leave_at} 超出可用时间 ${availLabel}`, stop.event_id);
    }
  });

  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1];
    const curr = stops[i];
    if (curr.arrive_at < prev.leave_at) {
      fail("stop_overlap", `stops[${i}] ${curr.arrive_at}–${curr.leave_at} 与上一站 ${prev.arrive_at}–${prev.leave_at} 时间重叠`, curr.event_id);
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, issues, itinerary };
}

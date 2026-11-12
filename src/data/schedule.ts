import { isCalendarDate, isClockTime } from "../itinerary/constraints.ts";
import { Ajv2020 } from "ajv/dist/2020.js";

export interface OpeningWindow { start: string | null; end: string | null; end_day_offset?: number; last_entry?: string | null; }
export interface DateOpening { date: string; closed?: boolean; windows?: OpeningWindow[]; }
export interface Schedule {
  timezone: "Asia/Shanghai"; mode: "weekly" | "dates" | "always_open" | "unknown";
  weekly?: { weekdays: number[]; windows: OpeningWindow[]; valid_from?: string | null; valid_to?: string | null }[];
  dates?: DateOpening[]; exceptions?: DateOpening[]; note?: string;
}
export interface AvailableWindow { startAt: string; endAt: string; lastEntryAt?: string; }
const windowSchema = { type: "object", additionalProperties: false, required: ["start", "end"], properties: {
  start: { type: ["string", "null"] }, end: { type: ["string", "null"] },
  end_day_offset: { type: "integer", minimum: 0, maximum: 1 }, last_entry: { type: ["string", "null"] },
} };
const dateSchema = { type: "object", additionalProperties: false, required: ["date"], properties: {
  date: { type: "string" }, closed: { type: "boolean" }, windows: { type: "array", maxItems: 24, items: windowSchema },
} };
export const scheduleSchema = { type: ["object", "null"], additionalProperties: false, required: ["timezone", "mode"], properties: {
  timezone: { const: "Asia/Shanghai" }, mode: { enum: ["weekly", "dates", "always_open", "unknown"] },
  weekly: { type: "array", maxItems: 14, items: { type: "object", additionalProperties: false, required: ["weekdays", "windows"], properties: {
    weekdays: { type: "array", minItems: 1, maxItems: 7, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 7 } },
    valid_from: { type: ["string", "null"] }, valid_to: { type: ["string", "null"] },
    windows: { type: "array", maxItems: 24, items: windowSchema },
  } } },
  dates: { type: "array", maxItems: 1000, items: dateSchema }, exceptions: { type: "array", maxItems: 1000, items: dateSchema }, note: { type: "string", maxLength: 2000 },
} };
export function scheduleProblems(schedule: Schedule | null | undefined): string[] {
  if (!schedule) return [];
  const errors: string[] = [];
  for (const rule of schedule.weekly ?? []) {
    if (rule.valid_from && !isCalendarDate(rule.valid_from) || rule.valid_to && !isCalendarDate(rule.valid_to)
      || rule.valid_from && rule.valid_to && rule.valid_from > rule.valid_to) errors.push("INVALID_SCHEDULE_DATE");
  }
  for (const list of [schedule.dates ?? [], schedule.exceptions ?? []]) {
    const seen = new Set<string>();
    for (const item of list) {
      if (!isCalendarDate(item.date) || seen.has(item.date)) errors.push("INVALID_SCHEDULE_DATE");
      seen.add(item.date);
      if (item.closed && item.windows?.length) errors.push("CLOSED_WITH_WINDOWS");
    }
  }
  const windows = [...(schedule.weekly ?? []).flatMap(r => r.windows), ...(schedule.dates ?? []).flatMap(r => r.windows ?? []), ...(schedule.exceptions ?? []).flatMap(r => r.windows ?? [])];
  for (const w of windows) {
    if (w.start !== null && !isClockTime(w.start) || w.end !== null && !isClockTime(w.end) || w.last_entry != null && !isClockTime(w.last_entry)) errors.push("INVALID_SCHEDULE_CLOCK");
    if (w.start && w.end) {
      const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
      const start = minutes(w.start), end = minutes(w.end) + (w.end_day_offset ?? 0) * 1440;
      if (end <= start || end - start > 1440) errors.push("INVALID_SCHEDULE_WINDOW");
      if (w.last_entry) { let entry = minutes(w.last_entry); if (entry < start && w.end_day_offset) entry += 1440; if (entry < start || entry > end) errors.push("INVALID_LAST_ENTRY"); }
    }
  }
  return [...new Set(errors)];
}
export function parseSchedule(value: string | Schedule | null | undefined): Schedule | null {
  const schedule = typeof value === "string" ? JSON.parse(value) as Schedule | null : value ?? null;
  if (!validateSchedule(schedule) || scheduleProblems(schedule).length) throw new Error("INVALID_STORED_SCHEDULE");
  return schedule;
}
const validateSchedule = new Ajv2020({ allErrors: true }).compile(scheduleSchema);
const shift = (date: string, days: number) => new Date(Date.parse(date + "T12:00:00Z") + days * 86400000).toISOString().slice(0, 10);
export function availabilityOnDate(input: { timeStatus?: string; recordType?: "activity" | "attraction"; validFrom?: string | null; validTo?: string | null; schedule?: Schedule | null; startAt?: string | null; endAt?: string | null }, date: string): { state: "open" | "closed" | "unknown"; windows: AvailableWindow[] } {
  if (!isCalendarDate(date)) return { state: "unknown", windows: [] };
  const schedule = input.schedule;
  const outside = !!(input.validFrom && date < input.validFrom || input.validTo && date > input.validTo);
  if (input.timeStatus === "conflicting" || input.timeStatus === "unknown") return {state: outside && input.recordType !== "attraction" ? "closed" : "unknown", windows: []};
  if (schedule?.exceptions?.some(e => e.date === date && e.closed)) return { state: "closed", windows: [] };
  if (!schedule) {
    if (input.startAt && input.endAt) return input.startAt.slice(0, 10) <= date && input.endAt.slice(0, 10) >= date
      ? { state: "open", windows: [{ startAt: input.startAt, endAt: input.endAt }] } : { state: "closed", windows: [] };
    if (outside) return { state: input.recordType === "attraction" ? "unknown" : "closed", windows: [] };
    return { state: "unknown", windows: [] };
  }
  const windows: AvailableWindow[] = []; let unknown = false;
  for (const day of [shift(date, -1), date]) {
    if (input.validFrom && day < input.validFrom || input.validTo && day > input.validTo) continue;
    const override = schedule.exceptions?.find(e => e.date === day);
    let rules: OpeningWindow[] | undefined;
    if (override) rules = override.closed ? [] : override.windows;
    else if (schedule.mode === "always_open") rules = [{ start: "00:00", end: "00:00", end_day_offset: 1 }];
    else if (schedule.mode === "dates" && schedule.dates?.length) { const entry = schedule.dates.find(e => e.date === day); rules = entry ? entry.closed ? [] : entry.windows : []; }
    else if (schedule.mode === "weekly" && schedule.weekly?.length) {
      const weekday = new Date(day + "T12:00:00Z").getUTCDay() || 7;
      const active = schedule.weekly.filter(r => (!r.valid_from || day >= r.valid_from) && (!r.valid_to || day <= r.valid_to));
      if (active.length) rules = active.filter(r => r.weekdays.includes(weekday)).flatMap(r => r.windows);
    }
    if (!rules) { if (day === date) unknown = true; continue; }
    for (const rule of rules) {
      if (!rule.start || !rule.end) { if (day === date) unknown = true; continue; }
      const endDate = shift(day, rule.end_day_offset ?? 0);
      const w: AvailableWindow = { startAt: `${day}T${rule.start}`, endAt: `${endDate}T${rule.end}` };
      if (w.endAt <= date + "T00:00" || w.startAt >= shift(date, 1) + "T00:00") continue;
      if (rule.last_entry) w.lastEntryAt = `${rule.last_entry < rule.start && rule.end_day_offset ? endDate : day}T${rule.last_entry}`;
      windows.push(w);
    }
  }
  const distinct = [...new Map(windows.map(w => [JSON.stringify(w), w])).values()].sort((a, b) => a.startAt.localeCompare(b.startAt));
  return { state: distinct.length ? "open" : unknown || input.recordType === "attraction" && outside ? "unknown" : "closed", windows: distinct };
}

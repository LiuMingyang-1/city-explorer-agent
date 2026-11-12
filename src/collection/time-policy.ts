import { isCalendarDate } from "../itinerary/constraints.ts";
import { parseSchedule } from "../data/schedule.ts";
import { normalizeActivityTime } from "./time-normalization.ts";

/** Downgrade unusable time fields, never repair them by guessing. Applied before
 * schema validation; identity, price and location errors are still rejected. */
export function softenTime(value: Record<string, any>, source: string): void {
  const notes: string[] = typeof value.time_note === "string" && value.time_note.trim() ? [value.time_note.trim()] : [];
  let downgraded = false;
  for (const key of ["start_at", "end_at"]) if (typeof value[key] === "string") value[key] = normalizeActivityTime(value[key]);
  const clear = (key: string, reason: string) => {
    if (value[key] != null) { notes.push(`${reason}：${JSON.stringify(value[key])}`); value[key] = null; downgraded = true; }
  };
  for (const key of ["valid_from", "valid_to", "confirmed_start_date", "confirmed_end_date"])
    if (value[key] != null && (typeof value[key] !== "string" || !isCalendarDate(value[key]))) clear(key, "未规范日期");
  if (value.valid_from && value.valid_to && value.valid_from > value.valid_to) { clear("valid_from", "日期顺序待确认"); clear("valid_to", "日期顺序待确认"); value.confirmed_start_date = value.confirmed_end_date = null; }
  const clock = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(v) && isCalendarDate(v.slice(0, 10));
  for (const key of ["start_at", "end_at"]) if (value[key] != null && !clock(value[key])) clear(key, "未规范时刻");
  if (value.start_at && value.end_at && (value.end_at <= value.start_at || Date.parse(value.end_at) - Date.parse(value.start_at) > 86400000)) {
    clear("start_at", "非单次合法时间窗口"); clear("end_at", "非单次合法时间窗口");
  }
  if (typeof value.schedule_json === "string") { try { value.schedule_json = JSON.parse(value.schedule_json); } catch { clear("schedule_json", "开放规则未规范"); } }
  try { parseSchedule(value.schedule_json); } catch { clear("schedule_json", "开放规则未通过格式检查"); }
  const conflicts = Array.isArray(value.conflicts) ? value.conflicts : [];
  // The model explicitly labels conflicting time. Other conflicts stay in notes,
  // and the independent map-result binding determines whether location is usable.
  const conflict = value.time_status === "conflicting" || conflicts.some((s: unknown) => typeof s === "string" && /时间|日期|展期|结束日|起始日|开放|闭馆|时段|检票/.test(s));
  if (conflicts.length) notes.push(...conflicts.filter((s: unknown): s is string => typeof s === "string"));
  if (conflict) { clear("schedule_json", "时间冲突，待确认"); clear("start_at", "时间冲突"); clear("end_at", "时间冲突"); }
  if (conflict && /展期|日期|结束日|起始日/.test(conflicts.join("\n"))) {
    for (const key of ["valid_from", "valid_to", "confirmed_start_date", "confirmed_end_date"]) clear(key, "日期冲突，保留原文待确认");
  }
  const schedule = value.schedule_json;
  const windows = [...(schedule?.weekly ?? []), ...(schedule?.dates ?? [])].flatMap((r: any) => r.windows ?? []);
  const usable = !!(value.start_at && value.end_at) || schedule?.mode === "always_open" || windows.length > 0 && windows.every((w: any) => w.start && w.end);
  const anyTime = !!(value.valid_from || value.valid_to || value.start_at || value.end_at || schedule && schedule.mode !== "unknown");
  // Activity windows without an effective date are not independently complete.
  value.time_status = conflict ? "conflicting" : value.time_status === "unknown" ? "unknown" : usable && !downgraded && value.time_status !== "partial" && (value.record_type === "attraction" || value.valid_from || value.start_at || schedule?.mode === "dates") ? "complete" : anyTime ? "partial" : "unknown";
  if ((value.time_status !== "complete" || downgraded) && !notes.length) notes.push(source.slice(0, 6000));
  value.time_note = notes.length ? [...new Set(notes)].join("\n").slice(0, 10000) : null;
}

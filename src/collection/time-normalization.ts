import { isCalendarDate } from "../itinerary/constraints.ts";

/** Store minute precision in Asia/Shanghai. Never invent a clock for a date-only value. */
export function normalizeActivityTime(value: string | null): string | null {
  if (value === null) return null;
  const match = /^(\d{4}-\d{2}-\d{2})[T ]((?:[01]\d|2[0-3]):[0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)?$/i.exec(value.trim());
  if (!match || !isCalendarDate(match[1])) return value;
  if (!match[4]) return `${match[1]}T${match[2]}`;
  const instant = Date.parse(`${match[1]}T${match[2]}:${match[3] ?? "00"}${match[4].toUpperCase()}`);
  if (!Number.isFinite(instant)) return value;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

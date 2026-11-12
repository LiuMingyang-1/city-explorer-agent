import { isCalendarDate } from "../itinerary/constraints.ts";
import type { SearchHit } from "./types.ts";
export function canonicalUrl(raw: string): string {
  const u = new URL(raw);
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) throw new Error("INVALID_URL");
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key)) u.searchParams.delete(key);
  return u.href;
}
export function validHit(value: unknown, platforms: string[]): value is SearchHit {
  if (!value || typeof value !== "object") return false;
  const h = value as SearchHit;
  const time = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(s) && isCalendarDate(s.slice(0,10)) && Number.isFinite(Date.parse(s));
  return platforms.includes(h.platform) && [h.url,h.title,h.snippet].every(s => typeof s === "string") && h.url.length <= 8192 && h.title.length <= 20000 && h.snippet.length <= 100000 && (h.author === null || typeof h.author === "string") && (h.platformContentId === null || typeof h.platformContentId === "string" && h.platformContentId.length > 0 && h.platformContentId.length < 1000) && (h.publishedAt === null || time(h.publishedAt)) && time(h.retrievedAt) && Number.isInteger(h.rank) && h.rank >= 1;
}
export const clip = (s: string, n: number) => [...s].slice(0,n).join("");

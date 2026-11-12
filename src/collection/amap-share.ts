import type { Coordinate } from "./coordinates.ts";

export interface AmapSharedVenue {
  poi_id: string; name: string; address: string; original: Coordinate; source_url: string;
}
export const isAmapShareUrl = (value: string) => /^https:\/\/surl\.amap\.com\/[A-Za-z0-9]{1,64}$/.test(value);

/** Read only the first official redirect. Do not fetch app scripts or retain tracking tokens. */
export async function readAmapSharedVenue(url: string, fetcher: typeof fetch = fetch): Promise<AmapSharedVenue | null> {
  if (!isAmapShareUrl(url)) return null;
  const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(8000) });
  const location = response.headers.get("location");
  await response.body?.cancel();
  if (![301, 302, 303, 307, 308].includes(response.status) || !location) return null;
  const target = new URL(location, url);
  if (target.protocol !== "https:" || !["wb.amap.com", "www.amap.com", "uri.amap.com"].includes(target.hostname)
    || target.username || target.password) return null;
  const fields = target.searchParams.get("p")?.split(",");
  if (!fields || fields.length < 5 || !/^B[A-Z0-9]{9,14}$/.test(fields[0])) return null;
  const lat = Number(fields[1]), lng = Number(fields[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 33 || lat > 35.5 || lng < 107 || lng > 110.5
    || !fields[3].trim() || !fields.slice(4).join(",").trim()) return null;
  return { poi_id: fields[0], name: fields[3], address: fields.slice(4).join(","), original: { lat, lng }, source_url: url };
}

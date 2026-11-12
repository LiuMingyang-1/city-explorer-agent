import type { GeoPoint, TravelMode } from "./types.ts";

/** mode 自动选择的缺省直线距离阈值（米）：≤ 用 walking，否则 transit。 */
export const DEFAULT_TRANSIT_THRESHOLD_M = 3000;

const EARTH_RADIUS_M = 6_371_000;

/** 两坐标点球面直线距离（米）；只用于 mode 选择，不是道路里程。 */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 契约 §7 的 mode 选择：直线距离 ≤ 阈值 walking，否则 transit。 */
export function pickTravelMode(
  distanceMeters: number,
  transitThresholdM: number = DEFAULT_TRANSIT_THRESHOLD_M,
): TravelMode {
  return distanceMeters <= transitThresholdM ? "walking" : "transit";
}

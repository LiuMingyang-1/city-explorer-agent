/** Adapted from googollee/eviltransform (Googol Lee et al., BSD-2-Clause).
 * Full notice: coordinates.LICENSE. This approximates the published transform;
 * numerical convergence is NOT a guarantee of a POI's physical accuracy.
 */
export interface Coordinate { lat: number; lng: number; }
export const CONVERSION_VERSION = "eviltransform-iterative-v1";
function valid(point: Coordinate): void {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) throw new Error("INVALID_COORDINATE");
}
function outside({ lat, lng }: Coordinate): boolean { return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271; }
function delta({ lat, lng }: Coordinate): Coordinate {
  const x = lng - 105, y = lat - 35, xy = x * y, absX = Math.sqrt(Math.abs(x)), xp = x * Math.PI, yp = y * Math.PI;
  const base = 20 * Math.sin(6 * xp) + 20 * Math.sin(2 * xp);
  let dlat = (base + 20 * Math.sin(yp) + 40 * Math.sin(yp / 3) + 160 * Math.sin(yp / 12) + 320 * Math.sin(yp / 30)) * 2 / 3;
  let dlng = (base + 20 * Math.sin(xp) + 40 * Math.sin(xp / 3) + 150 * Math.sin(xp / 12) + 300 * Math.sin(xp / 30)) * 2 / 3;
  dlat += -100 + 2 * x + 3 * y + .2 * y * y + .1 * xy + .2 * absX;
  dlng += 300 + x + 2 * y + .1 * x * x + .1 * xy + .1 * absX;
  const rad = lat / 180 * Math.PI, ee = .00669342162296594323;
  const magic = 1 - ee * Math.sin(rad) ** 2, sqrt = Math.sqrt(magic), earth = 6378137;
  return { lat: dlat * 180 / (earth * (1 - ee) / (magic * sqrt) * Math.PI), lng: dlng * 180 / (earth / sqrt * Math.cos(rad) * Math.PI) };
}
export function wgs84ToGcj02(point: Coordinate): Coordinate {
  valid(point); if (outside(point)) return { ...point };
  const d = delta(point); return { lat: point.lat + d.lat, lng: point.lng + d.lng };
}
export function gcj02ToWgs84(point: Coordinate): Coordinate {
  valid(point); if (outside(point)) return { ...point };
  let estimate = { ...point };
  for (let i = 0; i < 30; i++) {
    const d = delta(estimate), next = { lat: point.lat - d.lat, lng: point.lng - d.lng };
    if (Math.max(Math.abs(next.lat - estimate.lat), Math.abs(next.lng - estimate.lng)) < 1e-8) return next;
    estimate = next;
  }
  throw new Error("COORDINATE_CONVERSION_DID_NOT_CONVERGE");
}

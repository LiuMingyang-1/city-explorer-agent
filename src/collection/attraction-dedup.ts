/** GCJ-02 points are compared using ground distance, not a fixed number of
 * longitude degrees (whose physical length depends on latitude). */
export const DEFAULT_ATTRACTION_DUPLICATE_METERS = 10;
export interface AttractionPoint {
  id: string; record_type?: string; latitude: number | null; longitude: number | null;
  guide_url?: string | null; time_status?: string; status?: string;
  source_updated_at?: string | null; source_published_at?: string | null;
}
export interface AttractionDuplicate {
  removed_id: string; kept_id: string; distance_meters: number;
  source_urls: string[];
}
export function coordinateDistanceMeters(a: AttractionPoint, b: AttractionPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude! - a.latitude!) * rad, dLng = (b.longitude! - a.longitude!) * rad;
  const h = Math.sin(dLat/2)**2 + Math.cos(a.latitude!*rad)*Math.cos(b.latitude!*rad)*Math.sin(dLng/2)**2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0,h))));
}
function usable(p: AttractionPoint): boolean {
  return p.record_type === "attraction" && typeof p.latitude === "number" && typeof p.longitude === "number"
    && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180;
}
function completeness(p: AttractionPoint): number {
  const row = p as unknown as Record<string, unknown>;
  const fields = ["description","address","amap_poi_id","valid_from","valid_to","schedule_json","time_note","suggested_duration_minutes","budget_min","budget_max","budget_note","thumbnail_url"];
  const present = fields.filter(k => row[k] != null && row[k] !== "" && row[k] !== "null").length;
  return present + (p.time_status === "complete" ? 10 : p.time_status === "partial" ? 3 : 0)
    - (["paused","cancelled","ended"].includes(p.status ?? "") ? 100 : 0);
}
const publication = (p: AttractionPoint) => Date.parse(p.source_updated_at ?? p.source_published_at ?? "") || 0;

/** Keep one complete original record, never splice facts from different sources.
 * Compare against kept representatives only: an A-B-C proximity chain cannot
 * merge C into A when the actual distance A-C exceeds the threshold. */
export function deduplicateAttractions<T extends AttractionPoint>(rows: readonly T[], thresholdMeters = DEFAULT_ATTRACTION_DUPLICATE_METERS): {records:T[]; duplicates:AttractionDuplicate[]} {
  if (!Number.isFinite(thresholdMeters) || thresholdMeters < 0 || thresholdMeters > 100) throw new Error("INVALID_ATTRACTION_DUPLICATE_THRESHOLD");
  const ranked = rows.filter(usable).sort((a,b) => completeness(b)-completeness(a) || publication(b)-publication(a) || a.id.localeCompare(b.id));
  const kept:T[] = [], duplicates:AttractionDuplicate[] = [];
  for (const row of ranked) {
    const match = kept.map(p => ({p,distance:coordinateDistanceMeters(row,p)}))
      .filter(p => p.distance <= thresholdMeters).sort((a,b) => a.distance-b.distance || a.p.id.localeCompare(b.p.id))[0];
    if (match) duplicates.push({removed_id:row.id,kept_id:match.p.id,distance_meters:match.distance,source_urls:[...new Set([match.p.guide_url,row.guide_url].filter((s):s is string=>!!s))]});
    else kept.push(row);
  }
  const removed = new Set(duplicates.map(d=>d.removed_id));
  return {records:rows.filter(row=>!removed.has(row.id)),duplicates};
}

/** Final publication format. Incomplete extraction candidates are NOT this type. */
import type { Schedule } from "../data/schedule.ts";
import type { CollectionCategory } from "../data/categories.ts";
import { CATEGORIES } from "../data/categories.ts";
export { CATEGORIES } from "../data/categories.ts";
export interface RealEvent {
  id: string; title: string; description: string; category: CollectionCategory;
  record_type?: "activity" | "attraction"; city?: string; amap_poi_id?: string | null; valid_from?: string | null; valid_to?: string | null; schedule_json?: Schedule | null; status?: "active" | "paused" | "cancelled" | "ended" | "unknown"; source_published_at?: string | null; source_updated_at?: string | null; fetched_at?: string; updated_at?: string;
  time_note?: string | null; time_status?: "complete" | "partial" | "unknown" | "conflicting";
  venue_name: string; address: string; latitude: number; longitude: number;
  start_at: string | null; end_at: string | null; suggested_duration_minutes: number | null;
  budget_min: number | null; budget_max: number | null; currency: "CNY";
  budget_note: string | null; guide_url: string | null;
  thumbnail_url: string | null; image_urls: string[];
}
/** Not publishable until both coordinates are verified. */
export type CandidateEvent = Omit<RealEvent, "latitude" | "longitude"> & {
  latitude: number | null;
  longitude: number | null;
};
export interface FieldEvidence {
  field: "title" | "venue_name" | "address" | "start_at" | "end_at" | "budget_min" | "budget_max" | "suggested_duration_minutes";
  source_url: string; quote: string; document_sha256: string;
}
export interface EventProvenance {
  event_id: string; source_url: string; source_event_key: string; venue_key: string;
  schedule_type: "window" | "fixed" | "unknown"; source_kind: "publisher" | "ticketing" | "organizer_social" | "unverified";
  /** Immutable slot key registered at discovery; independent of corrected start time. */
  slot_key: string;
  verified_at: string; city: "西安市"; city_evidence: {source_url: string; quote: string};
  coordinates: {system: "GCJ-02"; source_url: string; method: "source" | "existing_verified" | "geocoding"; input_system: "WGS-84" | "GCJ-02" | "BD-09"; conversion: string | null};
  duration_basis: "source" | "estimated" | "unknown"; duration_note: string; evidence: FieldEvidence[];
}
export interface RealDataset {
  schema_version: "xian-events/4"; base_date: string; days: 14;
  events: RealEvent[]; provenance: EventProvenance[];
}
export interface ImageSupplement {
  source:"baidu_images";verified_at:string;poi_id:string|null;record_type:"attraction";
  images:{url:string;source_url:string;search_url:string;title:string;sha256:string}[];
}
export interface ValidationIssue { code: string; event_id?: string; field?: string; }
export interface ValidationReport { valid: boolean; issues: ValidationIssue[]; stats: {slots: number; projects: number; venues: number; categories: Record<string, number>; dates: Record<string, number>}; }

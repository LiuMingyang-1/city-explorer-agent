import type { Schedule } from "../data/schedule.ts";
import { isCalendarDate } from "../itinerary/constraints.ts";
import {isDefaultAttractionSchedule}from"./default-opening.ts";
export interface NightlyMetadata {
  timeStatus?: "complete" | "partial" | "unknown" | "conflicting";
  recordType?: "activity" | "attraction";
  firstSeenAt: string;
  lastVerifiedAt: string | null;
  sourcePublishedAt: string | null;
  confirmedEndDate: string | null;
  status: "active" | "unknown" | "cancelled";
  dateBasis?: "explicit" | "recent-publication-inference" | "unknown";
  sourceUpdatedAt?: string | null;
  availability?: "upcoming" | "within_period" | "permanent" | "unknown";
  confirmedStartDate?: string | null;
}
export interface FreshnessDecision { includeInDiscovery: boolean; allowPlanning: boolean; reason: string; }
/** Metadata is kept in a private sidecar, not additional events columns.
 * Fetch success alone must NOT change firstSeenAt or imply fact verification.
 */
export function assessFreshness(event: {start_at: string | null; end_at: string | null; record_type?: "activity" | "attraction"; schedule_json?: Schedule | null;time_note?:string|null;status?:string}, meta: NightlyMetadata, asOf: string): FreshnessDecision {
 const no=(reason:string):FreshnessDecision=>({includeInDiscovery:false,allowPlanning:false,reason});
 const now=Date.parse(asOf),first=Date.parse(meta.firstSeenAt),verified=meta.lastVerifiedAt===null?NaN:Date.parse(meta.lastVerifiedAt);
 if(!Number.isFinite(now)||!Number.isFinite(first)||first>now)return no("invalid_clock");
 if(meta.status==="cancelled")return no("cancelled");
 if(event.status&&["cancelled","ended"].includes(event.status))return no("unavailable_status");
 const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
 if(meta.confirmedEndDate!==null){if(!isCalendarDate(meta.confirmedEndDate))return no("invalid_end_date");if(meta.confirmedEndDate<today)return no("expired");}
 const time=(value:string|null)=>value===null?NaN:/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)&&isCalendarDate(value.slice(0,10))?Date.parse(value+":00+08:00"):NaN;
 const start=time(event.start_at),end=time(event.end_at);
 if(event.start_at!==null&&!Number.isFinite(start)||event.end_at!==null&&!Number.isFinite(end)||Number.isFinite(start)&&Number.isFinite(end)&&end<=start)return no("invalid_schedule");
 if(Number.isFinite(end)&&end<=now)return no("expired");
 if(!Number.isFinite(verified)||verified>now||now-verified>(meta.recordType === "attraction" ? 30*86400000 : 36*3600000))return no("verification_stale");
 if(meta.timeStatus===undefined&&meta.recordType!=="attraction"&&meta.confirmedEndDate===null&&event.end_at===null){
  if(now-first>7*86400000)return no("unknown_end_retention_expired");
  if(meta.sourcePublishedAt!==null){const published=Date.parse(meta.sourcePublishedAt);if(!Number.isFinite(published)||published>now)return no("invalid_publication_time");if(now-published>30*86400000)return no("old_source_without_end_date");}
 }
 if(event.status==="paused")return {includeInDiscovery:true,allowPlanning:false,reason:"unavailable_status"};
 if(meta.timeStatus && meta.timeStatus!=="complete"){
  if(meta.recordType==="attraction"&&meta.timeStatus==="partial"&&isDefaultAttractionSchedule(event.schedule_json))return {includeInDiscovery:true,allowPlanning:true,reason:"user_default_attraction_hours"};
  if(meta.recordType==="attraction"&&meta.timeStatus==="partial"&&event.time_note?.trim())return {includeInDiscovery:true,allowPlanning:true,reason:"user_accepted_time_note"};
  return {includeInDiscovery:true,allowPlanning:false,reason:"time_"+meta.timeStatus};
 }
 if(event.schedule_json && event.schedule_json.mode!=="unknown")return {includeInDiscovery:true,allowPlanning:true,reason:"verified_schedule_rules"};
 if(event.start_at===null||event.end_at===null)return {includeInDiscovery:true,allowPlanning:false,reason:"schedule_unknown"};
 return {includeInDiscovery:true,allowPlanning:true,reason:"verified_schedule"};
}

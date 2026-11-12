import {test} from "node:test";
import assert from "node:assert/strict";
import {assessFreshness} from "../src/collection/freshness.ts";
const now="2026-11-12T18:00:00Z"; // Shanghai 11-13 02:00
const meta={firstSeenAt:"2026-11-12T00:00:00Z",lastVerifiedAt:"2026-11-12T17:00:00Z",sourcePublishedAt:"2026-11-11T00:00:00Z",confirmedEndDate:null,status:"active" as const};
test("nightly freshness permits known coordinates with unknown schedules only for discovery",()=>{
 assert.deepEqual(assessFreshness({start_at:null,end_at:null},meta,now),{includeInDiscovery:true,allowPlanning:false,reason:"schedule_unknown"});
 assert.equal(assessFreshness({start_at:"2026-11-14T10:00",end_at:"2026-11-14T17:00"},meta,now).allowPlanning,true);
});
test("expiration is Shanghai-local and a fresh fetch does not revive expired activities",()=>{
 assert.equal(assessFreshness({start_at:null,end_at:null},{...meta,confirmedEndDate:"2026-11-12"},now).reason,"expired");
 assert.equal(assessFreshness({start_at:null,end_at:"2026-11-12T23:00"},meta,now).reason,"expired");
 assert.equal(assessFreshness({start_at:null,end_at:null},{...meta,status:"cancelled"},now).reason,"cancelled");
});
test("unknown dates cannot be renewed indefinitely by refetching unchanged content",()=>{
 assert.equal(assessFreshness({start_at:null,end_at:null},{...meta,firstSeenAt:"2026-11-01T00:00:00Z"},now).reason,"unknown_end_retention_expired");
 assert.equal(assessFreshness({start_at:null,end_at:null},{...meta,sourcePublishedAt:"2026-09-01T00:00:00Z"},now).reason,"old_source_without_end_date");
 assert.equal(assessFreshness({start_at:null,end_at:null},{...meta,lastVerifiedAt:"2026-11-01T00:00:00Z"},now).reason,"verification_stale");
});

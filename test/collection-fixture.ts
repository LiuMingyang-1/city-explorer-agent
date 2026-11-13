import { createHash } from "node:crypto";
import { eventId } from "../src/collection/identity.ts";
import type { RealDataset, EventProvenance, FieldEvidence } from "../src/collection/types.ts";
/** Entirely synthetic test fixture; never exported into datasets/. */
export function collectionFixture() {
 const source="https://www.sxhm.com/collection-contract-fixture";
 const text="西安市雁塔区。名称：秋日文化展。场馆：文化展厅。地址：西安市雁塔区文化路1号。日期：2026-11-14，开放10:00至17:00，固定演出10:00至11:30，时长90分钟。票价20元。";
 const digest=createHash("sha256").update(text).digest("hex");
 const id=eventId("publisher:edition-2026-11","venue:branch-a","2026-11-14T10:00");
 const evidence:FieldEvidence[]=["title","venue_name","address","start_at","end_at","suggested_duration_minutes"].map(field=>({field:field as FieldEvidence["field"],source_url:source,quote:text,document_sha256:digest}));
 const p:EventProvenance={event_id:id,source_url:source,source_event_key:"publisher:edition-2026-11",venue_key:"venue:branch-a",slot_key:"2026-11-14T10:00",schedule_type:"window",source_kind:"publisher",verified_at:"2026-11-12T01:00:00Z",city:"西安市",city_evidence:{source_url:source,quote:"西安市雁塔区"},coordinates:{system:"GCJ-02",source_url:source,method:"source",input_system:"GCJ-02",conversion:null},duration_basis:"source",duration_note:"来源明确90分钟",evidence};
 const dataset:RealDataset={schema_version:"xian-events/4",base_date:"2026-11-12",days:14,events:[{id,title:"秋日文化展",description:"文化主题展览",category:"展览",venue_name:"文化展厅",address:"西安市雁塔区文化路1号",latitude:34.23,longitude:108.95,start_at:"2026-11-14T10:00",end_at:"2026-11-14T17:00",suggested_duration_minutes:90,budget_min:null,budget_max:null,currency:"CNY",budget_note:null,guide_url:null,thumbnail_url:null,image_urls:[]}],provenance:[p]};
 return {dataset,options:{asOf:"2026-11-12T02:00:00Z",documents:new Map([[digest,{url:source,text}]])}};
}

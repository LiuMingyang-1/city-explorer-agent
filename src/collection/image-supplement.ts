import{publicUrl}from"./validate.ts";import type{ImageSupplement}from"./types.ts";
import type{SupplementPlan}from"./amap-supplement.ts";
export function planImageSupplement(baseline:{sha256:string;rows:Record<string,any>[]},selections:{id:string;images:ImageSupplement["images"]}[],asOf:string):SupplementPlan{
  if(!Number.isFinite(Date.parse(asOf))||new Set(selections.map(s=>s.id)).size!==selections.length)throw Error("INVALID_IMAGE_SELECTIONS");
  const plan:SupplementPlan={expected_sha256:baseline.sha256,asOf,updates:[],reviews:[]};
  for(const selected of selections){
    const before=baseline.rows.find(r=>r.id===selected.id);
    if(!before||before.record_type!=="attraction"||JSON.parse(before.image_urls).length)throw Error("IMAGE_TARGET_NOT_EMPTY_ATTRACTION");
    const images=selected.images;
    if(images.length<1||images.length>6||new Set(images.map(i=>i.sha256)).size!==images.length||images.some(i=>!publicUrl(i.url)||!publicUrl(i.source_url)||!publicUrl(i.search_url)||!i.title||!/^[a-f0-9]{64}$/.test(i.sha256)||/aigc/i.test(new URL(i.url).hostname)))throw Error("INVALID_CURATED_IMAGES");
    const image_supplement:ImageSupplement={source:"baidu_images",verified_at:asOf,poi_id:before.amap_poi_id,record_type:"attraction",images:structuredClone(images)};
    plan.updates.push({before,after:{...before,image_urls:JSON.stringify(images.map(i=>i.url)),thumbnail_url:images[0].url,updated_at:asOf},image_supplement});
  }
  return plan;
}

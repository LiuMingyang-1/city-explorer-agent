import{test}from"node:test";import assert from"node:assert/strict";import{mkdirSync,rmSync,readFileSync}from"node:fs";import{randomUUID,createHash}from"node:crypto";import{DatabaseSync}from"node:sqlite";
import{planImageSupplement}from"../src/collection/image-supplement.ts";import{applyAmapSupplement}from"../src/collection/amap-supplement.ts";
import{locatedFixture}from"./collection-downstream-fixture.ts";import{prepareCollection}from"../src/collection/preparation.ts";import{initializeCollectionDatabase,writeCollectionDatabase,inspectCollectionDatabase}from"../src/collection/database.ts";
const pic={url:"https://bkimg.cdn.bcebos.com/pic/museum",source_url:"https://baike.baidu.com/item/museum",search_url:"https://image.baidu.com/search/index?word=museum",title:"场馆实景",sha256:"a".repeat(64)};
test("curated images survive later empty posts for the same POI, with source URL and other fields unchanged",async()=>{
 const root=`.local-data/curated-image-test-${randomUUID()}`,path=root+"/events.db";mkdirSync(root,{recursive:true});
 try{
  const{item,asOf}=await locatedFixture();item.facts.record_type="attraction";item.facts.category="暂无评级";
  const prepared=prepareCollection([item],{asOf,baseDate:"2026-11-12"}).prepared;await initializeCollectionDatabase(path);writeCollectionDatabase(path,prepared,{batchId:"seed",asOf});
  const db=new DatabaseSync(path,{readOnly:true}),rows=db.prepare("SELECT * FROM events").all();db.close();
  const sha256=createHash("sha256").update(readFileSync(path)).digest("hex"),plan=planImageSupplement({sha256,rows},[{id:String(rows[0].id),images:[pic]}],asOf);
  applyAmapSupplement(path,plan,{batchId:"photos"});writeCollectionDatabase(path,prepared,{batchId:"weak-post",asOf});
  const check=new DatabaseSync(path,{readOnly:true});try{const r=check.prepare("SELECT * FROM events").get()!;assert.deepEqual(JSON.parse(String(r.image_urls)),[pic.url]);assert.equal(r.guide_url,item.document.url);assert.equal(r.latitude,rows[0].latitude);assert.equal(r.thumbnail_url,pic.url);assert(inspectCollectionDatabase(path).sidecar.events[String(r.id)].image_supplement);}finally{check.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("curation rejects existing photos, private URLs, AI images and repeated image bytes",()=>{
 const base={sha256:"x",rows:[{id:"a",record_type:"attraction",image_urls:"[]",amap_poi_id:"p"}]};
 for(const images of [[{...pic,url:"https://127.0.0.1/private"}],[{...pic,url:"https://aigc-image.bj.bcebos.com/ai.png"}],[pic,pic]])assert.throws(()=>planImageSupplement(base,[{id:"a",images}],"2026-11-13T01:00:00Z"));
 assert.throws(()=>planImageSupplement({...base,rows:[{...base.rows[0],image_urls:'["existing"]'}]},[{id:"a",images:[pic]}],"2026-11-13T01:00:00Z"));
});

import{test}from"node:test";import assert from"node:assert/strict";import{DatabaseSync}from"node:sqlite";
import{ensureEventsSchema,EVENTS_TABLE_DDL}from"../src/data/schema.ts";
import{DEFAULT_SCENIC_LEVEL,normalizeScenicLevel}from"../src/data/categories.ts";
import{extractActivities}from"../src/collection/extraction.ts";
import{extractionFixture}from"./collection-downstream-fixture.ts";
test("attraction SQL default is 暂无评级 while activities still require explicit category",()=>{
  const db=new DatabaseSync(":memory:");try{
    ensureEventsSchema(db);db.exec("INSERT INTO events(id,title,description,venue_name,address,record_type) VALUES('a','公园','介绍','公园','西安市','attraction')");
    assert.equal(db.prepare("SELECT category FROM events WHERE id='a'").get()!.category,DEFAULT_SCENIC_LEVEL);
    assert.throws(()=>db.exec("INSERT INTO events(id,title,description,venue_name,address,record_type) VALUES('b','活动','介绍','场馆','西安市','activity')"));
    ensureEventsSchema(db);assert.equal(db.prepare("SELECT count(*) n FROM events").get()!.n,1);
  }finally{db.close();}
});
test("v4 migration renames legacy fallback atomically and preserves grades, custom columns and indexes",()=>{
  const db=new DatabaseSync(":memory:");try{
    db.exec(EVENTS_TABLE_DDL.replace("category TEXT NOT NULL DEFAULT '暂无评级'","category TEXT NOT NULL").replaceAll("暂无评级","等级未知"));
    db.exec("ALTER TABLE events ADD COLUMN custom_note TEXT; CREATE INDEX idx_test_venue ON events(venue_name); INSERT INTO events(id,title,description,category,venue_name,address,record_type,custom_note) VALUES('a','公园','介绍','等级未知','公园','西安市','attraction','保留'),('b','景区','介绍','5A','景区','西安市','attraction','已评级'),('c','演出','介绍','演出','剧院','西安市','activity','活动')");
    ensureEventsSchema(db);assert.deepEqual(db.prepare("SELECT category FROM events ORDER BY id").all().map(r=>r.category),["暂无评级","5A","演出"]);
    assert.equal(db.prepare("SELECT custom_note FROM events WHERE id='a'").get()!.custom_note,"保留");assert(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_test_venue'").get());
    const schema=db.prepare("SELECT sql FROM sqlite_master WHERE name='events'").get()!.sql;ensureEventsSchema(db);assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='events'").get()!.sql,schema);
    assert.throws(()=>db.exec("UPDATE events SET category='等级未知' WHERE id='a'"));
  }finally{db.close();}
});
test("unsupported legacy values stop schema migration without changing rows",()=>{
  const db=new DatabaseSync(":memory:");try{db.exec("CREATE TABLE events(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,venue_name TEXT NOT NULL,address TEXT NOT NULL,latitude REAL,longitude REAL,start_at TEXT,end_at TEXT,suggested_duration_minutes INTEGER,record_type TEXT); INSERT INTO events VALUES('a','景点','简介','五星级','场馆','西安市',NULL,NULL,NULL,NULL,NULL,'attraction')");
    const before=JSON.stringify(db.prepare("SELECT * FROM events").all());assert.throws(()=>ensureEventsSchema(db),/UNSUPPORTED_EXISTING_CATEGORY/);assert.equal(JSON.stringify(db.prepare("SELECT * FROM events").all()),before);
  }finally{db.close();}
});
test("missing and legacy attraction grades normalize to default without relaxing activity validation",async()=>{
  const {facts,document,asOf}=extractionFixture();
  for(const category of [undefined,null,"","等级未知"]){
    const row={...facts,record_type:"attraction",category};const result=await extractActivities(document,{asOf,structured:{activities:[row]}});
    assert.equal(result.activities[0]?.facts.category,"暂无评级");assert.equal(row.category,category);
  }
  assert.equal(normalizeScenicLevel("4A"),"4A");
  const activity=await extractActivities(document,{asOf,structured:{activities:[{...facts,category:null}]}});assert.equal(activity.activities.length,0);
});

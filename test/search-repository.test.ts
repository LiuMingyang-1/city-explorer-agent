import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSearchRepository } from "../src/search/sqlite.ts";
import { normalizeRequest } from "../src/search/contract.ts";
import { ensureSearchSchema } from "../src/search/schema.ts";
import type { CollectedHit, SearchResponse } from "../src/search/types.ts";
const at=Date.parse("2026-11-12T00:00:00Z"), until=at+10000;
const hit: CollectedHit={channel:"fake",query:"q",priority:0,hit:{platform:"web",platformContentId:null,url:"https://example.com/a",title:"t",snippet:"s",author:null,publishedAt:null,retrievedAt:new Date(at).toISOString(),rank:1}};
const req=normalizeRequest({mode:"external"});
const snapshot=()=>({response:{search_id:"r",results:[],coverage:[],status:"success"} as unknown as SearchResponse,pageEnds:[]});
test("schema is repeatable; foreign keys and existing application rows preserved",()=>{
 const db=new DatabaseSync(":memory:"); db.exec("CREATE TABLE events(id TEXT PRIMARY KEY,guide_url TEXT); INSERT INTO events VALUES('old','guide'); PRAGMA user_version=42");
 ensureSearchSchema(db); ensureSearchSchema(db);
 assert.equal(db.prepare("SELECT guide_url FROM events").get()!.guide_url,"guide");
 assert.equal(db.prepare("PRAGMA user_version").get()!.user_version,42);
 assert.throws(()=>db.exec("INSERT INTO search_run_results VALUES('x','missing','missing',NULL,'c','q',1,'s',1)"));
 assert.throws(()=>db.exec("INSERT INTO search_runs(id,scope_key,request_json,request_key,mode,status,expires_at,started_at) VALUES('x','s','bad','k','external','success','x','x')"));
 db.close();
});
test("atomic publication rollback, stable document IDs, cursors survive reopen and enforce scope",t=>{
 const dir=mkdtempSync(join(tmpdir(),"search-repo-")); t.after(()=>rmSync(dir,{recursive:true,force:true})); const path=join(dir,"db.sqlite");
 let repo=createSearchRepository(path,{now:()=>at});
 repo.beginRun("rollback","scope",req,"key",at,until);
 assert.throws(()=>repo.completeRun("rollback",[hit],at,until,()=>{throw new Error("injected");}));
 const db=new DatabaseSync(path); assert.equal(db.prepare("SELECT count(*) n FROM search_documents").get()!.n,0); db.close();
 let first="";
 for(const run of ["r","r2"]) {repo.beginRun(run,"scope",req,"key",at,until); repo.completeRun(run,[hit,hit],at,until,(stored)=>{if(!first)first=stored[0].documentId;assert.equal(stored[0].documentId,first);return snapshot();});}
 const cursor=repo.issueCursor("r","scope",1,at,until); repo.close(); repo=createSearchRepository(path,{now:()=>at});
 assert.equal(repo.resolveCursor(cursor,"scope","key",at,until).offset,1);
 for(const [scope,key,time] of [["other","key",at],["scope","other",at],["scope","key",at+1800001]] as const) assert.throws(()=>repo.resolveCursor(cursor,scope,key,time,until));
 assert.throws(()=>repo.resolveCursor(cursor+"x","scope","key",at,until));
 repo.cleanup(at+40*86400000); repo.close();
 const check=new DatabaseSync(path); assert.equal(check.prepare("SELECT count(*) n FROM search_documents").get()!.n,0); check.close();
});
test("identity collisions are rejected without deleting referenced documents",()=>{
 const repo=createSearchRepository(":memory:",{now:()=>at});
 repo.beginRun("r","s",req,"k",at,until);
 repo.completeRun("r",[hit,{...hit,hit:{...hit.hit,url:"https://example.com/b",platformContentId:"b"}}],at,until,()=>snapshot());
 repo.beginRun("r2","s",req,"k",at,until);
 repo.completeRun("r2",[{...hit,hit:{...hit.hit,platformContentId:"b"}}],at,until,(rows,conflicts)=>{assert.equal(rows.length,0);assert.equal(conflicts,1);return snapshot();}); repo.close();
});

test("lock contention obeys short remaining budget and leaves no run",t=>{
 const dir=mkdtempSync(join(tmpdir(),"search-lock-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,"db.sqlite");
 const repo=createSearchRepository(path),lock=new DatabaseSync(path);
 try {lock.exec("BEGIN IMMEDIATE");assert.throws(()=>repo.beginRun("blocked","s",req,"k",Date.now(),Date.now()+20),/locked/);lock.exec("ROLLBACK");assert.equal(lock.prepare("SELECT count(*) n FROM search_runs").get()!.n,0);}
 finally {lock.close();repo.close();}
});
test("document refresh preserves first-seen time and successful body",()=>{
 const dir=mkdtempSync(join(tmpdir(),"search-refresh-")),path=join(dir,"db.sqlite");const repo=createSearchRepository(path,{now:()=>at});
 try {
  repo.beginRun("one","s",req,"k",at,until);repo.completeRun("one",[hit],at,until,()=>snapshot());
  const db=new DatabaseSync(path);db.exec("UPDATE search_documents SET content_text='retained body',fetch_status='full',content_hash='saved-hash'");db.close();
  repo.beginRun("two","s",req,"k",at+1,until);repo.completeRun("two",[hit],at+1,until,()=>snapshot());
  const read=new DatabaseSync(path);const row=read.prepare("SELECT * FROM search_documents").get()!;assert.equal(row.first_seen_at,new Date(at).toISOString());assert.equal(row.content_text,"retained body");assert.equal(row.fetch_status,"full");read.close();
 } finally {repo.close();rmSync(dir,{recursive:true,force:true});}
});

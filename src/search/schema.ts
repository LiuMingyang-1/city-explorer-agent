import type { DatabaseSync } from "node:sqlite";
export const SEARCH_DDL = `PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS search_runs (
 id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, cursor_state_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(cursor_state_json)), request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 request_key TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('local','external','hybrid')),
 status TEXT NOT NULL CHECK(status IN ('running','success','partial','failed','cancelled')),
 channel_results_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(channel_results_json)),
 response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
 cache_until TEXT, snapshot_until TEXT, expires_at TEXT NOT NULL,
 started_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS search_runs_cache ON search_runs(request_key,cache_until);
CREATE INDEX IF NOT EXISTS search_runs_expiry ON search_runs(expires_at);
CREATE TABLE IF NOT EXISTS search_documents (
 id TEXT PRIMARY KEY, platform TEXT NOT NULL, platform_content_id TEXT,
 canonical_url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, author TEXT, snippet TEXT NOT NULL,
 content_text TEXT, raw_content_path TEXT, published_at TEXT, source_updated_at TEXT,
 first_seen_at TEXT NOT NULL, last_fetched_at TEXT NOT NULL, content_hash TEXT,
 fetch_status TEXT NOT NULL CHECK(fetch_status IN ('snippet_only','full','unavailable','deleted','parse_failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS search_documents_identity ON search_documents(platform,platform_content_id)
 WHERE platform_content_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS search_documents_fetch ON search_documents(platform,last_fetched_at);
CREATE TABLE IF NOT EXISTS search_run_results (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES search_runs(id) ON DELETE CASCADE,
 document_id TEXT NOT NULL REFERENCES search_documents(id) ON DELETE RESTRICT,
 document_hash TEXT, channel TEXT NOT NULL, matched_query TEXT NOT NULL,
 channel_rank INTEGER NOT NULL CHECK(channel_rank>=1), snippet TEXT NOT NULL,
 final_rank INTEGER CHECK(final_rank IS NULL OR final_rank>=1),
 UNIQUE(run_id,document_id,channel,matched_query)
);
CREATE INDEX IF NOT EXISTS search_results_order ON search_run_results(run_id,final_rank);
`;
export function ensureSearchSchema(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SEARCH_DDL);
    const columns = new Set((db.prepare("PRAGMA table_info(search_runs)").all() as {name: string}[]).map(c=>c.name));
    // Only our previous draft schema is upgraded here; existing application tables are untouched.
    if (!columns.has("scope_key")) db.exec("ALTER TABLE search_runs ADD COLUMN scope_key TEXT NOT NULL DEFAULT ''");
    if (!columns.has("cursor_state_json")) db.exec("ALTER TABLE search_runs ADD COLUMN cursor_state_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(cursor_state_json))");
    db.exec("COMMIT");
  } catch(e) { db.exec("ROLLBACK"); throw e; }
}

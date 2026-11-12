-- Design draft only. Never run against a production database as a migration.
-- The verifier supplies the existing events schema in an in-memory database.
PRAGMA foreign_keys = ON;
CREATE TABLE search_runs (
 id TEXT PRIMARY KEY, request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 request_key TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('local','external','hybrid')),
 status TEXT NOT NULL CHECK(status IN ('running','success','partial','failed','cancelled')),
 channel_results_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(channel_results_json)),
 response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
 cache_until TEXT, snapshot_until TEXT, expires_at TEXT NOT NULL,
 started_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX search_runs_cache ON search_runs(request_key,cache_until);
CREATE INDEX search_runs_expiry ON search_runs(expires_at);
CREATE TABLE search_documents (
 id TEXT PRIMARY KEY, platform TEXT NOT NULL, platform_content_id TEXT,
 canonical_url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, author TEXT, snippet TEXT NOT NULL,
 content_text TEXT, raw_content_path TEXT, published_at TEXT, source_updated_at TEXT,
 first_seen_at TEXT NOT NULL, last_fetched_at TEXT NOT NULL, content_hash TEXT,
 fetch_status TEXT NOT NULL CHECK(fetch_status IN ('snippet_only','full','unavailable','deleted','parse_failed'))
);
CREATE UNIQUE INDEX search_documents_identity ON search_documents(platform,platform_content_id)
 WHERE platform_content_id IS NOT NULL;
CREATE INDEX search_documents_fetch ON search_documents(platform,last_fetched_at);
CREATE TABLE search_run_results (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES search_runs(id) ON DELETE CASCADE,
 document_id TEXT NOT NULL REFERENCES search_documents(id) ON DELETE RESTRICT,
 document_hash TEXT, channel TEXT NOT NULL, matched_query TEXT NOT NULL,
 channel_rank INTEGER NOT NULL CHECK(channel_rank>=1), snippet TEXT NOT NULL,
 final_rank INTEGER CHECK(final_rank IS NULL OR final_rank>=1),
 UNIQUE(run_id,document_id,channel,matched_query)
);
CREATE INDEX search_results_order ON search_run_results(run_id,final_rank);
CREATE TABLE venues (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(aliases_json)),
 city TEXT NOT NULL, district TEXT, address TEXT, latitude REAL, longitude REAL,
 coordinate_metadata_json TEXT CHECK(coordinate_metadata_json IS NULL OR json_valid(coordinate_metadata_json)),
 opening_rules_json TEXT CHECK(opening_rules_json IS NULL OR json_valid(opening_rules_json)),
 status TEXT NOT NULL CHECK(status IN ('active','unavailable')), updated_at TEXT NOT NULL,
 CHECK((latitude IS NULL AND longitude IS NULL) OR
       (latitude IS NOT NULL AND longitude IS NOT NULL AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180))
);
CREATE INDEX venues_match ON venues(city,name);
CREATE TABLE activities (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('temporary','permanent_visit')),
 venue_id TEXT REFERENCES venues(id) ON DELETE RESTRICT,
 schedule_type TEXT NOT NULL CHECK(schedule_type IN ('window','fixed','unknown')),
 date_start TEXT, date_end TEXT, schedule_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(schedule_json)),
 metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)), source_url TEXT,
 status TEXT NOT NULL CHECK(status IN ('active','postponed','cancelled','ended','unknown')),
 publication_state TEXT NOT NULL CHECK(publication_state IN ('incomplete','plannable','suspended')),
 last_checked_at TEXT, CHECK(date_start IS NULL OR date_end IS NULL OR date_start<=date_end)
);
-- metadata_json: typed budget, booking and media fields; validated by application schema.
CREATE INDEX activities_lookup ON activities(venue_id,status,publication_state);
CREATE TABLE activity_evidence (
 id TEXT PRIMARY KEY, activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
 document_id TEXT NOT NULL REFERENCES search_documents(id) ON DELETE RESTRICT,
 document_hash TEXT NOT NULL, field_name TEXT NOT NULL,
 extracted_value_json TEXT NOT NULL CHECK(json_valid(extracted_value_json)), evidence_text TEXT NOT NULL,
 extractor_version TEXT NOT NULL, extracted_at TEXT NOT NULL,
 resolution_status TEXT NOT NULL CHECK(resolution_status IN ('adopted','conflicting','superseded','rejected'))
);
CREATE INDEX evidence_lookup ON activity_evidence(activity_id,field_name);
-- Stage 5: real migration checks PRAGMA table_info before ADD COLUMN, within one transaction.
ALTER TABLE events ADD COLUMN source_url TEXT;
ALTER TABLE events ADD COLUMN activity_id TEXT REFERENCES activities(id) ON DELETE RESTRICT;
ALTER TABLE events ADD COLUMN venue_id TEXT REFERENCES venues(id) ON DELETE RESTRICT;
ALTER TABLE events ADD COLUMN schedule_type TEXT NOT NULL DEFAULT 'window' CHECK(schedule_type IN ('window','fixed'));
ALTER TABLE events ADD COLUMN status TEXT NOT NULL DEFAULT 'legacy' CHECK(status IN ('active','cancelled','expired','suspended','legacy'));
ALTER TABLE events ADD COLUMN last_verified_at TEXT;
ALTER TABLE events ADD COLUMN fresh_until TEXT;
CREATE INDEX events_activity ON events(activity_id);
CREATE INDEX events_publish ON events(status,fresh_until,start_at);
-- guide_url is deliberately retained; no automatic source_url backfill.

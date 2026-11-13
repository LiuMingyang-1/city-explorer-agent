-- Generated from src/data/schema.ts; do not run against an existing database.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  venue_name TEXT NOT NULL,
  address TEXT NOT NULL,
  latitude REAL DEFAULT NULL,
  longitude REAL DEFAULT NULL,
  start_at TEXT DEFAULT NULL,
  end_at TEXT DEFAULT NULL,
  suggested_duration_minutes INTEGER DEFAULT NULL,
  budget_min INTEGER CHECK (budget_min IS NULL OR (typeof(budget_min) = 'integer' AND budget_min >= 0)),
  budget_max INTEGER CHECK (budget_max IS NULL OR (typeof(budget_max) = 'integer' AND budget_max >= 0)) CHECK (budget_min IS NULL OR budget_max IS NULL OR budget_min <= budget_max),
  currency TEXT NOT NULL DEFAULT 'CNY',
  budget_note TEXT,
  guide_url TEXT,
  thumbnail_url TEXT,
  image_urls TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(image_urls) AND json_type(image_urls) = 'array'),
  CONSTRAINT events_collection_v3 CHECK (
  id IS NOT NULL AND length(trim(id, char(9)||char(10)||char(13)||' ')) > 0 AND title IS NOT NULL AND length(trim(title, char(9)||char(10)||char(13)||' ')) > 0 AND description IS NOT NULL AND length(trim(description, char(9)||char(10)||char(13)||' ')) > 0 AND category IS NOT NULL AND length(trim(category, char(9)||char(10)||char(13)||' ')) > 0 AND venue_name IS NOT NULL AND length(trim(venue_name, char(9)||char(10)||char(13)||' ')) > 0 AND address IS NOT NULL AND length(trim(address, char(9)||char(10)||char(13)||' ')) > 0
  AND category IN ('展览','音乐现场','演出','市集','节庆活动','书店活动','讲座','工作坊','放映','景点参观','户外活动','体育赛事')
  AND ((latitude IS NULL AND longitude IS NULL) OR (
    latitude IS NOT NULL AND longitude IS NOT NULL
    AND typeof(latitude) IN ('real','integer') AND latitude BETWEEN -90 AND 90
    AND typeof(longitude) IN ('real','integer') AND longitude BETWEEN -180 AND 180))
  AND (suggested_duration_minutes IS NULL OR
    (typeof(suggested_duration_minutes)='integer' AND suggested_duration_minutes BETWEEN 1 AND 1440))
)
);
CREATE INDEX events_date ON events(start_at,end_at);
CREATE INDEX events_category ON events(category,start_at);

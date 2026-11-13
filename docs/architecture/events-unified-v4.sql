-- Unified events v4; GCJ-02. Two legacy time columns retained temporarily.
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '暂无评级',
  venue_name TEXT NOT NULL,
  address TEXT NOT NULL,
  latitude REAL DEFAULT NULL,
  longitude REAL DEFAULT NULL,
  start_at TEXT DEFAULT NULL,
  end_at TEXT DEFAULT NULL,
  suggested_duration_minutes INTEGER DEFAULT NULL,
  record_type TEXT NOT NULL DEFAULT 'activity' CHECK(record_type IN ('activity','attraction')),
  city TEXT NOT NULL DEFAULT '西安市',
  amap_poi_id TEXT DEFAULT NULL,
  valid_from TEXT DEFAULT NULL,
  valid_to TEXT DEFAULT NULL,
  time_note TEXT DEFAULT NULL,
  time_status TEXT NOT NULL DEFAULT 'unknown' CHECK(time_status IN ('complete','partial','unknown','conflicting')),
  schedule_json TEXT DEFAULT NULL CHECK(schedule_json IS NULL OR json_valid(schedule_json)),
  status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('active','paused','cancelled','ended','unknown')),
  source_published_at TEXT DEFAULT NULL,
  source_updated_at TEXT DEFAULT NULL,
  fetched_at TEXT DEFAULT NULL,
  updated_at TEXT DEFAULT NULL,
  budget_min INTEGER CHECK (budget_min IS NULL OR (typeof(budget_min) = 'integer' AND budget_min >= 0)),
  budget_max INTEGER CHECK (budget_max IS NULL OR (typeof(budget_max) = 'integer' AND budget_max >= 0)) CHECK (budget_min IS NULL OR budget_max IS NULL OR budget_min <= budget_max),
  currency TEXT NOT NULL DEFAULT 'CNY',
  budget_note TEXT,
  guide_url TEXT,
  thumbnail_url TEXT,
  image_urls TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(image_urls) AND json_type(image_urls) = 'array'),
  CONSTRAINT events_collection_v4 CHECK (
  id IS NOT NULL AND length(trim(id, char(9)||char(10)||char(13)||' ')) > 0 AND title IS NOT NULL AND length(trim(title, char(9)||char(10)||char(13)||' ')) > 0 AND description IS NOT NULL AND length(trim(description, char(9)||char(10)||char(13)||' ')) > 0 AND category IS NOT NULL AND length(trim(category, char(9)||char(10)||char(13)||' ')) > 0 AND venue_name IS NOT NULL AND length(trim(venue_name, char(9)||char(10)||char(13)||' ')) > 0 AND address IS NOT NULL AND length(trim(address, char(9)||char(10)||char(13)||' ')) > 0
  AND ((record_type='activity' AND category IN ('展览','音乐现场','演出','市集','节庆活动','书店活动','讲座','工作坊','放映','景点参观','户外活动','体育赛事')) OR (record_type='attraction' AND category IN ('1A','2A','3A','4A','5A','暂无评级')))
  AND ((latitude IS NULL AND longitude IS NULL) OR (
    latitude IS NOT NULL AND longitude IS NOT NULL
    AND typeof(latitude) IN ('real','integer') AND latitude BETWEEN -90 AND 90
    AND typeof(longitude) IN ('real','integer') AND longitude BETWEEN -180 AND 180))
  AND (suggested_duration_minutes IS NULL OR
    (typeof(suggested_duration_minutes)='integer' AND suggested_duration_minutes BETWEEN 1 AND 1440))
)
);

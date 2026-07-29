-- D1 Database Schema for Item Location Scanner
-- Deploy: wrangler d1 execute item-scans --file=schema.sql

CREATE TABLE IF NOT EXISTS scans (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  item_name   TEXT NOT NULL,
  confidence  TEXT NOT NULL DEFAULT 'low',
  distinct_features TEXT,       -- JSON array
  suggested_category TEXT,
  description TEXT,
  room_name   TEXT DEFAULT 'Unknown',
  location    TEXT DEFAULT 'Scanned',
  image_b64   TEXT NOT NULL,    -- base64 JPEG
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scans_user ON scans(user_id);
CREATE INDEX IF NOT EXISTS idx_scans_item ON scans(item_name);
CREATE INDEX IF NOT EXISTS idx_scans_created ON scans(created_at);

-- R2 Photo Library
CREATE TABLE IF NOT EXISTS photos (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  item_name   TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'Other',
  room_location TEXT DEFAULT 'Scanned',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_photos_user ON photos(user_id);
CREATE INDEX IF NOT EXISTS idx_photos_category ON photos(category);

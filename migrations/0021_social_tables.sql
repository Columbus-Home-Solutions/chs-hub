-- 0021_social_tables.sql
-- Sprint 1 — Social module tables: social_posts, content_schedules.

CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY,
  post_type TEXT NOT NULL CHECK(post_type IN ('job_completion','seasonal_tips','tips_tricks','promotion','review_highlight','manual')),
  status TEXT NOT NULL CHECK(status IN ('draft','pending_approval','approved','scheduled','published','rejected','failed')),
  caption TEXT NOT NULL,
  hashtags TEXT,
  platform TEXT NOT NULL CHECK(platform IN ('both','facebook_only','instagram_only')),
  scheduled_date TEXT,
  published_date TEXT,
  job_id TEXT REFERENCES jobs(id),
  photo_ids TEXT,
  ai_generated_image_url TEXT,
  facebook_post_id TEXT,
  instagram_post_id TEXT,
  facebook_url TEXT,
  instagram_url TEXT,
  engagement_data TEXT,
  rejection_reason TEXT,
  generated_by TEXT NOT NULL,
  approved_by TEXT,
  approved_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_schedules (
  id TEXT PRIMARY KEY,
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','active','completed')),
  generated_date TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Photos captured via the PWA capture flow (and, eventually, backfilled
-- from the legacy Drive migration). One row per uploaded photo. The
-- bytes themselves live in R2 under the keys recorded here.
--
-- Migration 0006 — Phase 7B: PWA capture v1.
--
-- Two R2 objects per photo:
--   r2_key         → original (full resolution, ~2-5 MB JPEG)
--   thumb_key      → ~800px-wide JPEG generated client-side before upload
--
-- job_id is nullable: a NULL value means "general" (office supplies,
-- a marketing-only photo, a photo taken before the crew tagged a job,
-- etc.). The dashboard photo viewer surfaces these in a separate
-- "general" bucket alongside the per-job lists.
--
-- Bucket layout in R2 (mirrored, not enforced by this schema):
--   photos/{job_id|"general"}/{YYYY-MM-DD}/{uuid}.jpg
--   photos-thumbs/{job_id|"general"}/{YYYY-MM-DD}/{uuid}.jpg

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,                  -- ISO ts when the row was inserted (server clock)
  taken_at TEXT,                             -- ISO ts when the photo was captured (client-supplied, may lag if it was offline-queued)
  job_id TEXT,                               -- FK to jobs.id; NULL = general/unattached
  category TEXT NOT NULL DEFAULT 'progress', -- before | progress | final | issue | marketing | safety | incident
  r2_key TEXT NOT NULL,
  thumb_key TEXT NOT NULL,
  uploaded_by TEXT,                          -- email from Cf-Access-Authenticated-User-Email
  gps_lat REAL,
  gps_lng REAL,
  tags TEXT,                                 -- JSON-encoded string[] of free-form labels
  caption TEXT,                              -- optional crew-supplied caption
  before_after_pair_id TEXT                  -- FK to another photos.id when explicitly paired
);

CREATE INDEX IF NOT EXISTS idx_photos_job ON photos(job_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_photos_category ON photos(category);
CREATE INDEX IF NOT EXISTS idx_photos_created ON photos(created_at DESC);

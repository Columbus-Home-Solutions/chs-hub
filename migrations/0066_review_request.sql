-- Sprint 35: Google Review Request — per-job columns
ALTER TABLE jobs ADD COLUMN review_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN review_received INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN review_received_at TEXT;

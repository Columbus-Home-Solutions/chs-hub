-- Add job_id linkage to notes so PWA voice-note capture can attach a
-- note to a specific job. Existing rows (and any "General" voice notes
-- captured without a current job) stay NULL, which we treat as "general"
-- in API responses and the UI.
--
-- Migration 0007 — Phase 7B: PWA capture v1.

ALTER TABLE notes ADD COLUMN job_id TEXT;

CREATE INDEX IF NOT EXISTS idx_notes_job ON notes(job_id);

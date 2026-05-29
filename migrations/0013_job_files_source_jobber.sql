-- Source of job_files rows + idempotency for future Jobber attachment sync.
-- `source`: dashboard uploads vs jobber (when ingestion is implemented).
-- `jobber_attachment_id`: Jobber file id when ingested from API (unique, prevents duplicates).

ALTER TABLE job_files ADD COLUMN source TEXT NOT NULL DEFAULT 'dashboard';
ALTER TABLE job_files ADD COLUMN jobber_attachment_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_files_jobber_attachment_id
  ON job_files(jobber_attachment_id) WHERE jobber_attachment_id IS NOT NULL;

-- Per-job project files (drawings, contracts, pay records, etc.) — D1 + R2.
-- R2 key prefix: job-files/{job_id}/{doc_type}/{uuid}.ext
-- Distinct from PWA "expenses" receipts and from company-wide documents.

CREATE TABLE IF NOT EXISTS job_files (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'other',
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  notes TEXT,
  uploaded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_files_job_type ON job_files(job_id, doc_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_files_created ON job_files(created_at DESC);

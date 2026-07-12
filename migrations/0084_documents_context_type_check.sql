-- Fix documents.context_type CHECK constraint — it only allows the original 5 values
-- but three more have been added by subsequent sprints:
--   'selection'               — Sprint 38 Run 4 (Selections & Allowances approval)
--   'subcontractor_packet'    — Sprint 39 Run 1 (compliance document uploads)
--   'subcontractor_agreement' — Sprint 39 Run 2 (signed Subcontractor Agreement)
-- All three values are missing from the live constraint, causing any INSERT with those
-- values to fail with SQLITE_CONSTRAINT_CHECK.
--
-- State before: 2 rows (both 'company'), zero invalid rows. Rebuild is safe.
-- Pattern: same table-rebuild approach used in migrations/0083_packet_agreement_status.sql.
--
-- New CHECK includes all 8 distinct values actually used in application code.
-- Three named indexes recreated after the rename.

CREATE TABLE documents_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER,
  r2_key TEXT NOT NULL,
  r2_url TEXT NOT NULL,
  google_drive_id TEXT,
  google_drive_url TEXT,
  mirror_status TEXT,
  mirror_date TEXT,
  context_type TEXT NOT NULL CHECK(context_type IN (
    'job',
    'client',
    'estimate',
    'company',
    'template',
    'selection',
    'subcontractor_packet',
    'subcontractor_agreement'
  )),
  job_id TEXT REFERENCES jobs(id),
  client_id TEXT REFERENCES clients(id),
  estimate_id TEXT REFERENCES estimates(id),
  document_category TEXT NOT NULL,
  is_signed INTEGER DEFAULT 0,
  signed_date TEXT,
  signature_data TEXT,
  share_token TEXT UNIQUE,
  share_expiration TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO documents_new SELECT * FROM documents;

DROP TABLE documents;

ALTER TABLE documents_new RENAME TO documents;

CREATE INDEX idx_documents_job_id          ON documents(job_id);
CREATE INDEX idx_documents_context_type    ON documents(context_type);
CREATE INDEX idx_documents_document_category ON documents(document_category);

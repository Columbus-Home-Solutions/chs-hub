-- migration: 0047_esignature.sql
-- Sprint 21: BoldSign e-signature integration

-- Signature request tracking on job_documents
ALTER TABLE job_documents ADD COLUMN signature_status TEXT NOT NULL DEFAULT 'none';
-- 'none' | 'sent' | 'viewed' | 'signed' | 'completed' | 'declined' | 'expired' | 'revoked' | 'failed'
ALTER TABLE job_documents ADD COLUMN boldsign_document_id TEXT;
ALTER TABLE job_documents ADD COLUMN signature_sent_at TEXT;
ALTER TABLE job_documents ADD COLUMN signature_completed_at TEXT;
ALTER TABLE job_documents ADD COLUMN signed_r2_key TEXT;        -- signed PDF stored back from BoldSign
ALTER TABLE job_documents ADD COLUMN signer_email TEXT;
ALTER TABLE job_documents ADD COLUMN signer_name TEXT;

CREATE INDEX IF NOT EXISTS idx_job_documents_boldsign ON job_documents(boldsign_document_id);
CREATE INDEX IF NOT EXISTS idx_job_documents_sigstatus ON job_documents(signature_status);

-- Signature event log for audit/debugging
CREATE TABLE IF NOT EXISTS signature_events (
  id TEXT PRIMARY KEY,
  job_document_id TEXT NOT NULL REFERENCES job_documents(id),
  boldsign_document_id TEXT,
  event_type TEXT NOT NULL,
  raw_payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signature_events_doc ON signature_events(job_document_id);

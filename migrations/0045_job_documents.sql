-- migration: 0045_job_documents.sql
-- Sprint 19: Document Auto-Fill — job_documents tracking table.
-- merge_fields column already exists on document_templates (confirmed via PRAGMA in Step 0).
-- No ALTER TABLE needed.

CREATE TABLE IF NOT EXISTS job_documents (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  template_type TEXT NOT NULL,
  -- template_type values: 'service_agreement' | 'cost_plus_agreement' | 'change_order'
  -- | 'lien_waiver_conditional' | 'lien_waiver_sub_unconditional' | 'warranty_certificate'
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  generated_by TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_documents_job ON job_documents(job_id);

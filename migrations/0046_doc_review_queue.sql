-- migration: 0046_doc_review_queue.sql
-- Sprint 20: Add review workflow columns to job_documents.
-- review_status values:
--   'manual'         = Sprint 19 manual gen, no review needed (default so existing rows are excluded from queue)
--   'pending_review' = auto-generated, awaiting Tony
--   'approved'       = reviewed and approved
--   'discarded'      = reviewed and discarded (dedup guard still blocks regeneration)

ALTER TABLE job_documents ADD COLUMN review_status TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE job_documents ADD COLUMN auto_generated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_documents ADD COLUMN trigger_event TEXT;
-- trigger_event values: 'job_deposit_paid', 'change_order_approved', 'client_payment', 'sub_payment', 'job_complete'
ALTER TABLE job_documents ADD COLUMN related_record_id TEXT;
-- related_record_id: change_order_id / payment_id / expense_id — used as dedup guard key
ALTER TABLE job_documents ADD COLUMN reviewed_at TEXT;
ALTER TABLE job_documents ADD COLUMN reviewed_by TEXT;

CREATE INDEX IF NOT EXISTS idx_job_documents_review ON job_documents(review_status);
CREATE INDEX IF NOT EXISTS idx_job_documents_trigger ON job_documents(job_id, template_type, related_record_id);

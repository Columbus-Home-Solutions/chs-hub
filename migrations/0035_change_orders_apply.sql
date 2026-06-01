-- Sprint 13: Change Orders — replay-safe auto-apply + CO-number hardening.
--
-- Step-0 PRAGMA (local) confirmed change_orders shipped (0014_jobs_schema.sql)
-- with status / approved_date / client_signature but NO apply-anchor and NO
-- unique CO number (only idx_change_orders_job_id, non-unique). This migration
-- is ADDITIVE ONLY — the delta needed for the idempotent sign→approve→apply
-- flow (Deliverable A) and the in-transaction CO-number allocation.
--
-- schedule_entries / permits / warranties need ZERO new columns this sprint
-- (schedule_entries.notification_sent already exists as the sub-notify flag).
--
-- ⚠️ Direct-execute ONLY (never `wrangler d1 migrations apply`): the ledger
-- records 0001–0013, so `migrations apply` restarts at 0014 and crashes
-- (Sprint 6 deviation 1). Remote is a separate backup-first runbook.

ALTER TABLE change_orders ADD COLUMN applied_at TEXT;                            -- set once, when a signed CO is applied (idempotency anchor)
ALTER TABLE change_orders ADD COLUMN end_date_extension_days INTEGER DEFAULT 0;  -- §4.5 "extends target end date if specified"
ALTER TABLE change_orders ADD COLUMN signed_name TEXT;                           -- typed signer name (audit)
ALTER TABLE change_orders ADD COLUMN signed_ip TEXT;                             -- captured at signature (audit)

-- Per-job unique CO number, backing the in-transaction MAX()+1 allocation
-- (mirrors idx_invoices_invoice_number). Existing seed/legacy rows are already
-- distinct per job, so this holds on create.
CREATE UNIQUE INDEX IF NOT EXISTS idx_change_orders_job_number_unique
  ON change_orders(job_id, change_order_number);

-- New SIMULATE notification templates (rows, not schema). sub_scheduled already
-- exists from 0030; these two are the CO delivery + approval receipts. Stay
-- inactive-safe: is_active=1 so they enqueue, but dispatch mode is SIMULATE.
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes, send_time, phase, created_at)
VALUES
  ('nt-change-order-sent-email', 'change_order_sent', 'Change Order Sent', 'client', 'email',
   'Change Order CO-{{change_order_number}} for your review',
   'Hi {{client_first_name}}, a change order (CO-{{change_order_number}}: {{change_order_title}}, {{change_order_amount}}) is ready for your review and signature. Please open your project portal to review and sign: {{portal_link}}',
   '["client_first_name","change_order_number","change_order_title","change_order_amount","portal_link"]',
   1, 0, NULL, 'job', datetime('now')),
  ('nt-change-order-approved-email', 'change_order_approved', 'Change Order Approved', 'client', 'email',
   'Change Order CO-{{change_order_number}} approved',
   'Thank you, {{client_first_name}}. Change order CO-{{change_order_number}} ({{change_order_title}}) has been signed and approved. We''ve updated your project accordingly.',
   '["client_first_name","change_order_number","change_order_title"]',
   1, 0, NULL, 'job', datetime('now'));

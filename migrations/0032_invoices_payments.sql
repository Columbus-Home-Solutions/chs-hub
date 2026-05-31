-- 0032_invoices_payments.sql
-- Sprint 9 — Invoice Generation & Basic Payments.
--
-- The financial tables already exist and carry (per PRAGMA, not the schema doc
-- alone) every COLUMN this sprint needs on `invoices` and `payments`
-- (late_fee_amount, credits_applied, total_due, portal_link, convenience_fee,
-- stripe_fee, net_amount, invoice_number, milestone_number, trade_line_item_id,
-- cost_plus_cycle_id, …). So this migration is intentionally tiny: it adds the
-- carried-over hardening INDEXES, the small set of genuinely-missing columns,
-- and the idempotency backstop — it does NOT recreate any table.
--
-- One statement per line; additive only; idempotent where SQLite allows
-- (CREATE … IF NOT EXISTS). Applied LOCALLY by direct execute (NOT
-- `migrations apply` — the d1_migrations ledger is intentionally out of sync
-- with the directly-executed 0014–0031, per the handoff):
--   npx wrangler d1 execute chs-hub-db --local --file=migrations/0032_invoices_payments.sql
--
-- SQLite ALTER cannot add a NOT NULL column without a constant default and
-- never DROPs; every added column below is nullable or constant-defaulted, and
-- new code enforces required values at write time.

-- ── job_number hardening (Sprint 6 deviation 2) ─────────────────────────────
-- The core of the carried-over fix. A UNIQUE index on jobs(job_number) makes a
-- duplicate allocation fail CLEANLY at the DB (constraint violation) instead of
-- silently colliding. Allocation also moves INSIDE the insert (quote-to-job.ts
-- now does `COALESCE(MAX(job_number),0)+1` in the INSERT…SELECT, not a separate
-- read), so there is no longer a read-then-write race window. Legacy
-- Jobber-synced rows with NULL job_number coexist — SQLite permits many NULLs
-- under a UNIQUE index. PRAGMA confirmed no duplicate non-NULL job_number exists.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_job_number ON jobs(job_number);

-- ── invoice_number hardening ────────────────────────────────────────────────
-- PRAGMA correction: invoice_number was added in 0014 as a plain ALTER column
-- (NOT unique — the schema doc's "UNIQUE" was aspirational). Sprint 9 allocates
-- invoice_number the same in-transaction way as job_number, backed by this
-- UNIQUE index so a collision fails cleanly. Many NULLs allowed (legacy rows).
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_invoice_number ON invoices(invoice_number);

-- ── per-invoice payment token (Open Question 1 — decided) ───────────────────
-- The standalone token-gated payment page (/pay/:token) reuses the Sprint 5
-- estimate `portal_token` PATTERN but gets its OWN per-invoice token so each
-- invoice link is independently revocable and never entangles with the Sprint
-- 12 client-portal token. `portal_link` (already present) stores the full URL;
-- `payment_token` is the credential the public route matches on.
ALTER TABLE invoices ADD COLUMN payment_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_payment_token ON invoices(payment_token);

-- ── invoice viewed timestamp ────────────────────────────────────────────────
-- Lifecycle draft → sent → viewed → paid|partial|past_due. `viewed_date` stamps
-- the first open of the public payment page (mirrors estimates.viewed_date).
ALTER TABLE invoices ADD COLUMN viewed_date TEXT;

-- ── reverse-conversion / un-win (Sprint 6 deviation 6) ──────────────────────
-- Flag-and-preserve: a bounced check / NSF / chargeback / refund NEVER deletes
-- the job. The job row is kept and flagged; affected invoices are voided. PRAGMA
-- confirmed these columns are absent on `jobs`.
ALTER TABLE jobs ADD COLUMN conversion_reversed INTEGER DEFAULT 0;
ALTER TABLE jobs ADD COLUMN reversal_reason TEXT;
ALTER TABLE jobs ADD COLUMN reversed_at TEXT;

-- ── payment idempotency backstop ────────────────────────────────────────────
-- A re-delivered Stripe event (Stripe retries aggressively) must never create a
-- second payment row. The webhook checks-before-insert on the PaymentIntent id;
-- this partial UNIQUE index is the race backstop (one Stripe PaymentIntent ↔ at
-- most one payment row). Partial so the many manual/seed rows with NULL
-- stripe_payment_id are exempt. PRAGMA confirmed no duplicate non-NULL ids.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_stripe_payment_id
  ON payments(stripe_payment_id) WHERE stripe_payment_id IS NOT NULL;

-- ── overdue-scan composite (cron) ───────────────────────────────────────────
-- The Invoice Due Check + Late Fee Calculator crons scan unpaid invoices by
-- (status, due_date). The existing single-column idx_invoices_status and
-- idx_invoices_due_date can't serve the combined predicate as cheaply.
CREATE INDEX IF NOT EXISTS idx_invoices_status_due ON invoices(status, due_date);

-- ── invoice_sent notification template (wire the send notification) ─────────
-- Sprint 7 seeded payment_received / invoice_due_reminder / invoice_past_due but
-- NOT an invoice-delivery template. POST /api/invoices/:id/send fires this so
-- the client gets the secure payment link. Stays SIMULATED until Pre-Launch
-- (dispatch mode is unchanged). Idempotent insert; phase='financial'.
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes, phase, sort_order, created_at, updated_at)
VALUES
  ('nt-invoice-sent-email', 'invoice_sent', 'Invoice Sent Email', 'client', 'email',
   'Invoice #{{invoice_number}} from {{company_name}}',
   'Invoice #{{invoice_number}} for {{invoice_amount}} is ready. It is due {{due_date}}. View and pay securely here: {{payment_link}}',
   '["invoice_number","invoice_amount","due_date","payment_link","company_name"]', 1, 0, 'financial', 40, datetime('now'), datetime('now')),
  ('nt-invoice-sent-sms', 'invoice_sent', 'Invoice Sent SMS', 'client', 'sms',
   NULL,
   '{{company_name}}: Invoice #{{invoice_number}} for {{invoice_amount}} is ready (due {{due_date}}). Pay here: {{payment_link}}',
   '["invoice_number","invoice_amount","due_date","payment_link","company_name"]', 1, 0, 'financial', 41, datetime('now'), datetime('now'));

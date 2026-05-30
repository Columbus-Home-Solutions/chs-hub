-- 0028_quote_delivery.sql
-- Sprint 5 — Quote Delivery & Client Approval migration of record.
--
-- Most of what Sprint 5 needs already exists from earlier migrations:
--   estimates: status / sent_at / expiration_date / portal_token /
--              valid_days / client_signature / signed_date / include_contract /
--              contract_template_id   (0014 + 0027 — verified via PRAGMA)
--   payments:  amount / convenience_fee / stripe_fee / net_amount /
--              payment_method / stripe_payment_id / invoice_id (nullable) (0014)
--   estimate_requests: lost_reason / lost_notes / follow_up_count /
--              last_follow_up_date / sent_date  (0016)
--
-- Genuinely-new columns this sprint (all additive, nullable — SQLite ALTER
-- cannot add NOT NULL without a constant default, so new code sets values at
-- write time). One ALTER per statement. Safe to run once.

-- ── estimates: view/approve tracking + the rendered contract snapshot ──────
-- viewed_date   — stamped on first public load (status sent → viewed)
-- approved_date — stamped when the deposit is recorded (approved)
-- contract_text — the contract rendered at send time, frozen so the public
--                 page and the signature both reference the exact agreed text
ALTER TABLE estimates ADD COLUMN viewed_date TEXT;
ALTER TABLE estimates ADD COLUMN approved_date TEXT;
ALTER TABLE estimates ADD COLUMN contract_text TEXT;

-- ── payments: tie a deposit to its estimate ────────────────────────────────
-- A Stripe/manual deposit is recorded against the freshly-created job
-- (payments.job_id, set by the shared conversion path), but we also stamp the
-- originating estimate so a deposit payment is traceable to the estimate even
-- before any invoice exists. invoice_id stays nullable (deposits precede
-- invoices — Sprint 9 owns invoice payments).
ALTER TABLE payments ADD COLUMN estimate_id TEXT;

-- ── lookups ─────────────────────────────────────────────────────────────────
-- The public quote page is gated solely by portal_token; index it for the
-- token → estimate lookup. SQLite allows multiple NULLs under a UNIQUE index,
-- so drafts without a token coexist while sent tokens stay unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_estimates_portal_token ON estimates(portal_token);
CREATE INDEX IF NOT EXISTS idx_payments_estimate ON payments(estimate_id);

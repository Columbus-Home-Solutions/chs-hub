-- Sprint 11: Cost-Plus Billing Engine.
--
-- The billing_cycles table and the invoices cost-plus columns (invoice_type
-- CHECK already includes 'cost_plus_cycle', credits_applied, cost_plus_cycle_id)
-- already exist from the unified financial schema (0018), confirmed by PRAGMA in
-- Step 0 — so this is a ZERO-SCHEMA-CHANGE sprint. The only thing missing is a
-- performance index for the cycle-detail join (invoice ⇄ cycle).
--
-- NOTE: NOT a UNIQUE index. Per-job cycle_number uniqueness is enforced in the
-- POST /api/jobs/:id/billing-cycles handler (the Sprint 9/10 lesson: a UNIQUE
-- over legacy/seed rows can roll back on apply). Local-only this sprint; remote
-- is a separate backup-first step, gated on Sprint 10 being live.

CREATE INDEX IF NOT EXISTS idx_invoices_cost_plus_cycle
  ON invoices(cost_plus_cycle_id);

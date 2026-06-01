-- 0033_expenses_job_costing.sql — Sprint 10 (Expense Tracking & Job Costing)
--
-- The financial tables (expenses, time_entries, mileage, vendor_materials) all
-- already exist from 0018_financial_tables.sql with every column this sprint
-- needs (estimate_line_item_id, receipt_photo_id, tax_category, is_1099_reportable,
-- sub_id, hourly_rate/hours/labor_cost, irs_rate/deduction_amount,
-- last_price/average_price/price_history). PRAGMA confirms.
--
-- This migration is therefore NEAR-ZERO. It adds only what was genuinely missing:
--   1. A soft-void flag on `expenses` (none existed) so a corrected/voided expense
--      is preserved with its receipt linkage and excluded from costing/profit
--      (business rules #8 + #13). Default 1 (active) backfills every existing row.
--   2. Costing-actuals scan indexes: expenses(estimate_line_item_id) + expenses(sub_id).
--   3. A partial index for the open-clock-in guard / active-timer lookup.
--   4. A lookup index backing the vendor-material upsert key
--      (vendor_name, material_name, unit). NON-UNIQUE on purpose: existing
--      vendor_materials seed rows already contain duplicate natural keys, so a
--      UNIQUE constraint would fail to apply. The upsert helper dedups in code
--      (SELECT … ORDER BY updated_at DESC LIMIT 1) using this index.
--
-- All statements are idempotent-friendly (IF NOT EXISTS) except the ALTER, which
-- runs once. Applied LOCALLY only for Sprint 10 (remote is a separate, backup-first
-- step). One statement per line.

ALTER TABLE expenses ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_expenses_estimate_line_item ON expenses(estimate_line_item_id);
CREATE INDEX IF NOT EXISTS idx_expenses_sub_id ON expenses(sub_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_active ON time_entries(worker, job_id) WHERE clock_out IS NULL;
CREATE INDEX IF NOT EXISTS idx_vendor_materials_key ON vendor_materials(vendor_name, material_name, unit);

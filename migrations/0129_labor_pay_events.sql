-- Pay events can cover any subset of days, including more than one per week.
-- 0128 is already applied locally; this file is additive. Do not edit 0128.

DROP INDEX IF EXISTS idx_labor_batch_week;

ALTER TABLE labor_pay_batches ADD COLUMN period_start TEXT;
ALTER TABLE labor_pay_batches ADD COLUMN period_end TEXT;
ALTER TABLE labor_pay_batches ADD COLUMN method TEXT;
ALTER TABLE labor_pay_batches ADD COLUMN note TEXT;

ALTER TABLE labor_entries ADD COLUMN deleted_at TEXT;
ALTER TABLE labor_entries ADD COLUMN deleted_by TEXT;
ALTER TABLE labor_entries ADD COLUMN delete_reason TEXT;
ALTER TABLE labor_entries ADD COLUMN updated_at TEXT;
ALTER TABLE labor_entries ADD COLUMN updated_by TEXT;

CREATE INDEX IF NOT EXISTS idx_labor_batches_paid ON labor_pay_batches(paid_at);

UPDATE labor_pay_batches
SET period_start = (
      SELECT MIN(work_date) FROM labor_entries
      WHERE batch_id = labor_pay_batches.id AND deleted_at IS NULL
    ),
    period_end = (
      SELECT MAX(work_date) FROM labor_entries
      WHERE batch_id = labor_pay_batches.id AND deleted_at IS NULL
    )
WHERE period_start IS NULL;

UPDATE labor_pay_batches
SET period_start = COALESCE(period_start, week_start),
    period_end = COALESCE(period_end, week_end)
WHERE period_start IS NULL OR period_end IS NULL;

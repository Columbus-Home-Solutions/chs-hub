-- Distinguish project-priced subs from day-rate labor on the same table.
-- Existing rows are all subcontractors today — default preserves that.
ALTER TABLE subcontractors ADD COLUMN worker_type TEXT NOT NULL DEFAULT 'subcontractor';
-- Optional day rate, only meaningful for worker_type = 'day_rate_labor'.
ALTER TABLE subcontractors ADD COLUMN day_rate REAL;

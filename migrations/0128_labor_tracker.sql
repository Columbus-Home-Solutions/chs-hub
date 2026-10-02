-- Day-rate labor log and weekly pay batches.
-- Draft weeks are computed live; a row is inserted only when the week is marked paid.
-- Create labor_pay_batches first (labor_entries.batch_id references it).

CREATE TABLE IF NOT EXISTS labor_pay_batches (
  id          TEXT PRIMARY KEY,
  week_start  TEXT NOT NULL,
  week_end    TEXT NOT NULL,
  pay_date    TEXT NOT NULL,
  total       REAL NOT NULL,
  paid_at     TEXT,
  paid_by     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_batch_week ON labor_pay_batches(week_start);

CREATE TABLE IF NOT EXISTS labor_entries (
  id            TEXT PRIMARY KEY,
  sub_id        TEXT NOT NULL REFERENCES subcontractors(id),
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  work_date     TEXT NOT NULL,
  days          REAL NOT NULL CHECK (days IN (0.5, 1)),
  day_rate      REAL NOT NULL,
  notes         TEXT,
  batch_id      TEXT REFERENCES labor_pay_batches(id),
  expense_id    TEXT REFERENCES expenses(id),
  entered_via   TEXT NOT NULL DEFAULT 'web',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    TEXT
);

CREATE INDEX IF NOT EXISTS idx_labor_entries_week ON labor_entries(work_date);
CREATE INDEX IF NOT EXISTS idx_labor_entries_sub  ON labor_entries(sub_id);
CREATE INDEX IF NOT EXISTS idx_labor_entries_job  ON labor_entries(job_id);

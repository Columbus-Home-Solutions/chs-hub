-- 0029_job_conversion.sql
-- Sprint 6 — Quote-to-Job Conversion & Job Pipeline migration of record.
--
-- The job tables already exist (0017_job_tables.sql: jobs, tasks, daily_logs,
-- change_orders, schedule_entries, permits, warranties) and the Sprint 4 manual
-- Won path already writes a sparse `jobs` row + portal_token. PRAGMA confirms
-- jobs already has: estimate_id, portal_token, portal_type, deposit_amount,
-- deposit_paid, contract_total, billing_model, start_date, target_end_date,
-- actual_end_date, notes, and the full client/property columns. So this
-- migration is near no-op on `jobs` — it adds exactly one genuinely-missing
-- column plus the billing-schedule scaffold table.
--
-- One ALTER per statement; additive only (SQLite ALTER cannot add NOT NULL
-- without a constant default, and never DROPs). Safe to run once.

-- ── jobs.conversion_complete ────────────────────────────────────────────────
-- Distinguishes the THREE conversion states the shared idempotent
-- convertQuoteToJob() keys on (Job Management §4.2):
--   0 = bare row written by the Sprint 4/5 manual-Won / Stripe-stub path
--       (no task groups, no budget baseline, no billing scaffold) — the
--       "job exists but is unconverted" state. Production job #100 is exactly
--       this: a live bare stub the deferred-completion branch must finish in
--       place on a future deploy.
--   1 = fully converted (task groups + budget baseline + billing scaffold +
--       portal activation have all run).
-- DEFAULT 0 means every pre-existing job (the local seeds and prod #100) reads
-- as "bare/unconverted" until the extended engine completes it — exactly the
-- behavior we want.
ALTER TABLE jobs ADD COLUMN conversion_complete INTEGER DEFAULT 0;

-- ── jobs.portal_token uniqueness ────────────────────────────────────────────
-- The portal link is the client's only entry point; a duplicate token would
-- cross-wire two jobs' portals. Legacy Jobber-synced jobs have NULL tokens and
-- SQLite permits multiple NULLs under a UNIQUE index, so they coexist while
-- every native job's token stays unique. Conversion REUSES an existing token
-- and never regenerates one, so this index also guards against an accidental
-- second token write.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_portal_token ON jobs(portal_token);

-- ── budget baseline lives on the linked estimate ────────────────────────────
-- The conversion does NOT snapshot a separate budget table: the approved
-- estimate is frozen at approval (status='approved', signed) and the job links
-- it via jobs.estimate_id, so the per-line-item costing baseline is already
-- persisted and job-readable through estimate_line_items (client price) +
-- estimate_sub_items (internal cost). Sprint 9/10's costing view reads it from
-- there. Index the parent→sub join so that read is cheap.
CREATE INDEX IF NOT EXISTS idx_estimate_sub_items_parent
  ON estimate_sub_items(parent_line_item_id);

-- ── billing_schedule (NEW) — per-job billing scaffold ───────────────────────
-- Genuinely missing: billing_cycles is cost-plus-specific and invoice-heavy,
-- payment_schedules is keyed to the ESTIMATE, and invoices are Sprint 9. There
-- is no per-JOB billing schedule table. The conversion writes the scaffold here
-- (status='draft'); the Sprint 9 billing engine reads these rows to generate
-- the actual invoices. No invoice is generated in Sprint 6.
--
--   fixed_price    → one row per milestone draw (e.g. 33/33/34), trigger_type
--                    'milestone', trigger_ref = milestone number as text.
--   trade_by_trade → one row per trade/task-group, trigger_type
--                    'trade_completion', trigger_ref = task_group name (the
--                    linkage to task-group completion; invoices are NOT fired).
--   cost_plus      → the first bi-weekly cycle WINDOW is written to
--                    billing_cycles (the purpose-built table); a single marker
--                    row here records the cadence for the schedule view.
CREATE TABLE IF NOT EXISTS billing_schedule (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id),
  billing_model TEXT NOT NULL,
  sequence      INTEGER NOT NULL,                 -- display / draw order
  label         TEXT NOT NULL,                    -- e.g. "Draw 1 — Materials Deposit"
  trigger_type  TEXT NOT NULL,                    -- milestone | trade_completion | cost_plus_cycle
  trigger_ref   TEXT,                             -- milestone #, task_group name, or cycle marker
  percentage    REAL,                             -- fixed_price draws (nullable)
  amount        REAL,                             -- scaffolded dollar amount (nullable)
  period_start  TEXT,                             -- cost_plus cycle window start (nullable)
  period_end    TEXT,                             -- cost_plus cycle window end (nullable)
  status        TEXT NOT NULL DEFAULT 'draft',    -- draft until Sprint 9 invoices it
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_billing_schedule_job ON billing_schedule(job_id);

-- 0008_expenses_pwa.sql
--
-- Extends the existing `expenses` table (created by 0001_init.sql and fed
-- read-only from the Jobber sync) so the CHS Capture PWA can write expense
-- rows directly. New columns:
--
--   vendor               — free-text vendor name ("Lowe's", "Home Depot", …).
--   receipt_r2_key       — R2 object key for the receipt photo, NULL when no
--                          photo was attached.
--   entered_via          — 'jobber' (default, set by sync) or 'pwa' (set by
--                          POST /api/expenses).
--   pushed_to_jobber_at  — ISO timestamp once the row has been written back
--                          to Jobber via the GraphQL expense-create mutation.
--                          Stays NULL for PWA-only rows that never make it
--                          back to Jobber. The dashboard renders a "pending
--                          Jobber sync" badge whenever this is NULL on a
--                          row where entered_via='pwa'.
--   jobber_id            — Jobber's ID for this expense, populated alongside
--                          pushed_to_jobber_at. Used so we don't double-write
--                          if the cron sync sees the row come back through.
--
-- The Jobber write-back is intentionally NOT wired in this migration — that's
-- a separate follow-up that needs Jobber API investigation. For now, PWA rows
-- live in D1+R2 and the dashboard surfaces them clearly.

ALTER TABLE expenses ADD COLUMN vendor TEXT;
ALTER TABLE expenses ADD COLUMN receipt_r2_key TEXT;
ALTER TABLE expenses ADD COLUMN entered_via TEXT NOT NULL DEFAULT 'jobber';
ALTER TABLE expenses ADD COLUMN pushed_to_jobber_at TEXT;
ALTER TABLE expenses ADD COLUMN jobber_id TEXT;

-- Index for the dashboard's "pending Jobber sync" badge query.
CREATE INDEX IF NOT EXISTS idx_expenses_pending_pushback
  ON expenses(entered_via, pushed_to_jobber_at);

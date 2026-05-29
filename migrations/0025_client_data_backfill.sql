-- 0025_client_data_backfill.sql
-- Sprint 2 — one-time backfill for the ~80 Jobber-imported clients.
--
-- Numbered 0025 because the sprint doc's "0023" collides with this repo's live
-- sequence (0023_views already exists). Continues after 0024_seed_data.
--
-- Goals (idempotent, NON-destructive — only fills NULLs, never overwrites):
--   1. Default the Sprint-1 boolean flags where null.
--   2. Backfill created_at / updated_at from legacy synced_at where missing.
--   3. Split the legacy single `name` column into first_name / last_name where
--      the native name fields are still empty (so the Client module displays
--      and searches them natively).
--   4. Repeat-client detection: flag is_repeat_client = 1 for any client that
--      already has more than one job.
--
-- Safe to re-run: every statement is guarded by an IS NULL / membership check.

-- ── 1. Default flags ────────────────────────────────────────────────────────
UPDATE clients SET is_repeat_client   = 0 WHERE is_repeat_client   IS NULL;
UPDATE clients SET review_requested   = 0 WHERE review_requested   IS NULL;
UPDATE clients SET google_review_left = 0 WHERE google_review_left IS NULL;

-- ── 2. Timestamps ───────────────────────────────────────────────────────────
UPDATE clients
SET created_at = COALESCE(created_at, synced_at, datetime('now'))
WHERE created_at IS NULL;

UPDATE clients
SET updated_at = COALESCE(updated_at, created_at, synced_at, datetime('now'))
WHERE updated_at IS NULL;

-- ── 3. Split legacy `name` → first_name / last_name (only where missing) ──────
-- Multi-word names: first token → first_name, remainder → last_name.
UPDATE clients
SET first_name = TRIM(SUBSTR(name, 1, INSTR(name, ' ') - 1))
WHERE first_name IS NULL
  AND name IS NOT NULL
  AND INSTR(TRIM(name), ' ') > 0;

UPDATE clients
SET last_name = TRIM(SUBSTR(TRIM(name), INSTR(TRIM(name), ' ') + 1))
WHERE last_name IS NULL
  AND name IS NOT NULL
  AND INSTR(TRIM(name), ' ') > 0;

-- Single-word names: put the whole thing in first_name.
UPDATE clients
SET first_name = TRIM(name)
WHERE first_name IS NULL
  AND name IS NOT NULL
  AND INSTR(TRIM(name), ' ') = 0
  AND TRIM(name) <> '';

-- ── 4. Repeat-client detection ────────────────────────────────────────────────
UPDATE clients
SET is_repeat_client = 1
WHERE id IN (
  SELECT client_id
  FROM jobs
  WHERE client_id IS NOT NULL
  GROUP BY client_id
  HAVING COUNT(*) > 1
);

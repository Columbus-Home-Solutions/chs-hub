-- Sprint 25: AI Close-Out Review columns on jobs table.
-- D1 constraint: no BEGIN TRANSACTION, no COMMIT, no PRAGMA.
-- Each ALTER TABLE is a separate statement. D1 stops on first error.

ALTER TABLE jobs ADD COLUMN ai_closeout_review TEXT;
ALTER TABLE jobs ADD COLUMN ai_closeout_generated_at TEXT;

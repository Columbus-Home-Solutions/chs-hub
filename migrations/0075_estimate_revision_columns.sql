-- Migration 0075: Estimate revision workflow — add is_current_version column.
--
-- revised_from_id (= revision_of_estimate_id in spec) and version (= revision_number)
-- already exist on the estimates table. is_current_version is the only new column needed.
--
-- Backfill: rows with status = 'revised' are historical versions (is_current_version = 0);
-- everything else is current (is_current_version = 1).

ALTER TABLE estimates ADD COLUMN is_current_version INTEGER NOT NULL DEFAULT 1;

UPDATE estimates SET is_current_version = 0 WHERE status = 'revised';

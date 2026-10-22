-- Job on hold. Additive only. jobs.status has no CHECK constraint, so
-- on_hold does not require a table rebuild.
ALTER TABLE jobs ADD COLUMN hold_reason TEXT;
ALTER TABLE jobs ADD COLUMN hold_previous_status TEXT;
ALTER TABLE jobs ADD COLUMN held_at TEXT;

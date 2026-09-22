-- Deadlines live as schedule_entries rows (no new table). Permit inspections
-- stay on permits and are merged in the calendar feed, not stored here.
-- Free-text column + app-level allow-list — no CHECK, so we don't have to
-- rebuild the existing table.

ALTER TABLE schedule_entries ADD COLUMN entry_type TEXT DEFAULT 'job_task';

UPDATE schedule_entries SET entry_type = 'job_task' WHERE entry_type IS NULL;

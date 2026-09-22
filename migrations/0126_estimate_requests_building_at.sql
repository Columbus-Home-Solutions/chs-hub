-- When a lead enters Building. Re-entry resets it; leaving the stage does not clear it.
ALTER TABLE estimate_requests ADD COLUMN building_at TEXT;

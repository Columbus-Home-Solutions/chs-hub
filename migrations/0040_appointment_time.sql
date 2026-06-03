-- Add appointment_time to estimate_requests
-- Stores HH:MM (24h) as TEXT, nullable, consistent with schedule_entries.start_time
ALTER TABLE estimate_requests ADD COLUMN appointment_time TEXT;

-- 0026_estimate_requests.sql
-- Sprint 3 — Estimating Pipeline: estimate_requests intake table.
--
-- NOTE: This table was first created in 0016_estimating_tables.sql. This file
-- re-asserts the exact same definition (CHS-Database-Schema.md §3) with
-- CREATE TABLE IF NOT EXISTS so it is a safe no-op on databases that already
-- have it, while remaining the canonical Sprint-3 migration of record. Runs on
-- LOCAL D1 only this sprint.

CREATE TABLE IF NOT EXISTS estimate_requests (
  id TEXT PRIMARY KEY,
  request_number INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('new_request','appointment_set','visit_done','building','sent','follow_up','won','lost')),
  client_id TEXT NOT NULL REFERENCES clients(id),
  property_address TEXT NOT NULL,
  property_city TEXT NOT NULL,
  property_state TEXT NOT NULL DEFAULT 'Arkansas',
  property_zip TEXT NOT NULL,
  job_type TEXT NOT NULL,
  lead_source TEXT NOT NULL,
  lead_source_detail TEXT,
  high_level_opportunity_id TEXT,
  appointment_date TEXT,
  appointment_completed INTEGER DEFAULT 0,
  visit_notes TEXT,
  visit_photo_ids TEXT,
  estimate_id TEXT REFERENCES estimates(id),
  sent_date TEXT,
  follow_up_count INTEGER DEFAULT 0,
  last_follow_up_date TEXT,
  lost_reason TEXT,
  lost_notes TEXT,
  converted_job_id TEXT REFERENCES jobs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_estimate_requests_status ON estimate_requests(status);
CREATE INDEX IF NOT EXISTS idx_estimate_requests_client_id ON estimate_requests(client_id);

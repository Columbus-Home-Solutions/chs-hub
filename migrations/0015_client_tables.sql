-- 0015_client_tables.sql
-- Sprint 1 — Client module tables: properties, communications.

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'Arkansas',
  zip TEXT NOT NULL,
  property_type TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS communications (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  job_id TEXT REFERENCES jobs(id),
  channel TEXT NOT NULL CHECK(channel IN ('phone_call','text_sms','email','portal_message','in_person','other')),
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  summary TEXT NOT NULL,
  body TEXT,
  duration_seconds INTEGER,
  call_recording_url TEXT,
  sent_via TEXT,
  high_level_message_id TEXT,
  attachments TEXT,
  logged_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

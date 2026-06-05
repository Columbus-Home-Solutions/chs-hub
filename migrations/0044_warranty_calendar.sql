-- Warranty calls, Google Calendar event cache, assignee calendar colors.

CREATE TABLE IF NOT EXISTS warranty_calls (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'scheduled', 'completed', 'cancelled')),
  assigned_to TEXT REFERENCES users(id),
  assigned_sub_id TEXT REFERENCES subcontractors(id),
  scheduled_date TEXT,
  scheduled_end TEXT,
  completed_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_warranty_calls_job_id ON warranty_calls(job_id);
CREATE INDEX IF NOT EXISTS idx_warranty_calls_status ON warranty_calls(status);
CREATE INDEX IF NOT EXISTS idx_warranty_calls_scheduled_date ON warranty_calls(scheduled_date);

CREATE TABLE IF NOT EXISTS google_calendar_events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  title TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  meet_link TEXT,
  description TEXT,
  event_type TEXT DEFAULT 'meeting',
  synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gcal_events_start ON google_calendar_events(start_time);

ALTER TABLE users ADD COLUMN calendar_color TEXT DEFAULT '#3B82F6';
ALTER TABLE subcontractors ADD COLUMN calendar_color TEXT DEFAULT '#10B981';

UPDATE users SET calendar_color = '#3B82F6' WHERE email = 'tony@homesolutionsar.com';

-- Expand integration_connections service enum for google_calendar OAuth row.
CREATE TABLE integration_connections_new (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL CHECK(service IN (
    'stripe','quickbooks','twilio','high_level','google_drive',
    'facebook','instagram','replicate','google_calendar'
  )),
  status TEXT NOT NULL CHECK(status IN ('connected','disconnected','error','pending')),
  access_token TEXT,
  refresh_token TEXT,
  token_expiry TEXT,
  account_id TEXT,
  configuration TEXT,
  last_sync TEXT,
  last_error TEXT,
  connected_at TEXT,
  connected_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO integration_connections_new
  SELECT * FROM integration_connections;

DROP TABLE integration_connections;

ALTER TABLE integration_connections_new RENAME TO integration_connections;

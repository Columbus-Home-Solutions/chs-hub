-- Mirror future CHS items onto the primary Google Calendar.
-- CHS stays the source of truth. The switch ships off. No PRAGMA.

CREATE TABLE IF NOT EXISTS google_calendar_event_links (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('estimate_request', 'schedule_entry', 'warranty_call')),
  source_id TEXT NOT NULL,
  google_event_id TEXT,
  last_synced_hash TEXT,
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('synced', 'pending', 'failed', 'deleted')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gcal_event_links_source
  ON google_calendar_event_links(source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_gcal_event_links_status
  ON google_calendar_event_links(status);

INSERT OR IGNORE INTO system_settings (key, value, value_type, category, label, description) VALUES
  ('google_calendar_write_enabled', '0', 'string', 'integrations', 'Show CHS items on Google Calendar',
   'Off until turned on. Requires a Google reconnect that includes event write. Does not change availability.');

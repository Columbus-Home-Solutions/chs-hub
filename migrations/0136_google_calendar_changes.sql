-- Notice when a CHS item moves or disappears on Google.
-- The switch ships off. Polling uses the existing 15-minute tick, one events.list, only while this is on.
-- No PRAGMA.

CREATE TABLE IF NOT EXISTS google_calendar_pending_changes (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('estimate_request', 'schedule_entry')),
  source_id TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('moved', 'deleted')),
  google_start TEXT,
  google_end TEXT,
  google_all_day INTEGER NOT NULL DEFAULT 0,
  summary_label TEXT,
  when_label TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'ignored')),
  bell_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gcal_pending_open
  ON google_calendar_pending_changes(source_type, source_id)
  WHERE status = 'pending';

INSERT OR IGNORE INTO system_settings (key, value, value_type, category, label, description) VALUES
  ('google_calendar_changes_enabled', '0', 'string', 'integrations', 'Tell me when a CHS item moves on Google',
   'Off until turned on. A move or delete rings the owner once. Nothing in CHS changes until Apply.');

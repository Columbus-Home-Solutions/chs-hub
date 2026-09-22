-- Per-client SMS conversation organization (archive / flag / pin / mark unread).
-- Conversations themselves are still derived by grouping communications on
-- client_id — this table holds only lazy-created organizational state.
-- Archive is non-destructive: no communications rows are deleted.

CREATE TABLE IF NOT EXISTS sms_conversation_state (
  client_id TEXT PRIMARY KEY REFERENCES clients(id),
  archived_at TEXT,
  flagged_at TEXT,
  pinned_at TEXT,
  unread_override_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sms_conversation_state_archived
  ON sms_conversation_state(archived_at);

-- Allow status='sending' on notification_logs for ImmediateDispatch claim-before-send.
--
-- Immediate dispatch (and cron) atomically claim a queued row with
--   UPDATE ... SET status = 'sending' WHERE id = ? AND status = 'queued'
-- before calling Resend/Twilio, so a concurrent cron tick cannot double-send.
--
-- The original CHECK from 0020_notification_tables.sql only allowed
--   queued|sent|delivered|failed|bounced
-- so the claim UPDATE threw SQLITE_CONSTRAINT_CHECK, immediate dispatch no-oped,
-- and only the */15 cron eventually drained rows.
--
-- SQLite cannot ALTER a CHECK — rebuild the table (same pattern as 0084 / 0104).
-- D1 ignores PRAGMA foreign_keys=OFF; clear orphaned communication_id pointers
-- first (historical auto-log rows whose communications were deleted), then
-- defer_foreign_keys for the DROP+RENAME window.

-- Dead FK pointers — communications rows no longer exist (366 on prod at write time).
UPDATE notification_logs
SET communication_id = NULL
WHERE communication_id IS NOT NULL
  AND communication_id NOT IN (SELECT id FROM communications);

PRAGMA defer_foreign_keys = ON;

CREATE TABLE notification_logs_new (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES notification_templates(id),
  trigger_event TEXT NOT NULL,
  recipient_type TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_contact TEXT NOT NULL,
  channel TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','sending','sent','delivered','failed','bounced')),
  error_message TEXT,
  job_id TEXT REFERENCES jobs(id),
  client_id TEXT REFERENCES clients(id),
  estimate_request_id TEXT REFERENCES estimate_requests(id),
  communication_id TEXT REFERENCES communications(id),
  sent_at TEXT,
  delivered_at TEXT,
  external_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  scheduled_for TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  recipient_user_id TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  read_at TEXT,
  link_path TEXT,
  dedupe_key TEXT
);

INSERT INTO notification_logs_new SELECT * FROM notification_logs;

DROP TABLE notification_logs;

ALTER TABLE notification_logs_new RENAME TO notification_logs;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_logs_dedupe
  ON notification_logs(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_logs_due
  ON notification_logs(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_notification_logs_inbox
  ON notification_logs(recipient_user_id, is_read, created_at);
CREATE INDEX IF NOT EXISTS idx_notification_logs_external
  ON notification_logs(external_id);
CREATE INDEX IF NOT EXISTS idx_notification_logs_job_id
  ON notification_logs(job_id);
CREATE INDEX IF NOT EXISTS idx_notification_logs_status
  ON notification_logs(status);
CREATE INDEX IF NOT EXISTS idx_notification_logs_trigger_event
  ON notification_logs(trigger_event);

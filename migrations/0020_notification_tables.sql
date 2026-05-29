-- 0020_notification_tables.sql
-- Sprint 1 — Notification module tables: notification_templates,
-- notification_logs.

CREATE TABLE IF NOT EXISTS notification_templates (
  id TEXT PRIMARY KEY,
  trigger_event TEXT NOT NULL,
  name TEXT NOT NULL,
  recipient_type TEXT NOT NULL CHECK(recipient_type IN ('client','subcontractor','internal','owner')),
  channel TEXT NOT NULL CHECK(channel IN ('sms','email','push','in_app')),
  subject TEXT,
  body_template TEXT NOT NULL,
  merge_fields TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  delay_minutes INTEGER DEFAULT 0,
  send_time TEXT,
  phase TEXT,
  sort_order INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notification_logs (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES notification_templates(id),
  trigger_event TEXT NOT NULL,
  recipient_type TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_contact TEXT NOT NULL,
  channel TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','sent','delivered','failed','bounced')),
  error_message TEXT,
  job_id TEXT REFERENCES jobs(id),
  client_id TEXT REFERENCES clients(id),
  estimate_request_id TEXT REFERENCES estimate_requests(id),
  communication_id TEXT REFERENCES communications(id),
  sent_at TEXT,
  delivered_at TEXT,
  external_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

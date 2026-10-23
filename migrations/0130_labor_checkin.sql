-- Day-rate worker check-in. Existing rows default to confirmed so logged days keep counting.
-- SQLite cannot drop NOT NULL on labor_entries.day_rate. A check-in with no rate
-- stores 0; confirm refuses until a positive rate is written onto the row.

ALTER TABLE labor_entries ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'
  CHECK (status IN ('pending', 'confirmed'));
ALTER TABLE labor_entries ADD COLUMN submitted_at TEXT;
ALTER TABLE labor_entries ADD COLUMN confirmed_at TEXT;
ALTER TABLE labor_entries ADD COLUMN confirmed_by TEXT;

ALTER TABLE sub_access_tokens ADD COLUMN schedule_seen_at TEXT;
ALTER TABLE sub_access_tokens ADD COLUMN punch_seen_at TEXT;
ALTER TABLE sub_access_tokens ADD COLUMN disabled_at TEXT;

ALTER TABLE subcontractors ADD COLUMN text_updates_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subcontractors ADD COLUMN text_updates_enabled_at TEXT;
ALTER TABLE subcontractors ADD COLUMN text_updates_enabled_by TEXT;

INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes, phase, sort_order, created_at, updated_at)
VALUES
  ('nt-day-rate-schedule', 'day_rate_schedule', 'Day-rate schedule update', 'subcontractor', 'sms', 'Schedule',
   'CHS: Tony updated your schedule. See it: {{link}}/schedule. Reply STOP to opt out.',
   '["link"]', 1, 15, 'jobs', 80, datetime('now'), datetime('now')),
  ('nt-day-rate-punch', 'day_rate_punch', 'Day-rate punch item', 'subcontractor', 'sms', 'Punch list',
   'CHS: New punch list item. {{link}}/punch. Reply STOP to opt out.',
   '["link"]', 1, 15, 'jobs', 81, datetime('now'), datetime('now'));

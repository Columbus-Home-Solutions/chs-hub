-- Missed-call intake prompt + auto-text-back.
-- Unknown-caller logs reuse smart_notes (job_id NULL + entered_via discriminator)
-- with a callback_phone column. communications.client_id is NOT NULL, so it
-- cannot hold a genuinely unknown caller without creating a client row.

ALTER TABLE smart_notes ADD COLUMN callback_phone TEXT;

CREATE INDEX IF NOT EXISTS idx_smart_notes_missed_call
  ON smart_notes(entered_via, created_at)
  WHERE entered_via = 'missed_call';

-- Ship OFF until Tony confirms the unknown-caller first-contact SMS with counsel.
INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
VALUES (
  'missed_call_intake_enabled',
  'false',
  'boolean',
  'integrations',
  'Missed-call intake prompt',
  'When on, unknown callers hear a short name/reason prompt before the phone rings, and missed calls get an auto-text. Known clients skip the prompt. Default off until the unknown-caller SMS compliance question is confirmed.',
  datetime('now')
)
ON CONFLICT(key) DO NOTHING;

INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes, phase, sort_order, created_at, updated_at)
VALUES
  ('nt-missed-call-client-sms', 'missed_call_client', 'Missed Call SMS (known client)', 'client', 'sms',
   NULL,
   'Hi {{client_first_name}}, sorry we missed your call! This is Columbus Home Solutions — what can we help you with? Call or text us back anytime at 501-263-2050.',
   '["client_first_name"]',
   1, 0, 'communications', 80, datetime('now'), datetime('now')),
  ('nt-missed-call-unknown-sms', 'missed_call_unknown', 'Missed Call SMS (unknown caller)', 'client', 'sms',
   NULL,
   'Hi! Sorry we missed your call — thanks for letting us know what''s going on, we''ll get back to you shortly. – Columbus Home Solutions, 501-263-2050 Reply STOP to opt out.',
   '[]',
   1, 0, 'communications', 81, datetime('now'), datetime('now'));

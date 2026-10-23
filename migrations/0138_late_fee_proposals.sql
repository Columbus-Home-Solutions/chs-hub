-- One-time 5% late fee, proposed for the owner to add, waive, snooze, or hold.
-- Existing late_fee_amount values are left as they are. New columns only.

ALTER TABLE invoices ADD COLUMN late_fee_state TEXT DEFAULT 'none';
ALTER TABLE invoices ADD COLUMN late_fee_proposed_amount REAL;
ALTER TABLE invoices ADD COLUMN late_fee_waived_amount REAL;
ALTER TABLE invoices ADD COLUMN late_fee_hold INTEGER DEFAULT 0;
ALTER TABLE invoices ADD COLUMN late_fee_hold_reason TEXT;
ALTER TABLE invoices ADD COLUMN late_fee_snooze_until TEXT;
ALTER TABLE invoices ADD COLUMN late_fee_proposed_at TEXT;
ALTER TABLE invoices ADD COLUMN late_fee_decided_at TEXT;
ALTER TABLE invoices ADD COLUMN late_fee_decided_by TEXT;

CREATE TABLE IF NOT EXISTS late_fee_decisions (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  action TEXT NOT NULL,
  amount REAL,
  reason TEXT,
  snooze_until TEXT,
  actor_email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_late_fee_decisions_invoice
  ON late_fee_decisions (invoice_id, created_at);

INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
VALUES (
  'late_fee_proposals_enabled',
  'false',
  'boolean',
  'financial',
  'Propose late fees',
  'When off, the nightly check only counts invoices that would be proposed. Nothing is charged until the owner presses Add fee.',
  datetime('now')
)
ON CONFLICT(key) DO NOTHING;

UPDATE notification_templates
   SET body_template = 'Invoice #{{invoice_number}} for {{invoice_amount}} was due on {{due_date}}. Pay here: {{payment_link}} Call us if you have questions.',
       merge_fields = '["invoice_number","invoice_amount","due_date","payment_link"]',
       updated_at = datetime('now')
 WHERE id = 'nt-invoice-past-due-sms';

INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes, send_time, phase, sort_order, created_at, updated_at)
VALUES
  ('nt-invoice-past-due-email', 'invoice_past_due', 'Past Due Notice Email', 'client', 'email',
   'Invoice #{{invoice_number}} is past due',
   'Invoice #{{invoice_number}} for {{invoice_amount}} was due on {{due_date}}. Pay here: {{payment_link}} Call us if you have questions.',
   '["invoice_number","invoice_amount","due_date","payment_link"]', 1, 0, NULL, 'financial', 20, datetime('now'), datetime('now')),
  ('nt-invoice-late-fee-sms', 'invoice_late_fee_added', 'Late Fee Added SMS', 'client', 'sms', NULL,
   'A one-time late fee of {{late_fee_amount}} (5%) was added to invoice #{{invoice_number}}. The new balance is {{invoice_amount}}. Pay here: {{payment_link}}',
   '["late_fee_amount","invoice_number","invoice_amount","payment_link"]', 1, 0, NULL, 'financial', 27, datetime('now'), datetime('now')),
  ('nt-invoice-late-fee-email', 'invoice_late_fee_added', 'Late Fee Added Email', 'client', 'email',
   'Late fee added to invoice #{{invoice_number}}',
   'A one-time late fee of {{late_fee_amount}} (5%) was added to invoice #{{invoice_number}}. The new balance is {{invoice_amount}}. Pay here: {{payment_link}} Call us if you have questions.',
   '["late_fee_amount","invoice_number","invoice_amount","payment_link"]', 1, 0, NULL, 'financial', 28, datetime('now'), datetime('now'));

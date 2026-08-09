-- Dual-channel payment receipt: add SMS template (email already seeded in 0024)
-- and refresh email body to include method + date. Check/cash has no fee line;
-- payment_amount is fee-excluded (convenience fee lives on the payment row / pay page).
-- INSERT OR IGNORE / UPDATE keeps this idempotent for local + remote apply.

INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes, phase, sort_order, created_at, updated_at)
VALUES
  ('nt-payment-received-sms', 'payment_received', 'Payment Receipt SMS', 'client', 'sms',
   NULL,
   'CHS: Received your {{payment_method}} payment of {{payment_amount}} on {{payment_date}} for Invoice #{{invoice_number}}. Balance: {{remaining_balance}}.',
   '["invoice_number","payment_amount","payment_method","payment_date","remaining_balance"]',
   1, 0, 'financial', 42, datetime('now'), datetime('now'));

UPDATE notification_templates
SET
  body_template = 'We received your {{payment_method}} payment of {{payment_amount}} on {{payment_date}} for Invoice #{{invoice_number}}. Remaining balance: {{remaining_balance}}.',
  merge_fields = '["invoice_number","payment_amount","payment_method","payment_date","remaining_balance"]',
  updated_at = datetime('now')
WHERE id = 'nt-payment-received-email';

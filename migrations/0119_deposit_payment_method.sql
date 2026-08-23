-- Persist client's stated deposit method (intent only until Tony confirms).
ALTER TABLE estimates ADD COLUMN deposit_payment_method TEXT;
ALTER TABLE estimates ADD COLUMN deposit_method_selected_at TEXT;

-- Owner alert when client picks cash/check at Pay Deposit.
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes, send_time, phase, sort_order, created_at, updated_at)
VALUES
  (
    'nt-deposit-method-selected-email',
    'deposit_method_selected',
    'Deposit Method Selected Email',
    'owner',
    'email',
    'Deposit intent: {{deposit_method}} — {{client_name}}',
    'Hi Tony,

{{client_name}} selected {{deposit_method}} for their deposit on {{estimate_label}} ({{deposit_amount}}).

No job has been created yet — confirm receipt in the Estimate Builder with “Mark Deposit Received.”

Estimate: {{estimate_admin_link}}

— CHS Hub',
    '["client_name","deposit_method","estimate_label","deposit_amount","estimate_admin_link"]',
    1,
    0,
    NULL,
    'estimating',
    20,
    datetime('now'),
    datetime('now')
  ),
  (
    'nt-deposit-method-selected-inapp',
    'deposit_method_selected',
    'Deposit Method Selected',
    'owner',
    'in_app',
    NULL,
    '{{client_name}} selected {{deposit_method}} deposit ({{deposit_amount}}) on {{estimate_label}}. Mark received when collected.',
    '["client_name","deposit_method","estimate_label","deposit_amount"]',
    1,
    0,
    NULL,
    'estimating',
    21,
    datetime('now'),
    datetime('now')
  );

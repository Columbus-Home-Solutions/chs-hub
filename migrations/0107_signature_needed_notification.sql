-- Signature-needed client notifications (Resend / Twilio — not BoldSign's invite email).
-- Fired when a Service Agreement or Selection Approval is sent for embedded signing.
-- Dispatch still gated by NOTIFICATIONS_DISPATCH_MODE until flipped to live.

INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes, send_time, phase, sort_order, created_at, updated_at)
VALUES
  (
    'nt-signature-needed-email',
    'signature_needed',
    'Signature Needed Email',
    'client',
    'email',
    'Signature needed — {{document_name}}',
    'Hi {{client_first_name}},

Your {{document_name}} is ready for your signature.

Sign now: {{sign_link}}

You can also open your estimate anytime here: {{estimate_link}}

— Columbus Home Solutions
{{company_phone}}',
    '["client_first_name","document_name","sign_link","estimate_link","company_phone"]',
    1,
    0,
    NULL,
    'estimating',
    7,
    datetime('now'),
    datetime('now')
  ),
  (
    'nt-signature-needed-sms',
    'signature_needed',
    'Signature Needed',
    'client',
    'sms',
    NULL,
    'Columbus Home Solutions: Please sign your {{document_name}}: {{sign_link}}',
    '["document_name","sign_link"]',
    1,
    0,
    NULL,
    'estimating',
    8,
    datetime('now'),
    datetime('now')
  );

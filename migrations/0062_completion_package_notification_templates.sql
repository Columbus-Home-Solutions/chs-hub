-- Sprint 32: completion package notification templates (post_job phase)

INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template,
   merge_fields, is_active, phase, sort_order, created_at, updated_at)
VALUES (
  lower(hex(randomblob(16))),
  'lien_waiver_sent',
  'Lien Waiver Sent',
  'internal',
  'in_app',
  NULL,
  'Lien waiver sent to {{client_name}} — awaiting signature for {{job_title}}',
  '["client_name","job_title"]',
  1, 'post_job', 10, datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template,
   merge_fields, is_active, phase, sort_order, created_at, updated_at)
VALUES (
  lower(hex(randomblob(16))),
  'completion_package_ready',
  'Completion Package Ready',
  'internal',
  'in_app',
  NULL,
  'Lien waiver signed — completion package ready to review for {{job_title}}',
  '["job_title"]',
  1, 'post_job', 11, datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template,
   merge_fields, is_active, phase, sort_order, created_at, updated_at)
VALUES (
  lower(hex(randomblob(16))),
  'completion_package_sent',
  'Completion Package — Client Email',
  'client',
  'email',
  'Your Project is Complete — Columbus Home Solutions',
  'Hi {{client_first_name}},

Your project is officially complete! Please find your completion package below, which includes:

• Your Limited Warranty Certificate (1-year workmanship warranty)
• Your final invoice
• Your signed lien waiver
• Before and after photos of your completed project

Your warranty is on file through {{warranty_expiry_date}}. If you ever have a concern about the work performed, don''t hesitate to reach out — we''ll make it right.

You can also view your full project documents anytime at your client portal:
{{portal_url}}

It was a pleasure working with you, {{client_first_name}}. We''d love to hear about your experience:
{{google_review_link}}

Thank you,
Tony Columbus
Columbus Home Solutions, LLC
(501) 551-1814 | tony@homesolutionsar.com',
  '["client_first_name","warranty_expiry_date","portal_url","google_review_link"]',
  1, 'post_job', 12, datetime('now'), datetime('now')
);

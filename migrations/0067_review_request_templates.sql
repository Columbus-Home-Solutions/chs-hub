-- Sprint 35: Google Review Request notification templates (6 rows: 3 triggers × 2 channels)

-- ─── google_review_request ─────────────────────────────────────────────────
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template,
   merge_fields, is_active, phase, sort_order, created_at, updated_at)
VALUES (
  'tmpl-google-review-request-sms',
  'google_review_request',
  'Google Review Request — SMS',
  'client',
  'sms',
  NULL,
  'Thanks for trusting Columbus Home Solutions with your project! Mind leaving us a quick Google review? It really helps other Central AR homeowners find us: {{review_link}} — Tony, CHS',
  '["review_link","client_first_name"]',
  1, 'post_job', 20, datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template,
   merge_fields, is_active, phase, sort_order, created_at, updated_at)
VALUES (
  'tmpl-google-review-request-email',
  'google_review_request',
  'Google Review Request — Email',
  'client',
  'email',
  'One quick favor — would you mind leaving us a review?',
  'Thank you again for trusting Columbus Home Solutions with your home project! If you''re happy with the results, would you mind leaving us a quick review on Google? It really helps other homeowners in the area find a contractor they can trust.

{{review_link}}

And if you''re part of any neighborhood groups or forums, a quick mention of your experience would mean the world to us. Thanks again for your support! — Tony',
  '["review_link","client_first_name"]',
  1, 'post_job', 21, datetime('now'), datetime('now')
);

-- ─── google_review_followup_1 (day 3) ─────────────────────────────────────
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template,
   merge_fields, is_active, phase, sort_order, created_at, updated_at)
VALUES (
  'tmpl-google-review-followup1-sms',
  'google_review_followup_1',
  'Google Review Follow-up 1 — SMS',
  'client',
  'sms',
  NULL,
  'Hi again — just a friendly reminder, we''d really appreciate a quick Google review when you get a chance: {{review_link}} Thanks! — Tony, CHS',
  '["review_link","client_first_name"]',
  1, 'post_job', 22, datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template,
   merge_fields, is_active, phase, sort_order, created_at, updated_at)
VALUES (
  'tmpl-google-review-followup1-email',
  'google_review_followup_1',
  'Google Review Follow-up 1 — Email',
  'client',
  'email',
  'Quick favor?',
  'Hi {{client_first_name}},

We hope you''re enjoying the finished {{job_title}} project! We wanted to follow up with a friendly reminder — if you have a moment, we''d really appreciate a quick Google review.

{{review_link}}

It only takes 30 seconds and makes a huge difference for other homeowners looking for a contractor they can trust. Thank you! — Tony',
  '["review_link","client_first_name","job_title"]',
  1, 'post_job', 23, datetime('now'), datetime('now')
);

-- ─── google_review_followup_2 (day 7) ─────────────────────────────────────
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template,
   merge_fields, is_active, phase, sort_order, created_at, updated_at)
VALUES (
  'tmpl-google-review-followup2-sms',
  'google_review_followup_2',
  'Google Review Follow-up 2 — SMS',
  'client',
  'sms',
  NULL,
  'One more ask — if you have 30 seconds, a Google review would mean a lot: {{review_link}} No worries if not, thanks either way! — Tony, CHS',
  '["review_link","client_first_name"]',
  1, 'post_job', 24, datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template,
   merge_fields, is_active, phase, sort_order, created_at, updated_at)
VALUES (
  'tmpl-google-review-followup2-email',
  'google_review_followup_2',
  'Google Review Follow-up 2 — Email',
  'client',
  'email',
  'Last reminder — and thank you either way',
  'Hi {{client_first_name}},

We truly appreciated working on your {{job_title}} project and hope you''re thrilled with the results. If you''ve had a chance to think about it, we''d be so grateful for a quick Google review:

{{review_link}}

Either way, thank you so much for choosing Columbus Home Solutions. It was a genuine pleasure working with you. — Tony',
  '["review_link","client_first_name","job_title"]',
  1, 'post_job', 25, datetime('now'), datetime('now')
);

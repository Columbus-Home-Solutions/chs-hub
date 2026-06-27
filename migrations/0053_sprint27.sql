-- Sprint 27: Redmond Sales Process Integrations
-- Adds columns for proposal review tracking and pre-appointment lead outreach sequence.
-- Seeds 9 new system_settings keys for outreach + post-visit templates.
--
-- Schema-already-exists guard (run before applying remotely):
--   SELECT name FROM pragma_table_info('estimate_requests') WHERE name='proposal_review_date';
-- Empty result = safe to apply. Row returned = already applied, skip.

-- ─── New columns on estimate_requests ────────────────────────────────────────

-- 1. Proposal review tracking (informational, no automation this sprint)
ALTER TABLE estimate_requests ADD COLUMN proposal_review_date TEXT;

-- 2. New lead pre-appointment outreach sequence state
ALTER TABLE estimate_requests ADD COLUMN lead_outreach_sequence_active INTEGER DEFAULT 0;
ALTER TABLE estimate_requests ADD COLUMN lead_outreach_count INTEGER DEFAULT 0;
ALTER TABLE estimate_requests ADD COLUMN last_outreach_date TEXT;
ALTER TABLE estimate_requests ADD COLUMN lead_outreach_completed_at TEXT;

-- ─── Seed outreach + post-visit message templates into system_settings ────────
-- INSERT OR IGNORE: keys are owned by Tony via the Settings UI once seeded.
-- Never reset or overwrite existing values on re-deploy.

INSERT OR IGNORE INTO system_settings (key, value, value_type, category, label, description) VALUES
  ('outreach_day1_sms', '', 'string', 'notifications', 'New Lead Outreach — Day 1 (SMS)',
   'Sent same day the lead comes in, if no appointment is set.'),
  ('outreach_day2_sms', '', 'string', 'notifications', 'New Lead Outreach — Day 2 (SMS)',
   'Sent on Day 2 after lead intake, if no appointment is set.'),
  ('outreach_day3_sms', '', 'string', 'notifications', 'New Lead Outreach — Day 3 (SMS)',
   'Final automated text. Sent on Day 3 if still no appointment. Sequence ends after this.'),
  ('post_visit_sms', '', 'string', 'notifications', 'Post-Visit Follow-Up (SMS)',
   'Sent when estimate visit is marked complete.'),
  ('post_visit_email_subject', '', 'string', 'notifications', 'Post-Visit Follow-Up — Email Subject',
   'Subject line for the post-visit follow-up email.'),
  ('post_visit_email_body', '', 'string', 'notifications', 'Post-Visit Follow-Up — Email Body',
   'Body for the post-visit follow-up email.');

UPDATE system_settings SET value = 'Hey {{client_first_name}}, this is Tony with Columbus Home Solutions. We just received your request and would love to chat about your {{job_type}} project. Do you have a few minutes to talk today?' WHERE key = 'outreach_day1_sms' AND (value IS NULL OR value = '');

UPDATE system_settings SET value = 'Hey {{client_first_name}}, it''s Tony again with Columbus Home Solutions. Just following up on the form you submitted about your {{job_type}} project. Is there a better time to reach you?' WHERE key = 'outreach_day2_sms' AND (value IS NULL OR value = '');

UPDATE system_settings SET value = 'Hey {{client_first_name}}, don''t mean to bug you — just wanted to reach out one more time about the {{job_type}} project you were interested in. Let me know if you''d like to chat!' WHERE key = 'outreach_day3_sms' AND (value IS NULL OR value = '');

UPDATE system_settings SET value = 'Hey {{client_first_name}}, it was great meeting with you today! We''re working on your estimate for the {{job_type}} project and will have it over to you within the next couple of days. Let us know if you have any questions in the meantime!' WHERE key = 'post_visit_sms' AND (value IS NULL OR value = '');

UPDATE system_settings SET value = 'Great Meeting With You Today — {{job_type}} Estimate Coming Soon' WHERE key = 'post_visit_email_subject' AND (value IS NULL OR value = '');

UPDATE system_settings SET value = 'Hello {{client_first_name}},

It was a pleasure meeting with you today at {{property_address}}!

Our team is now putting together your estimate for the {{job_type}} project. You can expect to receive it within the next 1–2 business days for your review.

If you have any questions in the meantime, don''t hesitate to reach out.

Tony Columbus
Columbus Home Solutions
501-263-2050' WHERE key = 'post_visit_email_body' AND (value IS NULL OR value = '');

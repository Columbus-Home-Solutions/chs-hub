-- Sprint 26: Quote Follow-Up Sequence
-- Adds two new columns to estimate_requests to track the automated follow-up sequence.
-- Seeds 8 system_settings keys for the 4 day-touch × 2 channel templates.
--
-- Schema-already-exists guard (run before applying remotely):
--   SELECT name FROM pragma_table_info('estimate_requests') WHERE name='follow_up_sequence_active';
-- Empty result = safe to apply. Row returned = already applied, skip.

-- ─── New columns on estimate_requests ────────────────────────────────────────

-- 1 when the sequence is running, 0 when stopped (won/lost/Day 10 passed).
-- Default 0 so existing rows are inactive until next cron scan.
ALTER TABLE estimate_requests ADD COLUMN follow_up_sequence_active INTEGER DEFAULT 0;

-- ISO 8601 timestamp when the sequence ended (won, lost, or exhausted).
-- NULL while still active.
ALTER TABLE estimate_requests ADD COLUMN follow_up_completed_at TEXT;

-- ─── Seed follow-up message templates into system_settings ───────────────────
-- INSERT OR IGNORE: these keys are owned by Tony via the Settings UI once seeded.
-- Never reset or overwrite existing values on re-deploy.

INSERT OR IGNORE INTO system_settings (key, value, value_type, category, label, description)
VALUES
  ('follow_up_day3_sms',
   'Just checking in on your estimate for {{job_type}} at {{property_address}}. Your quote is valid until {{expiration_date}}. View it here: {{estimate_link}}',
   'string', 'notifications', 'Day 3 Follow-Up (SMS)',
   'Sent 3 days after estimate delivery if no response.'),

  ('follow_up_day3_email',
   '{"subject":"Following up on your estimate","body":"Hi {{client_first_name}},\n\nJust wanted to check in on the estimate we sent for {{job_type}} at {{property_address}}. Your quote is valid until {{expiration_date}}.\n\nView and approve it here: {{estimate_link}}\n\nLet me know if you have any questions!\n\nTony Columbus\nColumbus Home Solutions\n501-263-2050"}',
   'json', 'notifications', 'Day 3 Follow-Up (Email)',
   'Sent 3 days after estimate delivery if no response.'),

  ('follow_up_day5_sms',
   'Hi {{client_first_name}}, wanted to follow up on your estimate for {{job_type}}. Any questions I can answer? {{estimate_link}}',
   'string', 'notifications', 'Day 5 Follow-Up (SMS)',
   'Sent 5 days after estimate delivery if no response.'),

  ('follow_up_day5_email',
   '{"subject":"Still thinking it over?","body":"Hi {{client_first_name}},\n\nI wanted to follow up on your estimate for {{job_type}} at {{property_address}}. Happy to answer any questions or walk you through the scope.\n\nView your estimate here: {{estimate_link}}\n\nTony Columbus\nColumbus Home Solutions\n501-263-2050"}',
   'json', 'notifications', 'Day 5 Follow-Up (Email)',
   'Sent 5 days after estimate delivery if no response.'),

  ('follow_up_day7_sms',
   'Hi {{client_first_name}}, your estimate for {{job_type}} expires soon. Ready to move forward? {{estimate_link}}',
   'string', 'notifications', 'Day 7 Follow-Up (SMS)',
   'Sent 7 days after estimate delivery if no response.'),

  ('follow_up_day7_email',
   '{"subject":"Your estimate is expiring soon","body":"Hi {{client_first_name}},\n\nYour estimate for {{job_type}} at {{property_address}} is expiring soon. If you''re ready to move forward, you can approve and pay your deposit here: {{estimate_link}}\n\nIf you have questions or need to adjust the timeline, just reply to this email.\n\nTony Columbus\nColumbus Home Solutions\n501-263-2050"}',
   'json', 'notifications', 'Day 7 Follow-Up (Email)',
   'Sent 7 days after estimate delivery if no response.'),

  ('follow_up_day10_sms',
   'Hi {{client_first_name}}, this is our final follow-up on your estimate for {{job_type}}. Let us know if you''d like to move forward: {{estimate_link}}',
   'string', 'notifications', 'Day 10 Follow-Up (SMS)',
   'Final follow-up sent 10 days after estimate delivery.'),

  ('follow_up_day10_email',
   '{"subject":"Final follow-up on your estimate","body":"Hi {{client_first_name}},\n\nThis is our last follow-up on the estimate for {{job_type}} at {{property_address}}. We''d love the opportunity to work with you — if you''re ready to move forward or have questions, please reach out.\n\nView your estimate: {{estimate_link}}\n\nTony Columbus\nColumbus Home Solutions\n501-263-2050"}',
   'json', 'notifications', 'Day 10 Follow-Up (Email)',
   'Final follow-up. Sequence ends after this touch.');

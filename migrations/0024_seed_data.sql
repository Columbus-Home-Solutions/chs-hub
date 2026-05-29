-- 0024_seed_data.sql
-- Sprint 1 — Seed data (CHS-Seed-Data.md): system_settings defaults, owner
-- user record, notification_templates catalog, saved_reviews placeholders.
-- All inserts are idempotent (INSERT OR IGNORE / guarded inserts).

-- ─────────────────────────────────────────────────────────────────────────
-- 6a. System Settings
-- ─────────────────────────────────────────────────────────────────────────

-- Financial settings
INSERT OR IGNORE INTO system_settings (key, value, value_type, category, label, description, updated_at) VALUES
  ('labor_rate_general', '90.00', 'number', 'financial', 'General Labor Rate ($/hr)', 'Hourly rate for general labor', datetime('now')),
  ('labor_rate_pm_skilled', '105.00', 'number', 'financial', 'PM / Skilled Carpenter Rate ($/hr)', 'Hourly rate for PM or skilled carpenter work', datetime('now')),
  ('pm_fee_rate', '0.10', 'number', 'financial', 'Project Management Fee (cost-plus)', 'PM fee applied on cost-plus jobs', datetime('now')),
  ('contractor_fee_rate', '0.20', 'number', 'financial', 'Contractor Fee (cost-plus)', 'Contractor fee applied on cost-plus jobs', datetime('now')),
  ('late_fee_daily', '50.00', 'number', 'financial', 'Late Fee ($/day)', 'Daily late fee after grace period', datetime('now')),
  ('late_fee_grace_days', '7', 'number', 'financial', 'Late Fee Grace Period (days)', 'Days after due date before late fees accrue', datetime('now')),
  ('convenience_fee_rate', '0.035', 'number', 'financial', 'Electronic Payment Convenience Fee', 'Fee on credit card and ACH payments', datetime('now')),
  ('default_deposit_percentage', '33.30', 'number', 'financial', 'Default First Milestone (fixed price)', 'Default deposit percentage for fixed-price jobs', datetime('now')),
  ('cost_plus_deposit', '1000.00', 'number', 'financial', 'Cost-Plus Default Deposit ($)', 'Default deposit amount for cost-plus jobs', datetime('now')),
  ('irs_mileage_rate', '0.70', 'number', 'financial', 'IRS Standard Mileage Rate (2026)', 'IRS standard mileage deduction rate', datetime('now')),
  ('default_quote_validity_days', '7', 'number', 'financial', 'Quote Validity Period (days)', 'Default number of days a quote stays valid', datetime('now')),
  ('billing_cycle_duration_days', '14', 'number', 'financial', 'Cost-Plus Billing Cycle Length', 'Length of a cost-plus billing cycle in days', datetime('now')),
  ('cost_plus_final_cycle_upfront', '0.50', 'number', 'financial', 'Final Cycle Upfront Percentage', 'Upfront percentage billed on the final cost-plus cycle', datetime('now'));

-- Company settings
INSERT OR IGNORE INTO system_settings (key, value, value_type, category, label, description, updated_at) VALUES
  ('company_name', 'Columbus Home Solutions, LLC', 'string', 'company', 'Company Name', 'Legal company name', datetime('now')),
  ('company_address', '4414 North Olive Street, North Little Rock, AR 72116', 'string', 'company', 'Company Address', 'Primary business address', datetime('now')),
  ('company_phone', '(501) 551-1814', 'string', 'company', 'Company Phone', 'Primary business phone', datetime('now')),
  ('company_email', 'tony@homesolutionsar.com', 'string', 'company', 'Company Email', 'Primary business email', datetime('now')),
  ('company_website', 'www.homesolutionsar.com', 'string', 'company', 'Company Website', 'Company website URL', datetime('now')),
  ('company_primary_color', '#F59E0B', 'string', 'company', 'Brand Primary Color', 'Primary brand color (hex)', datetime('now')),
  ('default_state', 'Arkansas', 'string', 'company', 'Default State for Forms', 'Default state used on forms', datetime('now')),
  ('warranty_duration_days', '365', 'number', 'company', 'Standard Warranty Duration', 'Standard warranty length in days', datetime('now')),
  ('warranty_reminder_days', '335', 'number', 'company', 'Warranty Reminder (days after completion)', 'Days after completion to send warranty reminder', datetime('now')),
  ('thirty_day_followup_days', '30', 'number', 'company', 'Post-Job Follow-Up (days after completion)', 'Days after completion for post-job follow-up', datetime('now'));

-- ─────────────────────────────────────────────────────────────────────────
-- 6b. Owner User Record
-- The existing chs-hub `users` table predates the unified schema (single
-- `name` column, NOT NULL created_at). Update Tony's record if present;
-- otherwise insert a complete row that satisfies the legacy NOT NULL columns.
-- ─────────────────────────────────────────────────────────────────────────

UPDATE users
SET role = 'owner',
    is_active = 1,
    first_name = COALESCE(first_name, 'Tony'),
    last_name = COALESCE(last_name, 'Columbus')
WHERE email = 'tony@homesolutionsar.com';

INSERT INTO users (id, email, name, first_name, last_name, phone, role, is_active, created_at, updated_at)
SELECT
  '00000000-0000-0000-0000-000000000001',
  'tony@homesolutionsar.com',
  'Tony Columbus',
  'Tony',
  'Columbus',
  '5015511814',
  'owner',
  1,
  datetime('now'),
  datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'tony@homesolutionsar.com');

-- ─────────────────────────────────────────────────────────────────────────
-- 6c. Notification Templates (full catalog)
-- delay_minutes is stored in minutes throughout; the long post-job delays from
-- the seed doc (listed in seconds) are converted to minutes here.
-- ─────────────────────────────────────────────────────────────────────────

-- Estimating Pipeline
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes, send_time, phase, sort_order, created_at, updated_at)
VALUES
  ('nt-lead-created-sms', 'lead_created', 'Lead Acknowledgment', 'client', 'sms', NULL,
   'Thank you for reaching out to Columbus Home Solutions! We''ve received your request and will be in touch within 24 hours.',
   '[]', 1, 0, NULL, 'estimating', 1, datetime('now'), datetime('now')),
  ('nt-lead-created-email', 'lead_created', 'Lead Acknowledgment Email', 'client', 'email', 'We received your request — Columbus Home Solutions',
   'Thank you for reaching out to Columbus Home Solutions! We''ve received your request and will be in touch within 24 hours. Columbus Home Solutions — (501) 551-1814 — www.homesolutionsar.com',
   '[]', 1, 0, NULL, 'estimating', 2, datetime('now'), datetime('now')),
  ('nt-appointment-confirmed-sms', 'appointment_confirmed', 'Appointment Confirmation', 'client', 'sms', NULL,
   'Your estimate appointment is confirmed for {{appointment_date}} at {{appointment_time}}. We''ll see you at {{property_address}}.',
   '["appointment_date","appointment_time","property_address"]', 1, 0, NULL, 'estimating', 3, datetime('now'), datetime('now')),
  ('nt-appointment-confirmed-email', 'appointment_confirmed', 'Appointment Confirmation Email', 'client', 'email', 'Estimate Appointment Confirmed',
   'Your estimate appointment is confirmed for {{appointment_date}} at {{appointment_time}} at {{property_address}}. Columbus Home Solutions — (501) 551-1814 — www.homesolutionsar.com',
   '["appointment_date","appointment_time","property_address"]', 1, 0, NULL, 'estimating', 4, datetime('now'), datetime('now')),
  ('nt-appointment-reminder-sms', 'appointment_reminder', 'Appointment Reminder', 'client', 'sms', NULL,
   'Reminder: Your estimate appointment with Columbus Home Solutions is tomorrow at {{appointment_time}} at {{property_address}}.',
   '["appointment_time","property_address"]', 1, -1440, NULL, 'estimating', 5, datetime('now'), datetime('now')),
  ('nt-estimate-sent-sms', 'estimate_sent', 'Estimate Ready', 'client', 'sms', NULL,
   'Your estimate for {{job_title}} is ready for review. View and approve here: {{estimate_link}}',
   '["job_title","estimate_link"]', 1, 0, NULL, 'estimating', 6, datetime('now'), datetime('now')),
  ('nt-estimate-sent-email', 'estimate_sent', 'Estimate Ready Email', 'client', 'email', 'Your Estimate is Ready — {{job_title}}',
   'Your estimate for {{job_title}} is ready. View and approve here: {{estimate_link}}',
   '["job_title","estimate_link"]', 1, 0, NULL, 'estimating', 7, datetime('now'), datetime('now')),
  ('nt-quote-follow-up-1-sms', 'quote_follow_up_1', 'Quote Follow-Up Day 3', 'client', 'sms', NULL,
   'Just checking in on your estimate for {{job_title}}. Your quote is valid until {{expiration_date}}. View here: {{estimate_link}}',
   '["job_title","expiration_date","estimate_link"]', 1, 4320, NULL, 'estimating', 8, datetime('now'), datetime('now')),
  ('nt-quote-follow-up-2-sms', 'quote_follow_up_2', 'Quote Follow-Up Day 5', 'client', 'sms', NULL,
   'Hi {{client_first_name}}, wanted to follow up on your estimate. Let me know if you have any questions. {{estimate_link}}',
   '["client_first_name","estimate_link"]', 1, 7200, NULL, 'estimating', 9, datetime('now'), datetime('now')),
  ('nt-quote-expiring-sms', 'quote_expiring', 'Quote Expiration Warning', 'client', 'sms', NULL,
   'Your estimate for {{job_title}} expires today. If you''d like to move forward, approve and pay your deposit here: {{estimate_link}}',
   '["job_title","estimate_link"]', 1, 10080, NULL, 'estimating', 10, datetime('now'), datetime('now'));

-- Job Pipeline
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes, send_time, phase, sort_order, created_at, updated_at)
VALUES
  ('nt-deposit-received-email', 'deposit_received', 'Payment Receipt (Deposit)', 'client', 'email', 'Payment Received — {{job_title}}',
   'Payment of {{deposit_amount}} received. Welcome aboard!',
   '["job_title","deposit_amount"]', 1, 0, NULL, 'job', 11, datetime('now'), datetime('now')),
  ('nt-welcome-portal-email', 'welcome_portal', 'Welcome & Portal Link', 'client', 'email', 'Welcome to Your Project Portal — {{job_title}}',
   'Welcome to your project portal for {{job_title}}. Access it any time here: {{portal_link}}. Here''s what to expect next.',
   '["job_title","portal_link"]', 1, 0, NULL, 'job', 12, datetime('now'), datetime('now')),
  ('nt-work-starting-sms', 'work_starting', 'Work Starts Tomorrow', 'client', 'sms', NULL,
   'Work begins tomorrow at {{property_address}}! Our crew will arrive between 7-8 AM. Contact us with any questions.',
   '["property_address"]', 1, 0, '18:00', 'job', 13, datetime('now'), datetime('now')),
  ('nt-weekly-photo-summary-email', 'weekly_photo_summary', 'Weekly Photo Summary', 'client', 'email', 'This Week on Your Project — {{job_title}}',
   'Here''s a summary of this week''s progress on {{job_title}}: {{photo_summary_link}}',
   '["job_title","photo_summary_link"]', 1, 0, NULL, 'job', 14, datetime('now'), datetime('now')),
  ('nt-cost-plus-cycle-report-email', 'cost_plus_cycle_report', 'Bi-Weekly Cycle Report', 'client', 'email', 'Project Report — {{job_title}} — Cycle {{cycle_number}}',
   'Your latest project report for {{job_title}} (Cycle {{cycle_number}}) is ready: {{cycle_report_link}}',
   '["job_title","cycle_number","cycle_report_link"]', 1, 0, NULL, 'job', 15, datetime('now'), datetime('now')),
  ('nt-job-completion-package-email', 'job_completion_package', 'Completion Package', 'client', 'email', 'Your Project is Complete! — {{job_title}}',
   'Your project {{job_title}} is complete! View your completion package here: {{completion_package_link}}',
   '["job_title","completion_package_link"]', 1, 0, NULL, 'job', 16, datetime('now'), datetime('now'));

-- Financial
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes, send_time, phase, sort_order, created_at, updated_at)
VALUES
  ('nt-payment-received-email', 'payment_received', 'Payment Receipt', 'client', 'email', 'Payment Received — Invoice #{{invoice_number}}',
   'We received your payment of {{payment_amount}} on Invoice #{{invoice_number}}. Remaining balance: {{remaining_balance}}.',
   '["invoice_number","payment_amount","remaining_balance"]', 1, 0, NULL, 'financial', 17, datetime('now'), datetime('now')),
  ('nt-invoice-due-reminder-sms', 'invoice_due_reminder', 'Invoice Due Reminder SMS', 'client', 'sms', NULL,
   'Friendly reminder: Invoice #{{invoice_number}} for {{invoice_amount}} is due on {{due_date}}. Pay here: {{payment_link}}',
   '["invoice_number","invoice_amount","due_date","payment_link"]', 1, -2880, NULL, 'financial', 18, datetime('now'), datetime('now')),
  ('nt-invoice-due-reminder-email', 'invoice_due_reminder', 'Invoice Due Reminder Email', 'client', 'email', 'Upcoming Payment Due — Invoice #{{invoice_number}}',
   'Invoice #{{invoice_number}} for {{invoice_amount}} is due on {{due_date}}. Pay here: {{payment_link}}',
   '["invoice_number","invoice_amount","due_date","payment_link"]', 1, -2880, NULL, 'financial', 19, datetime('now'), datetime('now')),
  ('nt-invoice-past-due-sms', 'invoice_past_due', 'Past Due Notice', 'client', 'sms', NULL,
   'Invoice #{{invoice_number}} for {{invoice_amount}} is past due. A late fee of $50/day is accruing per contract terms. Pay here: {{payment_link}}',
   '["invoice_number","invoice_amount","payment_link"]', 1, 0, NULL, 'financial', 20, datetime('now'), datetime('now'));

-- Post-Job
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes, send_time, phase, sort_order, created_at, updated_at)
VALUES
  ('nt-review-request-sms', 'review_request', 'Google Review Request', 'client', 'sms', NULL,
   'We hope you''re enjoying your new {{job_type}}! If you''re happy with our work, a Google review helps other homeowners find us: {{review_link}}',
   '["job_type","review_link"]', 1, 0, NULL, 'post_job', 21, datetime('now'), datetime('now')),
  ('nt-thirty-day-followup-sms', 'thirty_day_followup', '30-Day Follow-Up', 'client', 'sms', NULL,
   'Hi {{client_first_name}}, how''s everything holding up with {{job_title}}? Let us know if you need anything!',
   '["client_first_name","job_title"]', 1, 43200, NULL, 'post_job', 22, datetime('now'), datetime('now')),
  ('nt-warranty-reminder-email', 'warranty_reminder', '11-Month Warranty Reminder', 'client', 'email', 'Your Warranty is Approaching Its End — {{job_title}}',
   'Your warranty for {{job_title}} is approaching its end. Contact us if you need anything: (501) 551-1814.',
   '["job_title"]', 1, 482400, NULL, 'post_job', 23, datetime('now'), datetime('now'));

-- Subcontractor
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes, send_time, phase, sort_order, created_at, updated_at)
VALUES
  ('nt-sub-scheduled-sms', 'sub_scheduled', 'Sub Scheduling', 'subcontractor', 'sms', NULL,
   'You''ve been scheduled for {{trade_or_work}} at {{property_address}} on {{scheduled_date}} from {{start_time}} to {{end_time}}. Notes: {{notes}}',
   '["trade_or_work","property_address","scheduled_date","start_time","end_time","notes"]', 1, 0, NULL, 'job', 24, datetime('now'), datetime('now')),
  ('nt-sub-schedule-change-sms', 'sub_schedule_change', 'Sub Schedule Change', 'subcontractor', 'sms', NULL,
   'Schedule update: Your work at {{property_address}} has been changed to {{new_date}} {{new_time}}. Notes: {{notes}}',
   '["property_address","new_date","new_time","notes"]', 1, 0, NULL, 'job', 25, datetime('now'), datetime('now')),
  ('nt-sub-schedule-cancelled-sms', 'sub_schedule_cancelled', 'Sub Schedule Cancelled', 'subcontractor', 'sms', NULL,
   'Schedule cancelled: Your work at {{property_address}} on {{scheduled_date}} has been cancelled. {{reason}}',
   '["property_address","scheduled_date","reason"]', 1, 0, NULL, 'job', 26, datetime('now'), datetime('now'));

-- ─────────────────────────────────────────────────────────────────────────
-- 6d. Saved Reviews (placeholders — replace with real Google reviews pre-launch)
-- ─────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO saved_reviews (id, reviewer_name, review_date, rating, review_text, source, is_active, sort_order, created_at) VALUES
('rev-001', 'Sarah M.', '2025-11-15', 5, 'Tony and his team did an incredible job on our garage conversion. Professional from start to finish, always on time, and the quality of work exceeded our expectations. Highly recommend Columbus Home Solutions!', 'google', 1, 1, datetime('now')),
('rev-002', 'James & Linda K.', '2025-09-22', 5, 'We hired CHS for a full bathroom remodel and could not be happier. Tony kept us informed every step of the way with photos and updates. The finished product looks amazing. Fair pricing and honest work.', 'google', 1, 2, datetime('now')),
('rev-003', 'Marcus D.', '2026-01-08', 5, 'Columbus Home Solutions built a beautiful deck for us. The crew was respectful of our property, cleaned up every day, and finished ahead of schedule. Tony is the kind of contractor you can trust. Five stars.', 'google', 1, 3, datetime('now'));

-- Sprint 31 Run 2 — notification template for receipt line-item match review (Sprint 30).
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes, phase, sort_order, created_at, updated_at)
VALUES
  ('nt-receipt-match-review-sms', 'receipt_match_review', 'Receipt Match Review', 'owner', 'sms', NULL,
   'Receipt uploaded for {{job_title}} has items that need your review. Tap to assign: {{review_link}}',
   '["job_title","review_link","unresolved_count"]', 1, 0, 'financial', 60, datetime('now'), datetime('now'));

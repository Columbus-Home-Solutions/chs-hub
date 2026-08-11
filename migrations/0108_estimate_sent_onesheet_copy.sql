-- Point estimate_sent email body at the One Sheet + Price Match attachments.
-- SMS template intentionally unchanged.

UPDATE notification_templates
SET body_template =
  'Your estimate for {{job_title}} is ready. View and approve here: {{estimate_link}}' || char(10) || char(10) ||
  'Before you decide, take a look at what makes us different — attached is our One Sheet (see how we compare to typical contractors) and our Price Match Guarantee, backed by a 5-year workmanship warranty most companies won''t match.' || char(10) || char(10) ||
  'Financing is available through our partner Wisetack. Check your options in seconds with no impact to your credit score: https://wisetack.us/#/g1wjjq5/prequalify',
    updated_at = datetime('now')
WHERE id = 'nt-estimate-sent-email'
  AND trigger_event = 'estimate_sent'
  AND channel = 'email';

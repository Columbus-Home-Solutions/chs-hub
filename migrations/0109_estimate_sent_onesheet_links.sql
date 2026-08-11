-- Make "One Sheet" / "Price Match Guarantee" clickable in estimate_sent email.
-- Public host = APP_PUBLIC_ORIGIN (client.homesolutionsar.com); dashboard.* is Access-gated.
-- SMS unchanged. Attachments unchanged (still attached by notification-engine).

UPDATE notification_templates
SET body_template =
  'Your estimate for {{job_title}} is ready. View and approve here: {{estimate_link}}' || char(10) || char(10) ||
  'Before you decide, take a look at what makes us different — attached is our <a href="https://client.homesolutionsar.com/api/public/company-assets/one-sheet">One Sheet</a> (see how we compare to typical contractors) and our <a href="https://client.homesolutionsar.com/api/public/company-assets/price-match-guarantee">Price Match Guarantee</a>, backed by a 5-year workmanship warranty most companies won''t match.' || char(10) || char(10) ||
  'Financing is available through our partner Wisetack. Check your options in seconds with no impact to your credit score: https://wisetack.us/#/g1wjjq5/prequalify',
    updated_at = datetime('now')
WHERE id = 'nt-estimate-sent-email'
  AND trigger_event = 'estimate_sent'
  AND channel = 'email';

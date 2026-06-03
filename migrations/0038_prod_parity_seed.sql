-- 0038_prod_parity_seed.sql  (Sprint 17)
--
-- Prod-parity seed: nine rows that were hand-inserted at deploy (S14→S16) and
-- never committed to a migration, so a FRESH DB build did not match prod. This
-- migration makes a fresh build match prod for those rows.
--
-- ADDITIVE + IDEMPOTENT: every statement is `INSERT OR IGNORE`, keyed by the
-- exact ids/keys already present on prod. On prod (rows present) this is a
-- NO-OP; on a fresh build it inserts exactly the missing rows. NEVER use
-- INSERT OR REPLACE here — that would clobber live-tuned values.
--
-- Direct-execute only on remote (NEVER `wrangler d1 migrations apply --remote`;
-- the ledger records 0001–0013 only — Sprint 6 deviation 1). Local apply:
--   npx wrangler d1 execute chs-hub-db --local --file=migrations/0038_prod_parity_seed.sql
--
-- Contents (9 rows):
--   • 5 document_templates  (S15: Service Agreement, Cost-Plus Agreement,
--     Change Order, Lien Waiver, Warranty Certificate) — ids seed-tpl-s15-*.
--   • 1 notification_templates (completion-package; reconciled key
--     `completion_package_sent` — the key the live send path fires) — seed-ntpl-s15-cp.
--   • 3 system_settings (S16 social): social_brand_voice, social_publish_mode
--     (SIMULATE), social_image_gen_count.
--
-- Data seed only — no schema change.

-- ── 5 document templates (S15) ───────────────────────────────────────────────
INSERT OR IGNORE INTO document_templates (id, name, template_type, content, merge_fields, is_active, version)
VALUES
  ('seed-tpl-s15-service', 'Service Agreement', 'service_agreement',
   '{{company_name}}
SERVICE AGREEMENT
Residential Construction & Remodeling

Client: {{client_name}}
Property Address: {{property_address}}
Project: {{job_title}}
Contract Total: {{contract_total}}
Date: {{today_date}}

This Service Agreement is entered into between {{company_name}} ("Contractor") and the Client named above for the construction and/or remodeling work described in the attached Estimate and Scope of Work.

1. SCOPE OF WORK
Contractor will perform the work described in the project estimate and scope of work attached to this Agreement. Any work not explicitly described is not included in the contract price.

4. PAYMENT TERMS
The total contract price is {{contract_total}}, payable according to the following schedule:
{{payment_schedule}}
All invoices are due within seven (7) days of receipt.

8. WARRANTY
Contractor provides a one-year workmanship warranty on completed work beginning at project completion.

By signing below (in person or electronically), both parties agree to all terms stated in this document. This Agreement is governed by the laws of the State of Arkansas.',
   '["company_name","client_name","property_address","job_title","contract_total","today_date","payment_schedule"]', 1, 1),

  ('seed-tpl-s15-costplus', 'Cost-Plus Billing Agreement', 'cost_plus_agreement',
   '{{company_name}}
COST-PLUS BILLING AGREEMENT
Pay-As-You-Progress Construction Billing

Client: {{client_name}}
Property Address: {{property_address}}
Project: {{job_title}}
Estimated Total: {{contract_total}} (estimate only — actual costs billed at cost)
Date: {{today_date}}

1. HOW COST-PLUS PRICING WORKS
You pay the actual cost of materials, labor, and subcontractors — plus a contractor fee. There is no markup on materials or subcontractor costs.

4. DEPOSIT & FINAL PAYMENT
A deposit of {{deposit_amount}} is required to schedule the project and is applied toward total project costs.

This Cost-Plus Billing Agreement is supplemental to the Service Agreement and is governed by the laws of the State of Arkansas.',
   '["company_name","client_name","property_address","job_title","contract_total","deposit_amount","today_date"]', 1, 1),

  ('seed-tpl-s15-changeorder', 'Change Order', 'change_order',
   '{{company_name}}
CHANGE ORDER

Client: {{client_name}}
Property Address: {{property_address}}
Project: {{job_title}}
Date: {{today_date}}

This Change Order documents a modification to the agreed scope of work, including the change described, its cost impact, and any effect on the project timeline. It requires Client signature before the modified work proceeds.',
   '["company_name","client_name","property_address","job_title","today_date"]', 1, 1),

  ('seed-tpl-s15-lienwaiver', 'Lien Waiver', 'lien_waiver',
   '{{company_name}}
LIEN WAIVER AND RELEASE

Project: {{job_title}}
Property Address: {{property_address}}
Subcontractor: {{sub_name}}
Waiver Type: {{waiver_type}}
Payment Amount: {{payment_amount}}
Date: {{today_date}}

The undersigned subcontractor acknowledges receipt of the payment amount stated above and, to that extent, waives and releases any mechanic''s lien, stop-payment notice, or bond right against the property described above for labor and materials furnished through the date of this waiver.',
   '["company_name","job_title","property_address","sub_name","waiver_type","payment_amount","today_date"]', 1, 1),

  ('seed-tpl-s15-warranty', 'Warranty Certificate', 'other',
   '{{company_name}}
CERTIFICATE OF WARRANTY

Client: {{client_name}}
Property Address: {{property_address}}
Project: {{job_title}}
Issued: {{today_date}}

{{company_name}} warrants the workmanship of the completed project described above for a period of one (1) year from the date of project completion, covering defects in workmanship (excluding normal wear, owner/third-party damage, improper maintenance, and manufacturer-covered material defects).',
   '["company_name","client_name","property_address","job_title","today_date"]', 1, 1);

-- ── 1 completion-package notification template (reconciled key) ───────────────
-- Sprint 17 decision: keep the code's `completion_package_sent` (avoids touching
-- the live send path in routes/completion-package.ts). The older
-- `job_completion_package` template/key is deprecated in favor of this one.
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes, phase, sort_order)
VALUES
  ('seed-ntpl-s15-cp', 'completion_package_sent', 'Completion Package Ready', 'client', 'email',
   'Your project completion package is ready',
   'Hi {{client_name}}, your completion package for {{job_title}} is ready: {{portal_link}}',
   '["client_name","job_title","portal_link"]', 1, 0, 'closeout', 90);

-- ── 3 social system_settings (S16) — respect value_type CHECK ─────────────────
INSERT OR IGNORE INTO system_settings (key, value, value_type, category, label, description)
VALUES
  ('social_brand_voice',
   'You write social media posts for Columbus Home Solutions, a residential remodeling and home-improvement contractor serving central Arkansas (Little Rock, North Little Rock, Conway, and the surrounding area). The voice is professional, warm, and genuinely proud of quality craftsmanship. You speak to local homeowners as a trustworthy neighbor, never salesy or spammy. Keep it concise and authentic.',
   'string', 'social', 'Brand voice', 'System prompt persona for AI caption + hashtag generation.'),
  ('social_publish_mode', 'SIMULATE', 'string', 'social', 'Publish mode',
   'SIMULATE = log only, never call Graph API. LIVE = post for real (do not flip locally).'),
  ('social_image_gen_count', '{}', 'json', 'social', 'Image generation count',
   'Monthly AI image-generation counter for cost monitoring.');

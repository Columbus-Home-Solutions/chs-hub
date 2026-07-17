-- 0091_wc_marketing_column_mapping.sql
-- Correct Marketing Tallies column mappings for the live WC workbook layout
-- (Weekly Period spans A:B; financials at C:E; lead sources start at G).
--
-- Apply remotely:
--   npx wrangler d1 execute chs-hub-db --remote --file=migrations/0091_wc_marketing_column_mapping.sql

INSERT OR REPLACE INTO system_settings (key, value, value_type, category, label, description, updated_at)
VALUES
  ('wc_marketing_week_end_column', 'B', 'string', 'wc_spreadsheet', 'Marketing week end column',
   'Second column of the merged Weekly Period label (read-only for row matching).', datetime('now')),
  ('wc_marketing_financial_columns', 'C:E', 'string', 'wc_spreadsheet', 'Marketing financial columns',
   'New Sales, $ That Hit The Bank, Accounts Receivable (contiguous range).', datetime('now')),
  ('wc_marketing_lead_organic_column', 'G', 'string', 'wc_spreadsheet', 'Marketing organic leads column',
   'Organic Google Leads.', datetime('now')),
  ('wc_marketing_lead_adwords_column', 'H', 'string', 'wc_spreadsheet', 'Marketing adwords leads column',
   'Google Adwords Leads.', datetime('now')),
  ('wc_marketing_lead_lsa_column', 'J', 'string', 'wc_spreadsheet', 'Marketing LSA leads column',
   'Google Local Services Leads (skips manual ad-spend column I).', datetime('now')),
  ('wc_marketing_lead_facebook_column', 'L', 'string', 'wc_spreadsheet', 'Marketing Facebook leads column',
   'Facebook Leads (skips manual ad-spend column K).', datetime('now')),
  ('wc_marketing_lead_referral_column', 'N', 'string', 'wc_spreadsheet', 'Marketing referral leads column',
   'Referral leads.', datetime('now')),
  ('wc_marketing_lead_repeat_column', 'O', 'string', 'wc_spreadsheet', 'Marketing repeat leads column',
   'Repeat client leads.', datetime('now')),
  ('wc_marketing_lead_other_column', 'P', 'string', 'wc_spreadsheet', 'Marketing other leads column',
   'Other / unknown lead sources.', datetime('now')),
  ('wc_marketing_converted_column', 'R', 'string', 'wc_spreadsheet', 'Marketing converted column',
   'Deals converted this week (Converted % is a sheet formula).', datetime('now'));

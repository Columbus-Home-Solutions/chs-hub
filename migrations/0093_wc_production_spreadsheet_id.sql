-- 0093_wc_production_spreadsheet_id.sql
-- Point WC sync at the live Wealthy Contractor workbook (Tony's tracker).
-- Cron was writing to WC_TEST_SHEET_ID because wc_spreadsheet_id was blank.
--
-- Apply remotely:
--   npx wrangler d1 execute chs-hub-db --remote --file=migrations/0093_wc_production_spreadsheet_id.sql

INSERT OR REPLACE INTO system_settings (key, value, value_type, category, label, description, updated_at)
VALUES (
  'wc_spreadsheet_id',
  '1utmYdBkUM8cefQ-1mpEnhiyV-vVf-IOhN1yn_wfXyZo',
  'string',
  'wc_spreadsheet',
  'WC spreadsheet ID',
  'Google Sheets workbook ID for the live Wealthy Contractor tracker.',
  datetime('now')
);

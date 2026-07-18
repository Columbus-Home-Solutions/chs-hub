-- 0094_wc_marketing_tab_name_trim.sql
-- Production workbook tab has no trailing space; the stale setting did.
INSERT OR REPLACE INTO system_settings (key, value, value_type, category, label, description, updated_at)
VALUES (
  'wc_marketing_tab_name',
  'Weekly Marketing Tallies',
  'string',
  'wc_spreadsheet',
  'Marketing tab name',
  'Tab name for weekly marketing data (no trailing whitespace).',
  datetime('now')
);

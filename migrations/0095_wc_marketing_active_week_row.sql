-- 0095_wc_marketing_active_week_row.sql
-- Live workbook: week labels sit in merged cells that don't surface via A:B reads;
-- row 6 is the current-week data row for Jul 12–18 2026 (confirmed in task doc).
INSERT OR REPLACE INTO system_settings (key, value, value_type, category, label, description, updated_at)
VALUES (
  'wc_marketing_active_week_row',
  '6',
  'number',
  'wc_spreadsheet',
  'Marketing active week row',
  'Fallback sheet row for the current CT week when date-based discovery fails.',
  datetime('now')
);

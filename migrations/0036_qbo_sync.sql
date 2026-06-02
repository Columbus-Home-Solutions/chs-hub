-- 0036_qbo_sync.sql  (additive only) — Sprint 14
-- QBO push targets + reference-mapping ids + WC settings rows.
--
-- DO NOT run `wrangler d1 migrations apply` (ledger only records 0001–0013;
-- 0014+ are applied-but-unrecorded). Direct-execute this file:
--   npx wrangler d1 execute chs-hub-db --local --file=migrations/0036_qbo_sync.sql
--   (remote: add --remote, backup-first, per the remote-deploy runbook)

-- ── Push targets: store the QBO record id + sync state on everything we push
ALTER TABLE invoices ADD COLUMN qbo_invoice_id TEXT;
ALTER TABLE invoices ADD COLUMN qbo_synced_at  TEXT;
ALTER TABLE payments ADD COLUMN qbo_payment_id TEXT;
ALTER TABLE payments ADD COLUMN qbo_synced_at  TEXT;

-- ── Reference mapping: store the matched QBO entity id so pushes don't duplicate
ALTER TABLE clients        ADD COLUMN qbo_customer_id TEXT;
ALTER TABLE subcontractors ADD COLUMN qbo_vendor_id   TEXT;

-- ── Dedup/lookup indexes (partial UNIQUE so multiple un-synced NULLs are allowed)
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_qbo_id ON invoices(qbo_invoice_id) WHERE qbo_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_qbo_id ON payments(qbo_payment_id) WHERE qbo_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_unsynced ON invoices(qbo_synced_at) WHERE qbo_synced_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payments_unsynced ON payments(qbo_synced_at) WHERE qbo_synced_at IS NULL;

-- ── WC Spreadsheet config rows (Module-Spec-WC-Spreadsheet §7).
-- system_settings is the generic key/value store; these are config (ship to
-- prod), not local-only seed. INSERT OR IGNORE keeps it idempotent / delta-safe.
INSERT OR IGNORE INTO system_settings (key, value, value_type, category, label, description, updated_at) VALUES
  ('wc_sync_enabled',                   'true',                                    'boolean', 'wc_spreadsheet', 'WC sync enabled',                 'Master on/off switch for the WC Spreadsheet sync.', datetime('now')),
  ('wc_spreadsheet_id',                 '',                                        'string',  'wc_spreadsheet', 'WC spreadsheet ID',               'Google Sheets workbook ID. Leave blank in dev to use a test sheet via WC_TEST_SHEET_ID.', datetime('now')),
  ('wc_sync_interval_minutes',          '30',                                      'number',  'wc_spreadsheet', 'WC sync interval (min)',          'Informational — actual cron is in wrangler.toml.', datetime('now')),
  ('wc_kpi_tab_name',                   'Key Business Performance Indicators',     'string',  'wc_spreadsheet', 'KPI tab name',                    'Tab name for weekly KPI data.', datetime('now')),
  ('wc_kpi_week_start_column',          'A',                                       'string',  'wc_spreadsheet', 'KPI week-start column',           'Column with week start dates.', datetime('now')),
  ('wc_kpi_week_end_column',            'B',                                       'string',  'wc_spreadsheet', 'KPI week-end column',             'Column with week end dates.', datetime('now')),
  ('wc_kpi_data_columns',               'C:G',                                     'string',  'wc_spreadsheet', 'KPI data columns',                'New Sales, Collections, Leads, Appointments, Closed.', datetime('now')),
  ('wc_kpi_first_data_row',             '3',                                       'number',  'wc_spreadsheet', 'KPI first data row',              'First row with data (skip headers).', datetime('now')),
  ('wc_marketing_tab_name',             'Weekly Marketing Tallies',                'string',  'wc_spreadsheet', 'Marketing tab name',              'Tab name for weekly marketing tallies.', datetime('now')),
  ('wc_marketing_week_column',          'A',                                       'string',  'wc_spreadsheet', 'Marketing week column',           'Column with week period labels.', datetime('now')),
  ('wc_marketing_first_data_row',       '4',                                       'number',  'wc_spreadsheet', 'Marketing first data row',        'First row with data (skip headers).', datetime('now')),
  ('wc_monthly_tab_name',               'Monthly Net Profits',                     'string',  'wc_spreadsheet', 'Monthly tab name',                'Tab name for monthly profit data.', datetime('now')),
  ('wc_monthly_month_column',           'A',                                       'string',  'wc_spreadsheet', 'Monthly month column',            'Column with month labels.', datetime('now')),
  ('wc_monthly_data_columns',           'B:C',                                     'string',  'wc_spreadsheet', 'Monthly data columns',            'Total Income, Net Profits.', datetime('now')),
  ('wc_monthly_first_data_row',         '4',                                       'number',  'wc_spreadsheet', 'Monthly first data row',          'First data row (Jan).', datetime('now')),
  ('wc_monthly_last_data_row',          '15',                                      'number',  'wc_spreadsheet', 'Monthly last data row',           'Last data row (Dec).', datetime('now')),
  ('wc_monthly_prior_year_income_column','G',                                      'string',  'wc_spreadsheet', 'Monthly prior-year income column','Column for prior-year Total Income.', datetime('now')),
  ('wc_monthly_prior_year_profit_column','H',                                      'string',  'wc_spreadsheet', 'Monthly prior-year profit column','Column for prior-year Net Profits.', datetime('now'));

-- ── sync_log enrichment (additive, nullable). The WC rebuild logs a structured
-- snapshot (tabs_updated/failed, rows_matched, data_snapshot) per cycle; this
-- single JSON column carries it without disturbing existing jobber_full rows.
ALTER TABLE sync_log ADD COLUMN details TEXT;

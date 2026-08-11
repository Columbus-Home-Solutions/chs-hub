-- Go-live gate for CHS → QBO invoice push. Defaults OFF so historical Jobber
-- imports (and any future DLQ replay) cannot push invoices until Tony
-- explicitly enables push after real jobs are running through CHS.
INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
VALUES (
  'qbo_invoice_sync_enabled',
  'false',
  'boolean',
  'integrations',
  'Push invoices to QuickBooks',
  'When off, the QBO nightly sweep skips invoice pushes. Keep off until real CHS jobs are live. Jobber-imported invoices are permanently excluded regardless of this flag.',
  datetime('now')
)
ON CONFLICT(key) DO NOTHING;

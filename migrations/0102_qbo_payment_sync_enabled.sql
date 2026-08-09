-- Go-live gate for CHS → QBO payment push. Defaults OFF so historical Jobber
-- imports (and any future DLQ replay) cannot re-inflate QBO income until Tony
-- explicitly enables push after real jobs are running through CHS.
INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
VALUES (
  'qbo_payment_sync_enabled',
  'false',
  'boolean',
  'integrations',
  'Push payments to QuickBooks',
  'When off, the QBO nightly sweep and payment DLQ replay skip payment pushes. Keep off until real CHS jobs are live.',
  datetime('now')
)
ON CONFLICT(key) DO NOTHING;

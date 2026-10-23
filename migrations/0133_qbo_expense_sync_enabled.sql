-- Go-live gate for CHS → QBO expense push. Defaults OFF so nothing is pushed
-- until Tony explicitly enables it. ON CONFLICT DO NOTHING never overwrites
-- a value that was already set.
INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
VALUES (
  'qbo_expense_sync_enabled',
  'false',
  'boolean',
  'integrations',
  'Push expenses to QuickBooks',
  'When off, the QBO nightly sweep skips expense pushes. Keep off until real CHS jobs are live.',
  datetime('now')
)
ON CONFLICT(key) DO NOTHING;

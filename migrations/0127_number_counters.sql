-- Monotonic number counters for request / job / invoice numbers.
-- Seeded to MAX(column)+1 so the next allocate returns max+1 and deletes
-- never free a number for reuse. estimate_number already uses
-- system_settings.next_estimate_number (left alone).

INSERT OR IGNORE INTO system_settings
  (key, value, value_type, category, label, description, updated_at)
SELECT
  'next_request_number',
  CAST(COALESCE((SELECT MAX(request_number) FROM estimate_requests), 0) + 1 AS TEXT),
  'number',
  'estimating',
  'Next request number',
  'Durable counter for estimate_requests.request_number (never reuse after delete).',
  datetime('now');

INSERT OR IGNORE INTO system_settings
  (key, value, value_type, category, label, description, updated_at)
SELECT
  'next_job_number',
  CAST(COALESCE((SELECT MAX(job_number) FROM jobs), 0) + 1 AS TEXT),
  'number',
  'jobs',
  'Next job number',
  'Durable counter for jobs.job_number (never reuse after delete).',
  datetime('now');

INSERT OR IGNORE INTO system_settings
  (key, value, value_type, category, label, description, updated_at)
SELECT
  'next_invoice_number',
  CAST(COALESCE((SELECT MAX(invoice_number) FROM invoices), 0) + 1 AS TEXT),
  'number',
  'billing',
  'Next invoice number',
  'Durable counter for invoices.invoice_number (never reuse after delete).',
  datetime('now');

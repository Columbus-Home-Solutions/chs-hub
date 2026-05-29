-- 0014_schema_bridge.sql
-- Sprint 1 — Schema Bridge: extend existing chs-hub tables to the unified CHS
-- platform schema and create the new system tables.
--
-- Renumbered from the sprint doc's 0012 because 0012/0013 already exist in this
-- repo (job_files drive mirror + jobber source). This file continues the live
-- sequence at 0014.
--
-- IMPORTANT (SQLite / D1 constraints):
--   * SQLite ALTER TABLE ADD COLUMN cannot add NOT NULL columns without a
--     constant default, and cannot use non-constant defaults like
--     datetime('now'). Every added column below is therefore nullable (or has a
--     constant default). New code enforces required values at write time.
--   * Only columns genuinely missing from each table (verified via
--     PRAGMA table_info) are added here, so this migration is safe to run once.
--   * Existing columns are never dropped or renamed — all changes are additive.

-- ─────────────────────────────────────────────────────────────────────────
-- Part A: ALTER existing tables — add missing columns from the unified schema
-- ─────────────────────────────────────────────────────────────────────────

-- clients (existing: id, name, phone, email, address_street, address_city,
--           address_state, address_postal, custom_fields, synced_at)
ALTER TABLE clients ADD COLUMN first_name TEXT;
ALTER TABLE clients ADD COLUMN last_name TEXT;
ALTER TABLE clients ADD COLUMN phone_secondary TEXT;
ALTER TABLE clients ADD COLUMN mailing_address TEXT;
ALTER TABLE clients ADD COLUMN mailing_city TEXT;
ALTER TABLE clients ADD COLUMN mailing_state TEXT;
ALTER TABLE clients ADD COLUMN mailing_zip TEXT;
ALTER TABLE clients ADD COLUMN lead_source TEXT;
ALTER TABLE clients ADD COLUMN high_level_contact_id TEXT;
ALTER TABLE clients ADD COLUMN is_repeat_client INTEGER DEFAULT 0;
ALTER TABLE clients ADD COLUMN review_requested INTEGER DEFAULT 0;
ALTER TABLE clients ADD COLUMN google_review_left INTEGER DEFAULT 0;
ALTER TABLE clients ADD COLUMN notes TEXT;
ALTER TABLE clients ADD COLUMN last_interaction_date TEXT;
ALTER TABLE clients ADD COLUMN created_at TEXT;
ALTER TABLE clients ADD COLUMN updated_at TEXT;
ALTER TABLE clients ADD COLUMN created_by TEXT;

-- jobs (existing: id, job_number, title, status, client_id, source, total,
--       created_at, start_at, completed_at, synced_at)
ALTER TABLE jobs ADD COLUMN billing_model TEXT;
ALTER TABLE jobs ADD COLUMN property_address TEXT;
ALTER TABLE jobs ADD COLUMN property_city TEXT;
ALTER TABLE jobs ADD COLUMN property_state TEXT DEFAULT 'Arkansas';
ALTER TABLE jobs ADD COLUMN property_zip TEXT;
ALTER TABLE jobs ADD COLUMN job_type TEXT;
ALTER TABLE jobs ADD COLUMN lead_source TEXT;
ALTER TABLE jobs ADD COLUMN estimate_id TEXT;
ALTER TABLE jobs ADD COLUMN start_date TEXT;
ALTER TABLE jobs ADD COLUMN target_end_date TEXT;
ALTER TABLE jobs ADD COLUMN actual_end_date TEXT;
ALTER TABLE jobs ADD COLUMN contract_total REAL;
ALTER TABLE jobs ADD COLUMN deposit_amount REAL;
ALTER TABLE jobs ADD COLUMN deposit_paid INTEGER DEFAULT 0;
ALTER TABLE jobs ADD COLUMN portal_token TEXT;
ALTER TABLE jobs ADD COLUMN portal_type TEXT;
ALTER TABLE jobs ADD COLUMN notes TEXT;
ALTER TABLE jobs ADD COLUMN warranty_expiration TEXT;
ALTER TABLE jobs ADD COLUMN updated_at TEXT;
ALTER TABLE jobs ADD COLUMN created_by TEXT;

-- estimates (existing: id, lead_id, status, jobber_quote_id, extracted_scope,
--            extracted_items, line_items, subtotal, total, margin_percent,
--            created_at, created_by, updated_at, sent_at)
ALTER TABLE estimates ADD COLUMN estimate_number INTEGER;
ALTER TABLE estimates ADD COLUMN request_id TEXT;
ALTER TABLE estimates ADD COLUMN client_id TEXT;
ALTER TABLE estimates ADD COLUMN title TEXT;
ALTER TABLE estimates ADD COLUMN estimate_mode TEXT;
ALTER TABLE estimates ADD COLUMN billing_model TEXT;
ALTER TABLE estimates ADD COLUMN tax_amount REAL DEFAULT 0;
ALTER TABLE estimates ADD COLUMN deposit_amount REAL;
ALTER TABLE estimates ADD COLUMN deposit_type TEXT;
ALTER TABLE estimates ADD COLUMN deposit_percentage REAL;
ALTER TABLE estimates ADD COLUMN valid_days INTEGER DEFAULT 7;
ALTER TABLE estimates ADD COLUMN expiration_date TEXT;
ALTER TABLE estimates ADD COLUMN portal_token TEXT;
ALTER TABLE estimates ADD COLUMN include_reviews INTEGER DEFAULT 1;
ALTER TABLE estimates ADD COLUMN review_ids TEXT;
ALTER TABLE estimates ADD COLUMN include_contract INTEGER DEFAULT 1;
ALTER TABLE estimates ADD COLUMN contract_template_id TEXT;
ALTER TABLE estimates ADD COLUMN client_signature TEXT;
ALTER TABLE estimates ADD COLUMN signed_date TEXT;
ALTER TABLE estimates ADD COLUMN notes TEXT;

-- expenses (existing: id, job_id, amount, description, incurred_at, synced_at,
--           vendor, receipt_r2_key, entered_via, pushed_to_jobber_at,
--           jobber_id, drive_mirrored_at)
ALTER TABLE expenses ADD COLUMN expense_type TEXT;
ALTER TABLE expenses ADD COLUMN incurred_date TEXT;
ALTER TABLE expenses ADD COLUMN estimate_line_item_id TEXT;
ALTER TABLE expenses ADD COLUMN receipt_photo_id TEXT;
ALTER TABLE expenses ADD COLUMN tax_category TEXT;
ALTER TABLE expenses ADD COLUMN is_1099_reportable INTEGER DEFAULT 0;
ALTER TABLE expenses ADD COLUMN sub_id TEXT;
ALTER TABLE expenses ADD COLUMN pushed_to_qbo INTEGER DEFAULT 0;
ALTER TABLE expenses ADD COLUMN qbo_transaction_id TEXT;
ALTER TABLE expenses ADD COLUMN created_at TEXT;
ALTER TABLE expenses ADD COLUMN created_by TEXT;

-- invoices (existing: id, job_id, status, total, payments_total, issued_date,
--           due_date, synced_at)
ALTER TABLE invoices ADD COLUMN invoice_number INTEGER;
ALTER TABLE invoices ADD COLUMN client_id TEXT;
ALTER TABLE invoices ADD COLUMN billing_model TEXT;
ALTER TABLE invoices ADD COLUMN invoice_type TEXT;
ALTER TABLE invoices ADD COLUMN title TEXT;
ALTER TABLE invoices ADD COLUMN description TEXT;
ALTER TABLE invoices ADD COLUMN amount REAL;
ALTER TABLE invoices ADD COLUMN tax_amount REAL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN late_fee_amount REAL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN credits_applied REAL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN total_due REAL;
ALTER TABLE invoices ADD COLUMN sent_date TEXT;
ALTER TABLE invoices ADD COLUMN paid_date TEXT;
ALTER TABLE invoices ADD COLUMN paid_amount REAL;
ALTER TABLE invoices ADD COLUMN payment_method TEXT;
ALTER TABLE invoices ADD COLUMN stripe_payment_id TEXT;
ALTER TABLE invoices ADD COLUMN portal_link TEXT;
ALTER TABLE invoices ADD COLUMN cost_plus_cycle_id TEXT;
ALTER TABLE invoices ADD COLUMN milestone_number INTEGER;
ALTER TABLE invoices ADD COLUMN trade_line_item_id TEXT;
ALTER TABLE invoices ADD COLUMN notes TEXT;
ALTER TABLE invoices ADD COLUMN created_at TEXT;
ALTER TABLE invoices ADD COLUMN created_by TEXT;

-- payments (existing: id, job_id, invoice_id, amount, collected_at, synced_at)
ALTER TABLE payments ADD COLUMN client_id TEXT;
ALTER TABLE payments ADD COLUMN payment_method TEXT;
ALTER TABLE payments ADD COLUMN stripe_payment_id TEXT;
ALTER TABLE payments ADD COLUMN stripe_fee REAL;
ALTER TABLE payments ADD COLUMN convenience_fee REAL;
ALTER TABLE payments ADD COLUMN net_amount REAL;
ALTER TABLE payments ADD COLUMN received_date TEXT;
ALTER TABLE payments ADD COLUMN deposited_date TEXT;
ALTER TABLE payments ADD COLUMN notes TEXT;
ALTER TABLE payments ADD COLUMN created_at TEXT;

-- photos (existing: id, created_at, taken_at, job_id, category, r2_key,
--         thumb_key, uploaded_by, gps_lat, gps_lng, tags, caption,
--         before_after_pair_id, drive_mirrored_at)
ALTER TABLE photos ADD COLUMN estimate_request_id TEXT;
ALTER TABLE photos ADD COLUMN r2_thumbnail_key TEXT;
ALTER TABLE photos ADD COLUMN r2_url TEXT;
ALTER TABLE photos ADD COLUMN google_drive_id TEXT;
ALTER TABLE photos ADD COLUMN photo_type TEXT;
ALTER TABLE photos ADD COLUMN latitude REAL;
ALTER TABLE photos ADD COLUMN longitude REAL;
ALTER TABLE photos ADD COLUMN location_accuracy REAL;
ALTER TABLE photos ADD COLUMN uploaded_at TEXT;
ALTER TABLE photos ADD COLUMN synced_from_offline INTEGER DEFAULT 0;
ALTER TABLE photos ADD COLUMN task_id TEXT;
ALTER TABLE photos ADD COLUMN daily_log_id TEXT;
ALTER TABLE photos ADD COLUMN is_annotated INTEGER DEFAULT 0;
ALTER TABLE photos ADD COLUMN annotation_data TEXT;
ALTER TABLE photos ADD COLUMN is_social_ready INTEGER DEFAULT 0;
ALTER TABLE photos ADD COLUMN is_before_photo INTEGER DEFAULT 0;
ALTER TABLE photos ADD COLUMN is_after_photo INTEGER DEFAULT 0;
ALTER TABLE photos ADD COLUMN ai_tags TEXT;
ALTER TABLE photos ADD COLUMN entered_via TEXT;
ALTER TABLE photos ADD COLUMN is_active INTEGER DEFAULT 1;
ALTER TABLE photos ADD COLUMN created_by TEXT;

-- subcontractors (existing: id, created_at, updated_at, company, trade,
--   primary_contact, reference_type, phone, email, city_state, service_area,
--   license_number, insurance_verified, years_worked, last_project,
--   last_project_date, rating, would_rehire, notes, website, follow_up_date,
--   active_status)
ALTER TABLE subcontractors ADD COLUMN company_name TEXT;
ALTER TABLE subcontractors ADD COLUMN contact_name TEXT;
ALTER TABLE subcontractors ADD COLUMN insurance_on_file INTEGER DEFAULT 0;
ALTER TABLE subcontractors ADD COLUMN w9_on_file INTEGER DEFAULT 0;
ALTER TABLE subcontractors ADD COLUMN hourly_rate REAL;
ALTER TABLE subcontractors ADD COLUMN flat_rate_notes TEXT;
ALTER TABLE subcontractors ADD COLUMN is_active INTEGER DEFAULT 1;

-- users (existing: id, email, name, role, default_crew, current_job_id,
--        created_at, last_login_at, disabled)
ALTER TABLE users ADD COLUMN first_name TEXT;
ALTER TABLE users ADD COLUMN last_name TEXT;
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1;
ALTER TABLE users ADD COLUMN last_login TEXT;
ALTER TABLE users ADD COLUMN notification_preferences TEXT;
ALTER TABLE users ADD COLUMN updated_at TEXT;

-- ─────────────────────────────────────────────────────────────────────────
-- Part B: CREATE new system tables
-- ─────────────────────────────────────────────────────────────────────────

-- system_settings (key-value store for all configurable settings)
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK(value_type IN ('string','number','boolean','json')),
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);

-- audit_logs (new table — existing audit_log is preserved for historical data)
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- integration_connections (new table — existing integrations is preserved)
CREATE TABLE IF NOT EXISTS integration_connections (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL CHECK(service IN ('stripe','quickbooks','twilio','high_level','google_drive','facebook','instagram','replicate')),
  status TEXT NOT NULL CHECK(status IN ('connected','disconnected','error','pending')),
  access_token TEXT,
  refresh_token TEXT,
  token_expiry TEXT,
  account_id TEXT,
  configuration TEXT,
  last_sync TEXT,
  last_error TEXT,
  connected_at TEXT,
  connected_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- dead_letter_queue (new table — existing sync_dead_letters preserved)
CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  payload TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL CHECK(status IN ('pending','retrying','resolved','dismissed')),
  next_retry_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

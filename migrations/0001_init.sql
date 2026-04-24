-- chs-hub initial schema
-- Migration 0001 — creates all Phase 6 tables.
-- Applied via: wrangler d1 migrations apply chs-hub-db --remote
--
-- Source of truth for table design: docs/00-architecture.md §4
-- Schema is additive — future migrations add columns/tables without
-- altering or dropping anything here unless explicitly needed.

-- ─── Jobber entities ────────────────────────────────────────────────

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,                    -- Jobber node ID
  job_number INTEGER,
  title TEXT,
  status TEXT,                            -- ACTIVE, COMPLETED, etc.
  client_id TEXT REFERENCES clients(id),
  source TEXT,
  total REAL,
  created_at TEXT,                        -- ISO date from Jobber
  start_at TEXT,
  completed_at TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_created_at ON jobs(created_at);
CREATE INDEX idx_jobs_completed_at ON jobs(completed_at);
CREATE INDEX idx_jobs_status ON jobs(status);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT,
  phone TEXT,
  email TEXT,
  address_street TEXT,
  address_city TEXT,
  address_state TEXT,
  address_postal TEXT,
  custom_fields TEXT,                     -- JSON blob
  synced_at TEXT NOT NULL
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  quote_number INTEGER,
  status TEXT,                            -- DRAFT, APPROVED, CONVERTED, etc.
  subtotal REAL,
  created_at TEXT,
  transitioned_at TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX idx_quotes_transitioned_at ON quotes(transitioned_at);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  status TEXT,
  total REAL,
  payments_total REAL,
  issued_date TEXT,
  due_date TEXT,
  synced_at TEXT NOT NULL
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  invoice_id TEXT REFERENCES invoices(id),
  amount REAL,
  collected_at TEXT,                      -- derived from createdAt or adjustmentDate
  synced_at TEXT NOT NULL
);
CREATE INDEX idx_payments_collected_at ON payments(collected_at);

CREATE TABLE line_items (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  name TEXT,
  quantity REAL,
  unit_price REAL,
  unit_cost REAL,
  synced_at TEXT NOT NULL
);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  amount REAL,
  description TEXT,
  incurred_at TEXT,
  synced_at TEXT NOT NULL
);

-- ─── HighLevel entities (Phase 6c) ──────────────────────────────────

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  name TEXT,
  phone TEXT,
  email TEXT,
  source TEXT,
  status TEXT,                            -- new, contacted, qualified, etc.
  assigned_to TEXT,
  created_at TEXT,
  last_contact_at TEXT,
  synced_at TEXT NOT NULL
);

-- ─── Users ──────────────────────────────────────────────────────────
-- Defined before `files` because files.uploaded_by references users(id).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,                     -- 'owner', 'admin', 'crew_lead', 'crew', 'office'
  default_crew TEXT,
  current_job_id TEXT REFERENCES jobs(id),
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  disabled INTEGER DEFAULT 0
);

-- ─── Estimates (Phase 7) ────────────────────────────────────────────
-- Defined before `files` because files.estimate_id references estimates(id).

CREATE TABLE estimates (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id),
  status TEXT NOT NULL,                   -- 'draft', 'reviewed', 'sent_to_jobber', 'won', 'lost'
  jobber_quote_id TEXT,

  extracted_scope TEXT,                   -- JSON: rooms, dimensions, materials noted
  extracted_items TEXT,                   -- JSON: line items derived from uploads

  line_items TEXT,                        -- JSON: final line items with pricing
  subtotal REAL,
  total REAL,
  margin_percent REAL,

  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  sent_at TEXT
);

-- ─── File storage + media ──────────────────────────────────────────
-- All blobs live in R2; D1 is the searchable index.

CREATE TABLE files (
  id TEXT PRIMARY KEY,                    -- UUID
  r2_key TEXT NOT NULL UNIQUE,            -- object key in R2 bucket
  filename TEXT NOT NULL,                 -- original filename
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT,                            -- for dedup + integrity
  uploaded_by TEXT REFERENCES users(id),
  uploaded_at TEXT NOT NULL,

  -- Association (nullable — a file can be orphaned or shared)
  job_id TEXT REFERENCES jobs(id),
  lead_id TEXT REFERENCES leads(id),
  estimate_id TEXT REFERENCES estimates(id),

  -- Categorization (matches SOP intent: Before, Progress, Final, Issues, etc.)
  category TEXT,                          -- 'before', 'progress', 'final', 'issues',
                                          -- 'blueprint', 'contract', 'invoice',
                                          -- 'receipt', 'ai_generated', 'social_ready'
  taken_at TEXT,                          -- from EXIF or upload time

  -- Mobile capture context
  captured_lat REAL,
  captured_lon REAL,
  captured_by_device TEXT,

  -- Versioning / lifecycle
  deleted_at TEXT,                        -- soft delete
  archived INTEGER DEFAULT 0              -- 1 = moved to archive/completed
);
CREATE INDEX idx_files_job ON files(job_id, category);
CREATE INDEX idx_files_lead ON files(lead_id);
CREATE INDEX idx_files_taken ON files(taken_at);
CREATE INDEX idx_files_social ON files(category) WHERE category = 'social_ready';

CREATE TABLE file_tags (
  file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (file_id, tag)
);

CREATE TABLE file_shares (
  id TEXT PRIMARY KEY,                    -- share token (goes in URL)
  file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
  shared_with_email TEXT,                 -- nullable for public links
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_viewed_at TEXT,
  view_count INTEGER DEFAULT 0
);

-- ─── AI content provenance ─────────────────────────────────────────

CREATE TABLE ai_generations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                     -- 'image', 'caption', 'estimate_extract', 'monthly_plan'
  file_id TEXT REFERENCES files(id),
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,                    -- 'claude-sonnet-4.5', 'flux-pro-1.1', etc.
  cost_cents INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  generated_at TEXT NOT NULL,
  generated_by TEXT REFERENCES users(id)
);

-- ─── Integrations (external service config + tokens) ───────────────

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,                    -- 'jobber', 'highlevel', 'google_tasks', 'metricool'
  kind TEXT NOT NULL,                     -- 'oauth', 'api_key', 'webhook'
  config TEXT,                            -- JSON: service-specific
  access_token TEXT,                      -- encrypted
  refresh_token TEXT,                     -- encrypted
  token_expires_at TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ─── Operational tables ────────────────────────────────────────────

CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,                 -- 'jobber_full', 'highlevel_leads', etc.
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,                   -- 'running', 'success', 'error', 'throttled'
  rows_affected INTEGER DEFAULT 0,
  error_message TEXT,
  duration_ms INTEGER
);
CREATE INDEX idx_sync_log_started ON sync_log(started_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,                   -- 'file.upload', 'file.share', 'estimate.send', etc.
  entity_type TEXT,
  entity_id TEXT,
  metadata TEXT,                          -- JSON
  ip_address TEXT,
  user_agent TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_audit_user_time ON audit_log(user_id, occurred_at);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

CREATE TABLE kv_cache (
  key TEXT PRIMARY KEY,                   -- e.g. 'last_full_sync_cursor'
  value TEXT,
  updated_at TEXT NOT NULL
);

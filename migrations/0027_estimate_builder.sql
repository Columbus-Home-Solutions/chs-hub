-- 0027_estimate_builder.sql
-- Sprint 4 — Estimate Builder migration of record.
--
-- The seven estimating tables were already created back in Sprint 1
-- (estimates extended in 0014_schema_bridge.sql; the rest in
-- 0016_estimating_tables.sql). Verified locally via PRAGMA table_info that
-- every column from the schema doc is already present, so the CREATE TABLE
-- IF NOT EXISTS statements below are no-ops on an up-to-date DB and only
-- matter on a fresh/partial database.
--
-- The ONLY genuinely-new columns Sprint 4 introduces are estimate versioning
-- (version + revised_from_id) on the `estimates` table to support the
-- revision workflow (POST /api/estimates/:id/revise clones into a new version
-- and preserves the original). Per the migration rules these are additive,
-- nullable / constant-default columns only.
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS"; on a DB where these already exist
-- the two ALTERs will error harmlessly (run once on a clean local DB).

-- ─────────────────────────────────────────────────────────────────────────
-- Part A: safety-net CREATE TABLE IF NOT EXISTS for the seven tables
-- (mirrors 0014 / 0016 — no-op when already present)
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS estimates (
  id TEXT PRIMARY KEY,
  lead_id TEXT,
  status TEXT NOT NULL,
  jobber_quote_id TEXT,
  extracted_scope TEXT,
  extracted_items TEXT,
  line_items TEXT,
  subtotal REAL,
  total REAL,
  margin_percent REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  estimate_number INTEGER,
  request_id TEXT,
  client_id TEXT,
  title TEXT,
  estimate_mode TEXT,
  billing_model TEXT,
  tax_amount REAL DEFAULT 0,
  deposit_amount REAL,
  deposit_type TEXT,
  deposit_percentage REAL,
  valid_days INTEGER DEFAULT 7,
  expiration_date TEXT,
  portal_token TEXT,
  include_reviews INTEGER DEFAULT 1,
  review_ids TEXT,
  include_contract INTEGER DEFAULT 1,
  contract_template_id TEXT,
  client_signature TEXT,
  signed_date TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS estimate_line_items (
  id TEXT PRIMARY KEY,
  estimate_id TEXT NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  product_service TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT,
  unit_price REAL NOT NULL,
  total REAL,
  includes_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS estimate_sub_items (
  id TEXT PRIMARY KEY,
  parent_line_item_id TEXT NOT NULL REFERENCES estimate_line_items(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  vendor TEXT,
  quantity REAL,
  unit TEXT,
  unit_cost REAL NOT NULL,
  total_cost REAL,
  material_id TEXT REFERENCES vendor_materials(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payment_schedules (
  id TEXT PRIMARY KEY,
  estimate_id TEXT NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  description TEXT NOT NULL,
  percentage REAL,
  fixed_amount REAL,
  amount REAL,
  is_deposit INTEGER DEFAULT 0,
  trigger TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS estimate_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  job_type TEXT NOT NULL,
  description TEXT,
  default_billing_model TEXT,
  line_items TEXT NOT NULL,
  default_payment_schedule TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS saved_reviews (
  id TEXT PRIMARY KEY,
  reviewer_name TEXT NOT NULL,
  review_date TEXT,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  review_text TEXT NOT NULL,
  source TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vendor_materials (
  id TEXT PRIMARY KEY,
  vendor_name TEXT NOT NULL,
  material_name TEXT NOT NULL,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  last_price REAL NOT NULL,
  last_purchased_date TEXT,
  average_price REAL,
  price_history TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────────────
-- Part B: NEW columns for the estimate revision workflow
-- (the only genuinely-missing columns this sprint)
--   version        — revision number, original = 1
--   revised_from_id — points to the estimate this was cloned from (null for v1)
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE estimates ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE estimates ADD COLUMN revised_from_id TEXT;

-- Helpful indexes for the builder's nested reads (no-op if already present).
CREATE INDEX IF NOT EXISTS idx_estimates_request_id ON estimates(request_id);
CREATE INDEX IF NOT EXISTS idx_estimate_line_items_estimate ON estimate_line_items(estimate_id);
CREATE INDEX IF NOT EXISTS idx_estimate_sub_items_parent ON estimate_sub_items(parent_line_item_id);
CREATE INDEX IF NOT EXISTS idx_payment_schedules_estimate ON payment_schedules(estimate_id);

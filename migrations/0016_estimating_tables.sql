-- 0016_estimating_tables.sql
-- Sprint 1 — Estimating module tables: estimate_requests, estimate_line_items,
-- estimate_sub_items, payment_schedules, estimate_templates, saved_reviews.
-- (The existing `estimates` table was extended in 0014_schema_bridge.sql.)

CREATE TABLE IF NOT EXISTS estimate_requests (
  id TEXT PRIMARY KEY,
  request_number INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('new_request','appointment_set','visit_done','building','sent','follow_up','won','lost')),
  client_id TEXT NOT NULL REFERENCES clients(id),
  property_address TEXT NOT NULL,
  property_city TEXT NOT NULL,
  property_state TEXT NOT NULL DEFAULT 'Arkansas',
  property_zip TEXT NOT NULL,
  job_type TEXT NOT NULL,
  lead_source TEXT NOT NULL,
  lead_source_detail TEXT,
  high_level_opportunity_id TEXT,
  appointment_date TEXT,
  appointment_completed INTEGER DEFAULT 0,
  visit_notes TEXT,
  visit_photo_ids TEXT,
  estimate_id TEXT REFERENCES estimates(id),
  sent_date TEXT,
  follow_up_count INTEGER DEFAULT 0,
  last_follow_up_date TEXT,
  lost_reason TEXT,
  lost_notes TEXT,
  converted_job_id TEXT REFERENCES jobs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT
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

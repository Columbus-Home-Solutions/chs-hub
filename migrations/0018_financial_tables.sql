-- 0018_financial_tables.sql
-- Sprint 1 — Financial module tables: time_entries, billing_cycles, mileage,
-- lien_waivers, vendor_materials.
-- (The existing `invoices`, `payments`, `expenses` tables were extended in
-- 0014_schema_bridge.sql.)

CREATE TABLE IF NOT EXISTS time_entries (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  worker TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('general','pm_skilled')),
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  hours REAL,
  hourly_rate REAL,
  labor_cost REAL,
  notes TEXT,
  entered_via TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS billing_cycles (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  cycle_number INTEGER NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  is_final_cycle INTEGER DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('planning','active','reconciling','closed')),
  projected_materials REAL DEFAULT 0,
  projected_labor REAL DEFAULT 0,
  projected_subs REAL DEFAULT 0,
  projected_subtotal REAL,
  pm_fee_rate REAL NOT NULL DEFAULT 0.10,
  contractor_fee_rate REAL NOT NULL DEFAULT 0.20,
  projected_pm_fee REAL,
  projected_contractor_fee REAL,
  projected_total REAL,
  actual_materials REAL DEFAULT 0,
  actual_labor REAL DEFAULT 0,
  actual_subs REAL DEFAULT 0,
  actual_subtotal REAL,
  actual_pm_fee REAL,
  actual_contractor_fee REAL,
  actual_total REAL,
  delta REAL,
  credit_from_prior REAL DEFAULT 0,
  credit_to_next REAL DEFAULT 0,
  invoice_id TEXT REFERENCES invoices(id),
  reconciliation_invoice_id TEXT REFERENCES invoices(id),
  reconciliation_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mileage (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  trip_purpose TEXT NOT NULL,
  start_location TEXT,
  end_location TEXT,
  distance_miles REAL NOT NULL,
  trip_date TEXT NOT NULL,
  irs_rate REAL,
  deduction_amount REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lien_waivers (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  sub_id TEXT NOT NULL REFERENCES subcontractors(id),
  waiver_type TEXT NOT NULL CHECK(waiver_type IN ('conditional','unconditional','partial','final')),
  payment_amount REAL NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('requested','received','filed')),
  requested_date TEXT NOT NULL DEFAULT (datetime('now')),
  received_date TEXT,
  document_id TEXT REFERENCES documents(id),
  notes TEXT,
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

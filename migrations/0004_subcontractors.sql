-- Subcontractor reference list — native replacement for the
-- "subcontractor_reference_list_template" Google Sheet. Mirrors the 19 user
-- fields from that sheet (completeness % is computed, not stored).

CREATE TABLE IF NOT EXISTS subcontractors (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  company           TEXT,   -- Company / Individual (required in practice)
  trade             TEXT,   -- Trade / Scope (Electrical, Plumbing, etc.)
  primary_contact   TEXT,
  reference_type    TEXT,   -- General Contractor, Homeowner, Architect, …
  phone             TEXT,
  email             TEXT,
  city_state        TEXT,   -- "Dallas, TX"
  service_area      TEXT,
  license_number    TEXT,   -- "EC-123456 / TX"
  insurance_verified INTEGER NOT NULL DEFAULT 0,  -- 0/1
  years_worked      REAL,
  last_project      TEXT,
  last_project_date TEXT,   -- ISO YYYY-MM-DD
  rating            INTEGER,-- 1–5
  would_rehire      INTEGER,-- NULL unknown, 0 No, 1 Yes
  notes             TEXT,
  website           TEXT,
  follow_up_date    TEXT,   -- ISO YYYY-MM-DD
  active_status     TEXT NOT NULL DEFAULT 'Active'  -- Active | Inactive
);

CREATE INDEX IF NOT EXISTS idx_subs_company ON subcontractors(company COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_subs_trade ON subcontractors(trade);
CREATE INDEX IF NOT EXISTS idx_subs_status ON subcontractors(active_status);

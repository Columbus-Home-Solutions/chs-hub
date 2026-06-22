CREATE TABLE IF NOT EXISTS payers (
  id TEXT PRIMARY KEY,
  company_name TEXT,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  billing_address TEXT,
  billing_city TEXT,
  billing_state TEXT,
  billing_zip TEXT,
  stripe_customer_id TEXT,
  stripe_payment_method_id TEXT,
  card_brand TEXT,
  card_last4 TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT
);

ALTER TABLE estimate_line_items ADD COLUMN completion_status TEXT DEFAULT 'not_started';

ALTER TABLE estimate_line_items ADD COLUMN completed_date TEXT;

ALTER TABLE estimate_line_items ADD COLUMN blocked_by_line_item_id TEXT REFERENCES estimate_line_items(id);

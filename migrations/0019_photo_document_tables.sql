-- 0019_photo_document_tables.sql
-- Sprint 1 — Photo & Document module tables: receipt_photos, smart_notes,
-- documents, document_templates.
-- (The existing `photos` table was extended in 0014_schema_bridge.sql. The
-- existing `notes` and `files` tables are preserved as archives; new code uses
-- smart_notes and documents.)

CREATE TABLE IF NOT EXISTS receipt_photos (
  id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL UNIQUE REFERENCES photos(id) ON DELETE CASCADE,
  ai_vendor TEXT,
  ai_amount REAL,
  ai_date TEXT,
  ai_category TEXT,
  ai_confidence REAL,
  expense_id TEXT REFERENCES expenses(id),
  processing_status TEXT NOT NULL CHECK(processing_status IN ('pending','processed','confirmed','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS smart_notes (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  raw_content TEXT NOT NULL,
  ai_summary TEXT,
  ai_category TEXT,
  ai_extracted_tasks TEXT,
  ai_extracted_expense TEXT,
  ai_extracted_change_order TEXT,
  is_processed INTEGER DEFAULT 0,
  processing_status TEXT,
  entered_via TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER,
  r2_key TEXT NOT NULL,
  r2_url TEXT NOT NULL,
  google_drive_id TEXT,
  google_drive_url TEXT,
  mirror_status TEXT,
  mirror_date TEXT,
  context_type TEXT NOT NULL CHECK(context_type IN ('job','client','estimate','company','template')),
  job_id TEXT REFERENCES jobs(id),
  client_id TEXT REFERENCES clients(id),
  estimate_id TEXT REFERENCES estimates(id),
  document_category TEXT NOT NULL,
  is_signed INTEGER DEFAULT 0,
  signed_date TEXT,
  signature_data TEXT,
  share_token TEXT UNIQUE,
  share_expiration TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  template_type TEXT NOT NULL,
  content TEXT NOT NULL,
  merge_fields TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

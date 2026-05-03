-- Company documents (SOPs, insurance, licenses, W-9, etc.) — D1 + R2.
-- R2 key prefix: company-docs/{doc_type}/{uuid}.ext
--
-- Drive mirror: one-way copy to Google Shared Drive; rows track completion.

ALTER TABLE photos ADD COLUMN drive_mirrored_at TEXT;
CREATE INDEX IF NOT EXISTS idx_photos_drive_mirrored ON photos(drive_mirrored_at);

ALTER TABLE expenses ADD COLUMN drive_mirrored_at TEXT;
CREATE INDEX IF NOT EXISTS idx_expenses_drive_mirrored ON expenses(drive_mirrored_at);

CREATE TABLE IF NOT EXISTS company_documents (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'other',
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  effective_date TEXT,
  expires_at TEXT,
  notes TEXT,
  uploaded_by TEXT,
  drive_mirrored_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_company_docs_type ON company_documents(doc_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_company_docs_created ON company_documents(created_at DESC);

-- Cached Google Drive folder IDs under the operator-configured root (see drive-mirror).
CREATE TABLE IF NOT EXISTS drive_mirror_folders (
  path_key TEXT PRIMARY KEY,
  drive_folder_id TEXT NOT NULL
);

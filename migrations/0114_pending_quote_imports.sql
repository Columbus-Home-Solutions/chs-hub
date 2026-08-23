-- Pending supplier-quote emails awaiting Tony's assign + confirm.
CREATE TABLE IF NOT EXISTS pending_quote_imports (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'email',
  from_address TEXT,
  subject TEXT,
  received_at TEXT NOT NULL,
  raw_text TEXT,
  extraction_json TEXT,
  extraction_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'assigned', 'discarded')),
  assigned_estimate_id TEXT,
  assigned_line_item_id TEXT,
  created_estimate_sub_item_ids TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pending_quote_imports_status
  ON pending_quote_imports (status, received_at DESC);

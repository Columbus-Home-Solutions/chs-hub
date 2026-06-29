CREATE TABLE IF NOT EXISTS line_item_catalog (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  unit TEXT,
  unit_price REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_line_item_catalog_active
  ON line_item_catalog(is_active);

CREATE INDEX IF NOT EXISTS idx_line_item_catalog_name
  ON line_item_catalog(name);

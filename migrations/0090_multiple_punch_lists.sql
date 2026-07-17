-- Multiple concurrent punch lists per job + owner-editable name presets

ALTER TABLE punch_lists ADD COLUMN name TEXT NOT NULL DEFAULT 'Punch List';

CREATE TABLE IF NOT EXISTS punch_list_name_presets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO punch_list_name_presets (id, name, sort_order) VALUES
  (lower(hex(randomblob(16))), 'Electrical', 1),
  (lower(hex(randomblob(16))), 'HVAC', 2),
  (lower(hex(randomblob(16))), 'Plumbing', 3),
  (lower(hex(randomblob(16))), 'General', 4);

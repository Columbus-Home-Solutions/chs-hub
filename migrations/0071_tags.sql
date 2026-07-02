-- Sprint 34: Tag vocabulary + client tag assignments.
-- Using a normalized table (not free text) to prevent duplicates like "VIP" /
-- "vip" / "V.I.P.", enable future client-list filtering, and preserve history
-- when a tag is archived (soft delete only).

CREATE TABLE IF NOT EXISTS tag_definitions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tag_text TEXT NOT NULL UNIQUE,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS client_tags (
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tag_definition_id TEXT NOT NULL REFERENCES tag_definitions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (client_id, tag_definition_id)
);

CREATE INDEX IF NOT EXISTS idx_client_tags_client_id ON client_tags(client_id);
CREATE INDEX IF NOT EXISTS idx_client_tags_tag_id ON client_tags(tag_definition_id);

-- Starter vocabulary — broadly useful for a remodeling business.
INSERT OR IGNORE INTO tag_definitions (tag_text) VALUES
  ('VIP / Repeat Client'),
  ('Referral Partner'),
  ('High-Touch'),
  ('Property Manager'),
  ('Insurance / Restoration'),
  ('Priority Scheduling');

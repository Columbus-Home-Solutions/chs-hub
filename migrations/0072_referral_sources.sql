-- Sprint 34: Managed referral source lookup table.
-- Single-select per client (referral_source_id on clients), same add/archive
-- pattern as tag_definitions so Tony can self-serve new options without a
-- code change. Existing lead_source text column is unaffected.

CREATE TABLE IF NOT EXISTS referral_sources (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  label TEXT NOT NULL UNIQUE,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE clients ADD COLUMN referral_source_id TEXT REFERENCES referral_sources(id);

-- Starter vocabulary — common lead channels for a remodeling business.
INSERT OR IGNORE INTO referral_sources (label) VALUES
  ('Google'),
  ('Facebook / Instagram'),
  ('Referral – Client'),
  ('Referral – Partner (realtor / PM / insurance)'),
  ('Repeat Client'),
  ('Website'),
  ('Yard Sign'),
  ('Other');

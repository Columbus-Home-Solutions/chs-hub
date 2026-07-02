-- Sprint 34: Additional contacts per client (secondary phone/email with labels).
-- The primary phone and email stay on the clients table exactly as today —
-- this table is purely additive for the "expand more contacts" feature.

CREATE TABLE IF NOT EXISTS client_contacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  contact_type TEXT NOT NULL CHECK(contact_type IN ('phone', 'email')),
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_client_contacts_client_id ON client_contacts(client_id);

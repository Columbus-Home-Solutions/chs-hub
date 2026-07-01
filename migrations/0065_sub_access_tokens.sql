-- Sprint 34: Persistent sub access token (one permanent URL per subcontractor).
-- One token per sub, ever — created lazily on first need, never regenerated.

CREATE TABLE IF NOT EXISTS sub_access_tokens (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  sub_id     TEXT NOT NULL UNIQUE REFERENCES subcontractors(id),
  token      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_viewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sub_access_tokens_token  ON sub_access_tokens(token);
CREATE INDEX IF NOT EXISTS idx_sub_access_tokens_sub_id ON sub_access_tokens(sub_id);

-- Sprint 33: punch list tables (one list per job, sub secure links)

CREATE TABLE IF NOT EXISTS punch_lists (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','sent','closed')),
  scheduled_date TEXT,
  sent_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS punch_list_items (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  punch_list_id TEXT NOT NULL REFERENCES punch_lists(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  sub_id TEXT REFERENCES subcontractors(id),
  photo_ids TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open','done')),
  scheduled_date TEXT,
  completed_at TEXT,
  completed_note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS punch_list_sub_tokens (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  punch_list_id TEXT NOT NULL REFERENCES punch_lists(id) ON DELETE CASCADE,
  sub_id TEXT NOT NULL REFERENCES subcontractors(id),
  token TEXT NOT NULL UNIQUE,
  notified_at TEXT,
  reminder_sent_at TEXT,
  followup_sent_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_punch_lists_job_id ON punch_lists(job_id);
CREATE INDEX IF NOT EXISTS idx_punch_list_items_punch_list_id ON punch_list_items(punch_list_id);
CREATE INDEX IF NOT EXISTS idx_punch_list_items_sub_id ON punch_list_items(sub_id);
CREATE INDEX IF NOT EXISTS idx_punch_list_items_status ON punch_list_items(status);
CREATE INDEX IF NOT EXISTS idx_punch_list_sub_tokens_token ON punch_list_sub_tokens(token);
CREATE INDEX IF NOT EXISTS idx_punch_list_sub_tokens_punch_list_id ON punch_list_sub_tokens(punch_list_id);

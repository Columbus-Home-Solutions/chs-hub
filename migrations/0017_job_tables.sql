-- 0017_job_tables.sql
-- Sprint 1 — Job module tables: tasks, daily_logs, change_orders,
-- schedule_entries, permits, warranties.
-- (The existing `jobs` table was extended in 0014_schema_bridge.sql.)

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  task_group TEXT NOT NULL,
  task_group_order INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','in_progress','complete','skipped')),
  assigned_to TEXT,
  scheduled_date TEXT,
  completed_date TEXT,
  completed_by TEXT,
  notes TEXT,
  sort_order INTEGER NOT NULL,
  is_punch_list INTEGER DEFAULT 0,
  photo_ids TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_logs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  log_date TEXT NOT NULL,
  weather TEXT,
  work_performed TEXT NOT NULL,
  issues TEXT,
  materials_used TEXT,
  crew_on_site TEXT,
  hours_worked REAL,
  photo_ids TEXT,
  entered_via TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS change_orders (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  change_order_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','sent','approved','rejected')),
  requested_date TEXT NOT NULL DEFAULT (datetime('now')),
  approved_date TEXT,
  client_signature TEXT,
  triggered_by_note_id TEXT REFERENCES smart_notes(id),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schedule_entries (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  scheduled_date TEXT NOT NULL,
  trade_or_work TEXT NOT NULL,
  sub_id TEXT REFERENCES subcontractors(id),
  start_time TEXT,
  end_time TEXT,
  notes TEXT,
  notification_sent INTEGER DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('scheduled','in_progress','completed','cancelled','weather_delay')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS permits (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  permit_type TEXT NOT NULL,
  permit_number TEXT,
  status TEXT NOT NULL CHECK(status IN ('applied','approved','inspection_scheduled','passed','failed','closed')),
  applied_date TEXT,
  approved_date TEXT,
  inspection_date TEXT,
  inspection_result TEXT,
  cost REAL,
  document_id TEXT REFERENCES documents(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS warranties (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  claim_date TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reported','scheduled','resolved')),
  resolution TEXT,
  resolved_date TEXT,
  cost REAL,
  photo_ids TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

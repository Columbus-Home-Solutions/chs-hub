-- Smart Notes native D1 storage — replaces the "Smart Notes" +
-- "Archived Notes" tabs on the Job Tracker Google Sheet.
--
-- Flow today:
--   active  → user writes note, Claude processes, saved here with status='active'
--   done    → user clicks ✓ Done → status='archived', archived_at=now()
--   restore → user restores from archive → status='active', archived_at=NULL
--
-- `tags` and `tasks_extracted` are stored as JSON strings so the Claude
-- structure passes through unchanged (summary + tags[] + tasks[{title,due,...}]).

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  category TEXT,
  raw_text TEXT NOT NULL,
  summary TEXT,
  tags TEXT,
  tasks_extracted TEXT,
  task_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  archived_at TEXT,
  meeting_source TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);
CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category);

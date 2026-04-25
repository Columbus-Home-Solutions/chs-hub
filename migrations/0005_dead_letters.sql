-- Dead-letter queue for sync failures.
-- Migration 0005 — Phase 7 reliability pass.
--
-- Each row represents a single Jobber entity that failed to upsert during
-- a sync run, along with enough payload to retry the upsert without
-- re-fetching from Jobber.
--
-- Lifecycle:
--   1. Sync catches an error → INSERT (or UPDATE attempts++) here
--   2. Hourly cron picks unresolved rows, replays the upsert
--   3. On success → resolved_at = now()
--   4. On 5+ failed attempts → notify() fires an alert (once per row)

CREATE TABLE sync_dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,                 -- e.g. 'jobber_full'
  entity_type TEXT NOT NULL,              -- 'job' | 'invoice' | 'quote' | 'expense' | 'payment' | 'client'
  entity_id TEXT,                         -- Jobber node ID (nullable: some failures are page-level)
  payload TEXT,                           -- JSON of the original Jobber node, for replay
  error_message TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,            -- ISO ts of first failure
  last_seen_at TEXT NOT NULL,             -- ISO ts of most recent failure
  attempts INTEGER NOT NULL DEFAULT 1,
  resolved_at TEXT,                       -- ISO ts when retry succeeded; NULL = still failing
  last_attempt_status TEXT,               -- 'failed' | 'success' (most recent replay outcome)
  alerted_at TEXT                         -- ISO ts the >=5-attempts alert fired (so we don't spam)
);

-- Only one open (unresolved) row per (job, type, id). Repeated failures
-- bump the attempts counter on this same row instead of inserting duplicates.
CREATE UNIQUE INDEX idx_dlq_unique_open
  ON sync_dead_letters(job_name, entity_type, entity_id)
  WHERE resolved_at IS NULL;

CREATE INDEX idx_dlq_unresolved
  ON sync_dead_letters(resolved_at, last_seen_at);

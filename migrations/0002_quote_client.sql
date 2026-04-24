-- Migration 0002 — quotes.client_id
--
-- Open quotes (awaiting_response, changes_requested, approved-not-yet-job)
-- have no job_id yet, so there was no way to surface the client name in
-- the Pipeline drill. This migration adds a direct quotes.client_id link
-- that's populated by the standalone quotes sync.

ALTER TABLE quotes ADD COLUMN client_id TEXT REFERENCES clients(id);
CREATE INDEX idx_quotes_client_id ON quotes(client_id);

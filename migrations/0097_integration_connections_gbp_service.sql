-- Sprint Reviews Phase B — allow google_business_profile on integration_connections.service
--
-- Live CHECK currently:
--   stripe, quickbooks, twilio, high_level, google_drive,
--   facebook, instagram, replicate, google_calendar
--
-- Pattern: table rebuild (same as 0084_documents_context_type_check.sql).
-- Does NOT drop data — INSERT SELECT copies all existing rows (qbo, gcal, etc.).

CREATE TABLE integration_connections_new (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL CHECK(service IN (
    'stripe','quickbooks','twilio','high_level','google_drive',
    'facebook','instagram','replicate','google_calendar',
    'google_business_profile'
  )),
  status TEXT NOT NULL CHECK(status IN ('connected','disconnected','error','pending')),
  access_token TEXT,
  refresh_token TEXT,
  token_expiry TEXT,
  account_id TEXT,
  configuration TEXT,
  last_sync TEXT,
  last_error TEXT,
  connected_at TEXT,
  connected_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO integration_connections_new
  SELECT id, service, status, access_token, refresh_token, token_expiry,
         account_id, configuration, last_sync, last_error, connected_at,
         connected_by, created_at, updated_at
    FROM integration_connections;

DROP TABLE integration_connections;

ALTER TABLE integration_connections_new RENAME TO integration_connections;

CREATE INDEX IF NOT EXISTS idx_integration_connections_service
  ON integration_connections(service);

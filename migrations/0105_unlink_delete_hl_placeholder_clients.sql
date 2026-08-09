-- Option 2: unlink HL auto-created placeholder clients from estimate_requests,
-- remove their communications (client_id NOT NULL), clear notification_logs.client_id,
-- then delete the placeholder client rows.
-- Scope: clients.email LIKE '%@highlevel.placeholder' only.
-- Contact fields on estimate_requests were already backfilled in 0104.

PRAGMA defer_foreign_keys = ON;

UPDATE estimate_requests
SET client_id = NULL,
    updated_at = datetime('now')
WHERE client_id IN (
  SELECT id FROM clients WHERE email LIKE '%@highlevel.placeholder'
);

UPDATE notification_logs
SET client_id = NULL
WHERE client_id IN (
  SELECT id FROM clients WHERE email LIKE '%@highlevel.placeholder'
);

-- communications.client_id is NOT NULL — drop placeholder-only SMS/timeline rows
DELETE FROM communications
WHERE client_id IN (
  SELECT id FROM clients WHERE email LIKE '%@highlevel.placeholder'
);

DELETE FROM clients
WHERE email LIKE '%@highlevel.placeholder';

PRAGMA defer_foreign_keys = OFF;

-- Session F Phase 2 — 08: Clients, properties, estimate_requests, test subcontractors
-- Last step. Prerequisites: files 01–07.
--
-- Clients:
--   7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c  ZZTEST-PRELAUNCH Test Client
--   79738377-b314-49bc-b273-eb550c49d682  Test Client
-- Properties:
--   6b3a0e1d-7c2f-4d80-b4a5-1c7e9d2f3a4b  123 ZZTEST-PRELAUNCH Test Lane
--   a2243079-791d-4bdb-a240-dbdb65655df6  4414 N Olive St
-- Subcontractors:
--   d930ec5f-6961-46c7-8680-b9622c619820  test (flooring)
--   9a020765-0508-460c-3d3e-4a0718567a7b  ZZTEST-PRELAUNCH Sub A
--   89010754-9407-45fb-2c2d-390607457a6a  ZZTEST-PRELAUNCH Sub B
--
-- LIVE BLOCKERS (remote probe after 01–07 — created AFTER script 03 ran):
--   notification_logs → estimate_requests(id) / clients(id) / communications(id)
--     2 rows: quote_follow_up_day_7 on estimate_request 3c37f0ed-…
--   communications → clients(id)
--     2 rows: Day 7 follow-up SMS/email (job_id NULL)
-- Also: estimate_requests.property_id → properties (9 rows) — delete requests
-- before properties (already the intended order).
--
-- payers has NO client_id; live count 0 — nothing to delete.
--
-- Delete order:
--   1) NULL google_reviews.matched_client_id
--   2) DELETE notification_logs (client / est-req / comm scoped)
--   3) DELETE communications
--   4) DELETE photos → estimate_requests
--   5) DELETE quotes → properties
--   6) DELETE sub packet docs → packets → tokens → subcontractors
--   7) DELETE clients

-- ========== PREVIEW COUNTS ==========
SELECT 'clients' AS tbl, COUNT(*) AS n FROM clients
 WHERE id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682');
SELECT 'properties' AS tbl, COUNT(*) AS n FROM properties
 WHERE id IN ('6b3a0e1d-7c2f-4d80-b4a5-1c7e9d2f3a4b','a2243079-791d-4bdb-a240-dbdb65655df6')
    OR client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682');
SELECT 'estimate_requests' AS tbl, COUNT(*) AS n FROM estimate_requests
 WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682');
SELECT 'subcontractors' AS tbl, COUNT(*) AS n FROM subcontractors
 WHERE id IN (
   'd930ec5f-6961-46c7-8680-b9622c619820',
   '9a020765-0508-460c-3d3e-4a0718567a7b',
   '89010754-9407-45fb-2c2d-390607457a6a'
 );
SELECT 'communications' AS tbl, COUNT(*) AS n FROM communications
 WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682');
SELECT 'notification_logs' AS tbl, COUNT(*) AS n FROM notification_logs
 WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
    OR estimate_request_id IN (
      SELECT id FROM estimate_requests
       WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
    )
    OR communication_id IN (
      SELECT id FROM communications
       WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
    );
SELECT 'subcontractor_packets' AS tbl, COUNT(*) AS n FROM subcontractor_packets
 WHERE sub_id IN (
   'd930ec5f-6961-46c7-8680-b9622c619820',
   '9a020765-0508-460c-3d3e-4a0718567a7b',
   '89010754-9407-45fb-2c2d-390607457a6a'
 );
SELECT 'remaining_jobs_for_clients' AS tbl, COUNT(*) AS n FROM jobs
 WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682');
SELECT 'remaining_estimates_for_clients' AS tbl, COUNT(*) AS n FROM estimates
 WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682');

-- ========== 1) DETACH ==========
UPDATE google_reviews SET matched_client_id = NULL
 WHERE matched_client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682');

-- ========== 2) notification_logs BEFORE estimate_requests / communications / clients ==========
DELETE FROM notification_logs
 WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
    OR estimate_request_id IN (
      SELECT id FROM estimate_requests
       WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
    )
    OR communication_id IN (
      SELECT id FROM communications
       WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
    );

-- ========== 3) communications BEFORE clients ==========
DELETE FROM communications
 WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682');

-- ========== 4) estimate_request children → estimate_requests ==========
DELETE FROM photos
 WHERE estimate_request_id IN (
   SELECT id FROM estimate_requests
    WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
 );

DELETE FROM estimate_requests
 WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682');

-- ========== 5) quotes → properties ==========
DELETE FROM quotes
 WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682');

DELETE FROM properties
 WHERE id IN ('6b3a0e1d-7c2f-4d80-b4a5-1c7e9d2f3a4b','a2243079-791d-4bdb-a240-dbdb65655df6')
    OR client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682');

-- ========== 6) Subcontractor packet children → packets → tokens → subs ==========
UPDATE subcontractor_packets
   SET agreement_document_id = NULL
 WHERE sub_id IN (
   'd930ec5f-6961-46c7-8680-b9622c619820',
   '9a020765-0508-460c-3d3e-4a0718567a7b',
   '89010754-9407-45fb-2c2d-390607457a6a'
 );

UPDATE subcontractor_packet_documents
   SET document_id = NULL
 WHERE packet_id IN (
   SELECT id FROM subcontractor_packets WHERE sub_id IN (
     'd930ec5f-6961-46c7-8680-b9622c619820',
     '9a020765-0508-460c-3d3e-4a0718567a7b',
     '89010754-9407-45fb-2c2d-390607457a6a'
   )
 );

DELETE FROM subcontractor_packet_documents
 WHERE packet_id IN (
   SELECT id FROM subcontractor_packets WHERE sub_id IN (
     'd930ec5f-6961-46c7-8680-b9622c619820',
     '9a020765-0508-460c-3d3e-4a0718567a7b',
     '89010754-9407-45fb-2c2d-390607457a6a'
   )
 );

DELETE FROM subcontractor_packets
 WHERE sub_id IN (
   'd930ec5f-6961-46c7-8680-b9622c619820',
   '9a020765-0508-460c-3d3e-4a0718567a7b',
   '89010754-9407-45fb-2c2d-390607457a6a'
 );

DELETE FROM sub_access_tokens
 WHERE sub_id IN (
   'd930ec5f-6961-46c7-8680-b9622c619820',
   '9a020765-0508-460c-3d3e-4a0718567a7b',
   '89010754-9407-45fb-2c2d-390607457a6a'
 );

-- Defensive: any lingering bid rows still pointing at these test subs
DELETE FROM bid_submissions
 WHERE sub_id IN (
   'd930ec5f-6961-46c7-8680-b9622c619820',
   '9a020765-0508-460c-3d3e-4a0718567a7b',
   '89010754-9407-45fb-2c2d-390607457a6a'
 );
DELETE FROM bid_request_recipients
 WHERE sub_id IN (
   'd930ec5f-6961-46c7-8680-b9622c619820',
   '9a020765-0508-460c-3d3e-4a0718567a7b',
   '89010754-9407-45fb-2c2d-390607457a6a'
 );
UPDATE bid_requests SET awarded_sub_id = NULL
 WHERE awarded_sub_id IN (
   'd930ec5f-6961-46c7-8680-b9622c619820',
   '9a020765-0508-460c-3d3e-4a0718567a7b',
   '89010754-9407-45fb-2c2d-390607457a6a'
 );

DELETE FROM subcontractors
 WHERE id IN (
   'd930ec5f-6961-46c7-8680-b9622c619820',
   '9a020765-0508-460c-3d3e-4a0718567a7b',
   '89010754-9407-45fb-2c2d-390607457a6a'
 );

-- ========== 7) Clients last ==========
DELETE FROM clients
 WHERE id = '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c'
   AND first_name = 'ZZTEST-PRELAUNCH'
   AND NOT EXISTS (SELECT 1 FROM jobs WHERE client_id = '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c')
   AND NOT EXISTS (SELECT 1 FROM estimates WHERE client_id = '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c')
   AND NOT EXISTS (SELECT 1 FROM communications WHERE client_id = '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c')
   AND NOT EXISTS (SELECT 1 FROM estimate_requests WHERE client_id = '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c')
   AND NOT EXISTS (SELECT 1 FROM properties WHERE client_id = '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c');

DELETE FROM clients
 WHERE id = '79738377-b314-49bc-b273-eb550c49d682'
   AND first_name = 'Test' AND last_name = 'Client'
   AND NOT EXISTS (SELECT 1 FROM jobs WHERE client_id = '79738377-b314-49bc-b273-eb550c49d682')
   AND NOT EXISTS (SELECT 1 FROM estimates WHERE client_id = '79738377-b314-49bc-b273-eb550c49d682')
   AND NOT EXISTS (SELECT 1 FROM communications WHERE client_id = '79738377-b314-49bc-b273-eb550c49d682')
   AND NOT EXISTS (SELECT 1 FROM estimate_requests WHERE client_id = '79738377-b314-49bc-b273-eb550c49d682')
   AND NOT EXISTS (SELECT 1 FROM properties WHERE client_id = '79738377-b314-49bc-b273-eb550c49d682');

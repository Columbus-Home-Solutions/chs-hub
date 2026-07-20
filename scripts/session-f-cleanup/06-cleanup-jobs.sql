-- Session F Phase 2 — 06: Delete JOB-100 through JOB-110 (FK-order fixed)
-- Prerequisites: files 01–05 already run (most children cleared).
--
-- LIVE BLOCKER (remote probe after 01–05):
--   bid_requests.job_id → jobs(id)                 — 7 rows (JOB-100, JOB-104)
--   bid_request_recipients.bid_request_id → bid_requests(id) — 8 rows
--   bid_submissions.bid_request_id → bid_requests(id)       — 5 rows
--   photos.bid_request_id → bid_requests(id)                — 1 row
-- These Sprint-38 bid tables were never targeted by 01–05.
--
-- Also detach (already in original script):
--   estimate_requests.converted_job_id → jobs(id)  — 8 rows (NULL before delete)
--   users.current_job_id → jobs(id)
--
-- Full REFERENCES-jobs sweep (all other tables were 0 rows for these job ids):
--   billing_cycles, billing_schedule, change_orders, client_lien_waivers,
--   communications, daily_logs, documents, expenses, files, invoices,
--   job_documents, lien_waivers, line_items, mileage, notification_logs,
--   payments, permits, punch_lists/items, quotes, schedule_entries,
--   selections, smart_notes, social_posts, tasks, time_entries, warranties,
--   warranty_calls, photos.job_id
--
-- Delete order:
--   1) Detach photos / submission photo FKs into bid_requests
--   2) DELETE bid_submissions → recipients → bid_requests
--   3) NULL estimate_requests.converted_job_id + users.current_job_id
--   4) NULL jobs.estimate_id (for file 07)
--   5) DELETE jobs

-- ========== PREVIEW COUNTS ==========
SELECT 'jobs' AS tbl, COUNT(*) AS n FROM jobs
 WHERE id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d', -- 100
   '4dca37fb-8df3-49d0-9a42-f5c11e52ffd8', -- 101
   '1de4f226-3f26-4388-9472-6a7979e8966b', -- 102
   '0f6420d6-4aaf-431c-a662-9c3964335dbe', -- 103
   '971d7222-66a9-4c67-8ba1-7bb0ec431830', -- 104
   'a420c3be-d984-4af8-a73d-8712ed963bb3', -- 105
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870', -- 106
   '19238d70-7aaa-45f1-94eb-7d3fd67be7f4', -- 107
   '760c1458-3d76-48b9-8258-0d48fe611a1b', -- 108
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44', -- 109
   '2645c483-569c-48f6-8fc1-9e6aa1c41255'  -- 110
 );

SELECT job_number, id, status, billing_model, client_id FROM jobs
 WHERE id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
   '2645c483-569c-48f6-8fc1-9e6aa1c41255'
 )
 ORDER BY job_number;

SELECT 'bid_requests' AS tbl, COUNT(*) AS n FROM bid_requests
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
   '2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );
SELECT 'bid_submissions' AS tbl, COUNT(*) AS n FROM bid_submissions
 WHERE bid_request_id IN (
   SELECT id FROM bid_requests WHERE job_id IN (
     '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
     '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
     '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
     '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
     '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
     '2645c483-569c-48f6-8fc1-9e6aa1c41255'
   )
 );
SELECT 'bid_request_recipients' AS tbl, COUNT(*) AS n FROM bid_request_recipients
 WHERE bid_request_id IN (
   SELECT id FROM bid_requests WHERE job_id IN (
     '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
     '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
     '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
     '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
     '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
     '2645c483-569c-48f6-8fc1-9e6aa1c41255'
   )
 );
SELECT 'estimate_requests.converted_job_id' AS tbl, COUNT(*) AS n FROM estimate_requests
 WHERE converted_job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
   '2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

-- ========== 1) DETACH bid photo FKs ==========
UPDATE bid_submissions
   SET attachment_photo_id = NULL
 WHERE bid_request_id IN (
   SELECT id FROM bid_requests WHERE job_id IN (
     '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
     '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
     '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
     '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
     '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
     '2645c483-569c-48f6-8fc1-9e6aa1c41255'
   )
 );

UPDATE photos
   SET bid_request_id = NULL
 WHERE bid_request_id IN (
   SELECT id FROM bid_requests WHERE job_id IN (
     '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
     '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
     '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
     '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
     '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
     '2645c483-569c-48f6-8fc1-9e6aa1c41255'
   )
 );

UPDATE schedule_entries
   SET bid_request_id = NULL
 WHERE bid_request_id IN (
   SELECT id FROM bid_requests WHERE job_id IN (
     '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
     '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
     '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
     '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
     '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
     '2645c483-569c-48f6-8fc1-9e6aa1c41255'
   )
 );

-- ========== 2) DELETE bid children → bid_requests ==========
DELETE FROM bid_submissions
 WHERE bid_request_id IN (
   SELECT id FROM bid_requests WHERE job_id IN (
     '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
     '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
     '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
     '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
     '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
     '2645c483-569c-48f6-8fc1-9e6aa1c41255'
   )
 );

DELETE FROM bid_request_recipients
 WHERE bid_request_id IN (
   SELECT id FROM bid_requests WHERE job_id IN (
     '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
     '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
     '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
     '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
     '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
     '2645c483-569c-48f6-8fc1-9e6aa1c41255'
   )
 );

DELETE FROM bid_requests
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
   '2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

-- ========== 3) DETACH soft job pointers ==========
UPDATE estimate_requests SET converted_job_id = NULL
 WHERE converted_job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
   '2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

UPDATE users SET current_job_id = NULL
 WHERE current_job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
   '2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

-- Null jobs.estimate_id so converted estimates can be deleted in file 07
UPDATE jobs SET estimate_id = NULL
 WHERE id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
   '2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

-- ========== 4) DELETE jobs ==========
DELETE FROM jobs
 WHERE id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
   '2645c483-569c-48f6-8fc1-9e6aa1c41255'
 )
 AND job_number IN (100,101,102,103,104,105,106,107,108,109,110);

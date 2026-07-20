-- Session F Phase 2 — 02: Fixed-price job children (JOB-100–107, 109–110)
-- Explicit job IDs from Phase 1 inventory. JOB-108 excluded (handled in 01).
-- DB rows only. Does NOT delete Drive/R2 objects.
--
-- Also clears FK blockers not listed in the task prose but required before jobs
-- can be deleted later: expenses/payments/invoices, change_orders, job_documents,
-- daily_logs, etc. on these jobs.

-- Fixed-price job id list:
--   100 1c040987-270a-482e-5f50-6a293a7b8c9d
--   101 4dca37fb-8df3-49d0-9a42-f5c11e52ffd8
--   102 1de4f226-3f26-4388-9472-6a7979e8966b
--   103 0f6420d6-4aaf-431c-a662-9c3964335dbe
--   104 971d7222-66a9-4c67-8ba1-7bb0ec431830
--   105 a420c3be-d984-4af8-a73d-8712ed963bb3
--   106 1ba146fe-1b8d-4918-aa40-b58a5d6e2870
--   107 19238d70-7aaa-45f1-94eb-7d3fd67be7f4
--   109 1cddd144-2a08-4c17-ab0e-0a70d086fb44
--   110 2645c483-569c-48f6-8fc1-9e6aa1c41255

-- Linked converted estimates (for payment_schedules / selections):
--   99001 4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f
--   99002 1425c3da-3401-498a-b6a7-3bafb63d9375
--   99003 b375f3d5-db89-4cd7-9e76-53d2636cc984
--   99005 c5165a41-7366-4498-b34c-e449dd7acbb0
--   99008 f10487bc-c6ef-4685-b28d-ee2987b01304
--   99012 dc73cbef-34e1-4ebb-91da-4ef181e72b38
--   99014 ad4868f2-2632-4f14-80f6-5fa09564134f

-- ========== PREVIEW COUNTS ==========
SELECT 'billing_schedule' AS tbl, COUNT(*) AS n FROM billing_schedule
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );
SELECT 'tasks' AS tbl, COUNT(*) AS n FROM tasks
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );
SELECT 'photos' AS tbl, COUNT(*) AS n FROM photos
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );
SELECT 'expenses_fp' AS tbl, COUNT(*) AS n FROM expenses
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );
SELECT 'invoices_fp' AS tbl, COUNT(*) AS n FROM invoices
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );
SELECT 'payment_schedules_converted_fp' AS tbl, COUNT(*) AS n FROM payment_schedules
 WHERE estimate_id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','dc73cbef-34e1-4ebb-91da-4ef181e72b38',
   'ad4868f2-2632-4f14-80f6-5fa09564134f'
 );
SELECT 'selections_fp' AS tbl, COUNT(*) AS n FROM selections
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 ) OR estimate_id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','dc73cbef-34e1-4ebb-91da-4ef181e72b38',
   'ad4868f2-2632-4f14-80f6-5fa09564134f'
 );
SELECT 'change_orders' AS tbl, COUNT(*) AS n FROM change_orders
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );
SELECT 'job_documents' AS tbl, COUNT(*) AS n FROM job_documents
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );
SELECT 'daily_logs' AS tbl, COUNT(*) AS n FROM daily_logs
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

-- ========== DETACH ==========
UPDATE expenses SET receipt_photo_id = NULL
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

UPDATE photos SET before_after_pair_id = NULL
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

UPDATE selections SET chosen_choice_id = NULL
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 ) OR estimate_id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','dc73cbef-34e1-4ebb-91da-4ef181e72b38',
   'ad4868f2-2632-4f14-80f6-5fa09564134f'
 );

UPDATE users SET current_job_id = NULL
 WHERE current_job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

-- ========== DELETE ==========
DELETE FROM receipt_photos
 WHERE expense_id IN (
   SELECT id FROM expenses WHERE job_id IN (
     '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
     '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
     '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
     '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
     '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
   )
 );

DELETE FROM expense_line_items
 WHERE expense_id IN (
   SELECT id FROM expenses WHERE job_id IN (
     '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
     '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
     '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
     '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
     '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
   )
 );

DELETE FROM payments
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM invoices
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM expenses
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM selection_choices
 WHERE selection_id IN (
   SELECT id FROM selections WHERE job_id IN (
     '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
     '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
     '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
     '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
     '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
   ) OR estimate_id IN (
     '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
     'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
     'f10487bc-c6ef-4685-b28d-ee2987b01304','dc73cbef-34e1-4ebb-91da-4ef181e72b38',
     'ad4868f2-2632-4f14-80f6-5fa09564134f'
   )
 );

DELETE FROM selections
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 ) OR estimate_id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','dc73cbef-34e1-4ebb-91da-4ef181e72b38',
   'ad4868f2-2632-4f14-80f6-5fa09564134f'
 );

DELETE FROM payment_schedules
 WHERE estimate_id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','dc73cbef-34e1-4ebb-91da-4ef181e72b38',
   'ad4868f2-2632-4f14-80f6-5fa09564134f'
 );

DELETE FROM billing_schedule
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM tasks
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM photos
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM time_entries
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM change_orders
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM signature_events
 WHERE job_document_id IN (
   SELECT id FROM job_documents WHERE job_id IN (
     '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
     '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
     '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
     '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
     '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
   )
 );

DELETE FROM job_documents
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM daily_logs
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM schedule_entries
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM permits
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM mileage
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM lien_waivers
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM social_posts
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM smart_notes
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM quotes
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

DELETE FROM line_items
 WHERE job_id IN (
   '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
   '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
   '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
   '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
   '1cddd144-2a08-4c17-ab0e-0a70d086fb44','2645c483-569c-48f6-8fc1-9e6aa1c41255'
 );

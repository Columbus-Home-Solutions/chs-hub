-- Session F Phase 2 — 07: Converted estimates (were linked to jobs now deleted in 06)
--   99001 4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f  → was JOB-100
--   99002 1425c3da-3401-498a-b6a7-3bafb63d9375  → was JOB-101
--   99003 b375f3d5-db89-4cd7-9e76-53d2636cc984  → was JOB-102
--   99005 c5165a41-7366-4498-b34c-e449dd7acbb0  → was JOB-103
--   99008 f10487bc-c6ef-4685-b28d-ee2987b01304  → was JOB-104
--   99011 72e7a79a-d034-4de0-9db6-ed65be3fa99f  → was JOB-108
--   99012 dc73cbef-34e1-4ebb-91da-4ef181e72b38  → was JOB-109
--   99014 ad4868f2-2632-4f14-80f6-5fa09564134f  → was JOB-110
--
-- Remaining estimate children (line items etc.) cleared here if not already gone.

-- ========== PREVIEW COUNTS ==========
SELECT 'converted_estimates' AS tbl, COUNT(*) AS n FROM estimates
 WHERE id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','72e7a79a-d034-4de0-9db6-ed65be3fa99f',
   'dc73cbef-34e1-4ebb-91da-4ef181e72b38','ad4868f2-2632-4f14-80f6-5fa09564134f'
 );
SELECT estimate_number, id, status, billing_model FROM estimates
 WHERE id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','72e7a79a-d034-4de0-9db6-ed65be3fa99f',
   'dc73cbef-34e1-4ebb-91da-4ef181e72b38','ad4868f2-2632-4f14-80f6-5fa09564134f'
 )
 ORDER BY estimate_number;
SELECT 'estimate_line_items' AS tbl, COUNT(*) AS n FROM estimate_line_items
 WHERE estimate_id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','72e7a79a-d034-4de0-9db6-ed65be3fa99f',
   'dc73cbef-34e1-4ebb-91da-4ef181e72b38','ad4868f2-2632-4f14-80f6-5fa09564134f'
 );

-- ========== DETACH ==========
UPDATE estimate_requests SET estimate_id = NULL
 WHERE estimate_id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','72e7a79a-d034-4de0-9db6-ed65be3fa99f',
   'dc73cbef-34e1-4ebb-91da-4ef181e72b38','ad4868f2-2632-4f14-80f6-5fa09564134f'
 );

UPDATE estimates SET revised_from_id = NULL
 WHERE revised_from_id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','72e7a79a-d034-4de0-9db6-ed65be3fa99f',
   'dc73cbef-34e1-4ebb-91da-4ef181e72b38','ad4868f2-2632-4f14-80f6-5fa09564134f'
 );

-- ========== DELETE REMAINING CHILDREN ==========
DELETE FROM payments
 WHERE estimate_id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','72e7a79a-d034-4de0-9db6-ed65be3fa99f',
   'dc73cbef-34e1-4ebb-91da-4ef181e72b38','ad4868f2-2632-4f14-80f6-5fa09564134f'
 );

DELETE FROM selection_choices
 WHERE selection_id IN (
   SELECT id FROM selections WHERE estimate_id IN (
     '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
     'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
     'f10487bc-c6ef-4685-b28d-ee2987b01304','72e7a79a-d034-4de0-9db6-ed65be3fa99f',
     'dc73cbef-34e1-4ebb-91da-4ef181e72b38','ad4868f2-2632-4f14-80f6-5fa09564134f'
   )
 );

DELETE FROM selections
 WHERE estimate_id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','72e7a79a-d034-4de0-9db6-ed65be3fa99f',
   'dc73cbef-34e1-4ebb-91da-4ef181e72b38','ad4868f2-2632-4f14-80f6-5fa09564134f'
 );

DELETE FROM payment_schedules
 WHERE estimate_id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','72e7a79a-d034-4de0-9db6-ed65be3fa99f',
   'dc73cbef-34e1-4ebb-91da-4ef181e72b38','ad4868f2-2632-4f14-80f6-5fa09564134f'
 );

DELETE FROM estimate_sub_items
 WHERE parent_line_item_id IN (
   SELECT id FROM estimate_line_items WHERE estimate_id IN (
     '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
     'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
     'f10487bc-c6ef-4685-b28d-ee2987b01304','72e7a79a-d034-4de0-9db6-ed65be3fa99f',
     'dc73cbef-34e1-4ebb-91da-4ef181e72b38','ad4868f2-2632-4f14-80f6-5fa09564134f'
   )
 );

UPDATE estimate_line_items SET blocked_by_line_item_id = NULL
 WHERE estimate_id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','72e7a79a-d034-4de0-9db6-ed65be3fa99f',
   'dc73cbef-34e1-4ebb-91da-4ef181e72b38','ad4868f2-2632-4f14-80f6-5fa09564134f'
 );

DELETE FROM estimate_line_items
 WHERE estimate_id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','72e7a79a-d034-4de0-9db6-ed65be3fa99f',
   'dc73cbef-34e1-4ebb-91da-4ef181e72b38','ad4868f2-2632-4f14-80f6-5fa09564134f'
 );

DELETE FROM files
 WHERE estimate_id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','72e7a79a-d034-4de0-9db6-ed65be3fa99f',
   'dc73cbef-34e1-4ebb-91da-4ef181e72b38','ad4868f2-2632-4f14-80f6-5fa09564134f'
 );

-- ========== DELETE ESTIMATES ==========
DELETE FROM estimates
 WHERE id IN (
   '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
   'b375f3d5-db89-4cd7-9e76-53d2636cc984','c5165a41-7366-4498-b34c-e449dd7acbb0',
   'f10487bc-c6ef-4685-b28d-ee2987b01304','72e7a79a-d034-4de0-9db6-ed65be3fa99f',
   'dc73cbef-34e1-4ebb-91da-4ef181e72b38','ad4868f2-2632-4f14-80f6-5fa09564134f'
 )
 AND estimate_number IN (99001,99002,99003,99005,99008,99011,99012,99014);

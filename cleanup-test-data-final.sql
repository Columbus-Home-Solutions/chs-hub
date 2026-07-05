-- Pre-Launch Test Data Cleanup — CONFIRMED FINAL
-- Generated 2026-07-05. Confirmed by Tony: remove "test test" client AND JOB-100 (Link Columbus, test vehicle).
--
-- ⚠️ BACK UP FIRST — run this before anything else:
--   npx wrangler d1 export chs-hub-db --remote --output=backup-pre-testdata-cleanup-20260705.sql
--
-- Run this script with:
--   npx wrangler d1 execute chs-hub-db --remote --file=cleanup-test-data-final.sql

-- ============================================================
-- PART 1 — "test test" client (zero financial impact)
-- ============================================================

-- Photos linked to the test estimate request (none found, defensive)
DELETE FROM photos WHERE estimate_request_id = '4a3ba535-460f-4c8d-b3c9-2aba18294854';

-- Estimate request itself
DELETE FROM estimate_requests WHERE id = '4a3ba535-460f-4c8d-b3c9-2aba18294854'
  AND client_id = '037f35b6-0e06-4c95-983b-dcf00e126c9f'; -- belt+suspenders guard

-- Client record (last, after all dependents removed)
DELETE FROM clients WHERE id = '037f35b6-0e06-4c95-983b-dcf00e126c9f'
  AND first_name = 'test' AND last_name = 'test'; -- belt+suspenders guard

-- ============================================================
-- PART 2 — JOB-100 "Link Columbus" (confirmed test vehicle by Tony)
-- ============================================================

-- Photos (4 in R2) — soft-delete per platform photo rules; R2 objects stay permanent
UPDATE photos SET is_active = 0 WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

-- Expense (1 real Lowe's receipt, $243.52)
DELETE FROM expenses WHERE id = 'b9ec7e83-4bf3-406a-b62e-8a79251b9bb0'
  AND job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

-- Payments (3 records, $4,500 total — both invoices already settled, zero AR impact)
DELETE FROM payments WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

-- Invoices (2 records — #1 paid $1,500, #2 void $1,500)
DELETE FROM invoices WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

-- Job itself
DELETE FROM jobs WHERE id = 'a900736b-0efd-44f2-89aa-76fec4155a60'
  AND job_number = 100;

-- Client "Link Columbus" — only delete if no other jobs remain for this client
DELETE FROM clients
 WHERE id = (SELECT client_id FROM jobs WHERE id = 'a900736b-0efd-44f2-89aa-76fec4155a60')
   AND NOT EXISTS (
     SELECT 1 FROM jobs WHERE client_id = (SELECT client_id FROM jobs WHERE id = 'a900736b-0efd-44f2-89aa-76fec4155a60')
       AND id != 'a900736b-0efd-44f2-89aa-76fec4155a60'
   );

-- ============================================================
-- VERIFY AFTER RUNNING
-- ============================================================
-- SELECT COUNT(*) FROM clients WHERE id IN ('037f35b6-0e06-4c95-983b-dcf00e126c9f');  -- expect 0
-- SELECT COUNT(*) FROM jobs WHERE id = 'a900736b-0efd-44f2-89aa-76fec4155a60';          -- expect 0
-- SELECT COUNT(*) FROM invoices WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';  -- expect 0

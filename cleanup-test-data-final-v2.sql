-- Pre-Launch Test Data Cleanup — CORRECTED (v2)
-- Fixes FK constraint failure from v1: added all 19 job_id-referencing tables,
-- fixed expenses-before-photos ordering (expenses.receipt_photo_id -> photos),
-- and detached estimate_requests.converted_job_id + photos.before_after_pair_id
-- self-reference before deleting.
--
-- Your backup from earlier already covers this — no need to re-run it.
--
-- Run with:
--   npx wrangler d1 execute chs-hub-db --remote --file=cleanup-test-data-final-v2.sql

-- ============================================================
-- PART 1 — "test test" client (zero financial impact)
-- ============================================================

DELETE FROM photos WHERE estimate_request_id = '4a3ba535-460f-4c8d-b3c9-2aba18294854';

DELETE FROM estimate_requests WHERE id = '4a3ba535-460f-4c8d-b3c9-2aba18294854'
  AND client_id = '037f35b6-0e06-4c95-983b-dcf00e126c9f';

DELETE FROM clients WHERE id = '037f35b6-0e06-4c95-983b-dcf00e126c9f'
  AND first_name = 'test' AND last_name = 'test';

-- ============================================================
-- PART 2 — JOB-100 "Link Columbus" (confirmed test vehicle by Tony)
-- ============================================================

-- Detach anything that could self-reference or dangle before deleting rows
UPDATE estimate_requests SET converted_job_id = NULL
  WHERE converted_job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

UPDATE photos SET before_after_pair_id = NULL
  WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

-- Expenses BEFORE photos (expenses.receipt_photo_id -> photos)
DELETE FROM expenses WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

-- Photos (hard delete for this full job purge — R2 objects are orphaned but
-- harmless; this is not the single-photo soft-delete case)
DELETE FROM photos WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

-- All other job_id-referencing tables (harmless no-ops for any that are empty)
DELETE FROM communications   WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM daily_logs       WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM change_orders    WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM schedule_entries WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM permits          WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM warranties       WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM time_entries     WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM billing_cycles   WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM mileage          WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM lien_waivers     WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM documents        WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM notification_logs WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM social_posts     WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM smart_notes      WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM tasks            WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

-- Payments and invoices ($4,500 in payments, 2 settled invoices — zero AR impact)
DELETE FROM payments WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
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

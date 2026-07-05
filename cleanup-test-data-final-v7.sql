-- Pre-Launch Test Data Cleanup — CORRECTED (v7)
-- Built by tracing EVERY foreign key in the full live schema dump (79 tables).
-- Adds two non-cascade FKs found this pass:
--   receipt_photos.expense_id -> expenses(id)          (no cascade)
--   signature_events.job_document_id -> job_documents(id) (no cascade, NOT NULL)
-- Part 1 was fixed in v6 (was missing notification_logs/documents/communications/
-- estimates for the test client — likely the true root cause of every prior failure,
-- since the whole file rolls back atomically and Part 2 was never actually reached).
--
-- Your backup from earlier already covers this — no need to re-run it.
--
-- Run with:
--   npx wrangler d1 execute chs-hub-db --remote --file=cleanup-test-data-final-v7.sql

PRAGMA defer_foreign_keys = TRUE;

-- ============================================================
-- PART 1 — "test test" client (zero financial impact)
-- Client ID:   037f35b6-0e06-4c95-983b-dcf00e126c9f
-- Request ID:  4a3ba535-460f-4c8d-b3c9-2aba18294854
-- Estimate ID: c5859f38-4053-47ce-b07a-dc1e62d7a4e5
-- ============================================================

UPDATE estimate_requests SET estimate_id = NULL
  WHERE id = '4a3ba535-460f-4c8d-b3c9-2aba18294854';

DELETE FROM notification_logs WHERE client_id = '037f35b6-0e06-4c95-983b-dcf00e126c9f'
  OR estimate_request_id = '4a3ba535-460f-4c8d-b3c9-2aba18294854';

DELETE FROM documents WHERE client_id = '037f35b6-0e06-4c95-983b-dcf00e126c9f'
  OR estimate_id = 'c5859f38-4053-47ce-b07a-dc1e62d7a4e5';

DELETE FROM communications WHERE client_id = '037f35b6-0e06-4c95-983b-dcf00e126c9f';

DELETE FROM files WHERE estimate_id = 'c5859f38-4053-47ce-b07a-dc1e62d7a4e5';

UPDATE google_reviews SET matched_client_id = NULL
  WHERE matched_client_id = '037f35b6-0e06-4c95-983b-dcf00e126c9f';

DELETE FROM photos WHERE estimate_request_id = '4a3ba535-460f-4c8d-b3c9-2aba18294854';

DELETE FROM estimates WHERE id = 'c5859f38-4053-47ce-b07a-dc1e62d7a4e5';

DELETE FROM estimate_requests WHERE id = '4a3ba535-460f-4c8d-b3c9-2aba18294854'
  AND client_id = '037f35b6-0e06-4c95-983b-dcf00e126c9f';

DELETE FROM clients WHERE id = '037f35b6-0e06-4c95-983b-dcf00e126c9f'
  AND first_name = 'test' AND last_name = 'test';

-- ============================================================
-- PART 2 — JOB-100 "Link Columbus" (confirmed test vehicle by Tony)
-- Client ID: cc994be0-d17b-4f66-9688-f3253b897910
-- Job ID:    a900736b-0efd-44f2-89aa-76fec4155a60
-- ============================================================

UPDATE expenses SET receipt_photo_id = NULL
  WHERE receipt_photo_id IN (SELECT id FROM photos WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60');

UPDATE estimate_requests SET converted_job_id = NULL
  WHERE converted_job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

UPDATE photos SET before_after_pair_id = NULL
  WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

UPDATE users SET current_job_id = NULL
  WHERE current_job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

UPDATE google_reviews SET matched_client_id = NULL
  WHERE matched_client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';

-- NEW IN v7 — clear non-cascade children before deleting their parents
DELETE FROM receipt_photos WHERE expense_id IN (
  SELECT id FROM expenses WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60'
);
DELETE FROM signature_events WHERE job_document_id IN (
  SELECT id FROM job_documents WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60'
);

DELETE FROM expenses WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM photos WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

DELETE FROM photos WHERE estimate_request_id IN (
  SELECT id FROM estimate_requests WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910'
);

DELETE FROM quotes            WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM files             WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM billing_schedule  WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM job_documents     WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM communications    WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM daily_logs        WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM change_orders     WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM schedule_entries  WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM permits           WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM warranties        WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM time_entries      WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM billing_cycles    WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM mileage           WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM lien_waivers      WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM documents         WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM notification_logs WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM social_posts      WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM smart_notes       WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM tasks             WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

DELETE FROM payments WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM invoices WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

DELETE FROM jobs WHERE id = 'a900736b-0efd-44f2-89aa-76fec4155a60'
  AND job_number = 100;

DELETE FROM quotes            WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM communications    WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM notification_logs WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM documents         WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM properties        WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM estimates         WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM estimate_requests WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';

DELETE FROM clients WHERE id = 'cc994be0-d17b-4f66-9688-f3253b897910';

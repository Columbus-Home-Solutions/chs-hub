-- Pre-Launch Test Data Cleanup — CORRECTED (v4)
-- v3 failed because deleting the CLIENT record also requires clearing every
-- client_id-scoped reference, not just job_id-scoped ones. Confirmed counts:
-- communications=23 (5 job-linked, 18 not), notification_logs=21 (7 job-linked,
-- 14 not), estimate_requests=2, estimates=3, documents=1 (same as job-scoped),
-- properties=0. Client ID confirmed: cc994be0-d17b-4f66-9688-f3253b897910
--
-- Your backup from earlier already covers this — no need to re-run it.
--
-- Run with:
--   npx wrangler d1 execute chs-hub-db --remote --file=cleanup-test-data-final-v4.sql

PRAGMA defer_foreign_keys = TRUE;

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
-- Client ID: cc994be0-d17b-4f66-9688-f3253b897910
-- Job ID:    a900736b-0efd-44f2-89aa-76fec4155a60
-- ============================================================

-- Detach references before deleting
UPDATE expenses SET receipt_photo_id = NULL
  WHERE receipt_photo_id IN (SELECT id FROM photos WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60');

UPDATE estimate_requests SET converted_job_id = NULL
  WHERE converted_job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

UPDATE photos SET before_after_pair_id = NULL
  WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

-- Job's own expenses and photos
DELETE FROM expenses WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM photos WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

-- Any visit-capture photos tied to this client's estimate requests (not job-linked)
DELETE FROM photos WHERE estimate_request_id IN (
  SELECT id FROM estimate_requests WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910'
);

-- Job-scoped tables
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

-- Payments and invoices
DELETE FROM payments WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM invoices WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM invoices WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910'; -- defensive, catches non-job-linked

-- Job itself
DELETE FROM jobs WHERE id = 'a900736b-0efd-44f2-89aa-76fec4155a60'
  AND job_number = 100;

-- ------------------------------------------------------------
-- NEW IN v4 — everything scoped to the CLIENT directly, not just the job
-- ------------------------------------------------------------
DELETE FROM communications    WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM notification_logs WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM documents         WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM properties        WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';

-- Estimates before estimate_requests (estimates.request_id -> estimate_requests.id)
-- ON DELETE CASCADE on estimate_line_items/payment_schedules handles those automatically
DELETE FROM estimates         WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM estimate_requests WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';

-- Client "Link Columbus" — last
DELETE FROM clients WHERE id = 'cc994be0-d17b-4f66-9688-f3253b897910';

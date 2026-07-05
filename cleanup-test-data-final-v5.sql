-- Pre-Launch Test Data Cleanup — CORRECTED (v5)
-- Built directly from live sqlite_master CREATE TABLE output, not the markdown
-- schema doc, which was missing: quotes (job_id + client_id), files, billing_schedule,
-- job_documents, google_reviews.matched_client_id. Confirmed CASCADE (no action
-- needed): warranty_calls, client_lien_waivers, punch_lists, punch_list_items,
-- client_contacts, client_tags.
--
-- Your backup from earlier already covers this — no need to re-run it.
--
-- Run with:
--   npx wrangler d1 execute chs-hub-db --remote --file=cleanup-test-data-final-v5.sql

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

UPDATE users SET current_job_id = NULL
  WHERE current_job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

UPDATE google_reviews SET matched_client_id = NULL
  WHERE matched_client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';

-- Job's own expenses and photos
DELETE FROM expenses WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM photos WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

-- Any visit-capture photos tied to this client's estimate requests (not job-linked)
DELETE FROM photos WHERE estimate_request_id IN (
  SELECT id FROM estimate_requests WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910'
);

-- Job-scoped tables (full set confirmed against live schema, including
-- previously-missing quotes/files/billing_schedule/job_documents)
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
-- (warranty_calls, client_lien_waivers, punch_lists, punch_list_items are
--  ON DELETE CASCADE via job_id — cleaned up automatically when jobs row is deleted)

-- Payments and invoices
DELETE FROM payments WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM invoices WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

-- Job itself
DELETE FROM jobs WHERE id = 'a900736b-0efd-44f2-89aa-76fec4155a60'
  AND job_number = 100;

-- ------------------------------------------------------------
-- Client-scoped cleanup ("Link Columbus" client record)
-- ------------------------------------------------------------
DELETE FROM quotes            WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM communications    WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM notification_logs WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM documents         WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM properties        WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';

-- Estimates before estimate_requests (estimates.request_id -> estimate_requests.id)
DELETE FROM estimates         WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM estimate_requests WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
-- (client_contacts, client_tags are ON DELETE CASCADE via client_id — automatic)

-- Client "Link Columbus" — last
DELETE FROM clients WHERE id = 'cc994be0-d17b-4f66-9688-f3253b897910';

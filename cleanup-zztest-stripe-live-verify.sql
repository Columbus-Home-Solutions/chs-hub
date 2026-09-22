-- =============================================================================
-- ZZTEST Stripe Live Verification — cleanup after successful $1.04 live pay
-- =============================================================================
-- Safe: only the c3000001-… fixture IDs plus the job/payment created by
-- quote-to-job on 2026-08-28. Does not touch other ZZTEST clients or real data.
--
-- Run:
--   npx wrangler d1 execute chs-hub-db --remote --file=cleanup-zztest-stripe-live-verify.sql
-- =============================================================================

-- Client          c3000001-0000-4000-8000-000000000001
-- Property        …0002
-- Est. request    …0010
-- Estimate        …0020
-- Job (created)   ca73dc28-3cd8-4db2-9286-80d3595b80c6  (JOB-101)
-- Payment         c669d5b2-06e2-4c5b-86ee-b502216b48e6

UPDATE estimate_requests
SET converted_job_id = NULL,
    estimate_id = NULL
WHERE id = 'c3000001-0000-4000-8000-000000000010'
   OR converted_job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';

UPDATE users SET current_job_id = NULL WHERE current_job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';

DELETE FROM expenses WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM photos WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM notification_logs
 WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6'
    OR client_id = 'c3000001-0000-4000-8000-000000000001'
    OR estimate_request_id = 'c3000001-0000-4000-8000-000000000010';
DELETE FROM communications
 WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6'
    OR client_id = 'c3000001-0000-4000-8000-000000000001';
DELETE FROM daily_logs WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM change_orders WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM schedule_entries WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM permits WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM warranties WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM time_entries WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM billing_cycles WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM billing_schedule WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM mileage WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM lien_waivers WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM documents
 WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6'
    OR estimate_id = 'c3000001-0000-4000-8000-000000000020';
DELETE FROM job_documents WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM job_files WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM files WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM social_posts WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM smart_notes WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM tasks WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM punch_list_items WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM punch_lists WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM line_items WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM client_lien_waivers WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM warranty_calls WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';

DELETE FROM payments
 WHERE id = 'c669d5b2-06e2-4c5b-86ee-b502216b48e6'
    OR job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM invoices WHERE job_id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';
DELETE FROM jobs WHERE id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6';

DELETE FROM selection_choices
 WHERE selection_id IN (
   SELECT id FROM selections WHERE estimate_id = 'c3000001-0000-4000-8000-000000000020'
 );
DELETE FROM selections WHERE estimate_id = 'c3000001-0000-4000-8000-000000000020';
DELETE FROM estimate_sub_items WHERE estimate_id = 'c3000001-0000-4000-8000-000000000020';
DELETE FROM estimate_line_items WHERE estimate_id = 'c3000001-0000-4000-8000-000000000020';
DELETE FROM payment_schedules WHERE estimate_id = 'c3000001-0000-4000-8000-000000000020';
DELETE FROM bid_requests WHERE estimate_id = 'c3000001-0000-4000-8000-000000000020';
DELETE FROM estimates WHERE id = 'c3000001-0000-4000-8000-000000000020';
DELETE FROM estimate_requests WHERE id = 'c3000001-0000-4000-8000-000000000010';

DELETE FROM client_contacts WHERE client_id = 'c3000001-0000-4000-8000-000000000001';
DELETE FROM client_tags WHERE client_id = 'c3000001-0000-4000-8000-000000000001';
DELETE FROM quotes WHERE client_id = 'c3000001-0000-4000-8000-000000000001';
DELETE FROM properties WHERE id = 'c3000001-0000-4000-8000-000000000002'
   OR client_id = 'c3000001-0000-4000-8000-000000000001';
DELETE FROM clients WHERE id = 'c3000001-0000-4000-8000-000000000001';

SELECT
  (SELECT COUNT(*) FROM clients WHERE id = 'c3000001-0000-4000-8000-000000000001') AS clients_left,
  (SELECT COUNT(*) FROM estimates WHERE id = 'c3000001-0000-4000-8000-000000000020') AS estimates_left,
  (SELECT COUNT(*) FROM jobs WHERE id = 'ca73dc28-3cd8-4db2-9286-80d3595b80c6') AS jobs_left,
  (SELECT COUNT(*) FROM payments WHERE id = 'c669d5b2-06e2-4c5b-86ee-b502216b48e6') AS payments_left;

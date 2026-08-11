-- =============================================================================
-- ZZTEST-JOBDETAIL — cleanup (FK-safe delete order)
-- =============================================================================
-- Run:
--   npx wrangler d1 execute chs-hub-db --remote --file=cleanup-zztest-jobdetail-review.sql
--
-- Safe: only touches fixed ZZTEST-JOBDETAIL IDs below. Does not touch real data.
-- If you generated BoldSign docs / took photos on this job during review, those
-- job-scoped rows are removed too (R2 photo objects may orphan — fine for ZZTEST).
-- =============================================================================

-- Detach circular / reverse FKs
UPDATE estimate_requests
SET converted_job_id = NULL
WHERE converted_job_id = 'b1000001-0000-4000-8000-000000000030'
   OR id = 'b1000001-0000-4000-8000-000000000010';

UPDATE photos
SET before_after_pair_id = NULL
WHERE job_id = 'b1000001-0000-4000-8000-000000000030';

-- Punch list tokens → items → lists
DELETE FROM punch_list_sub_tokens
WHERE punch_list_id = 'b1000001-0000-4000-8000-000000000050';

DELETE FROM punch_list_items
WHERE job_id = 'b1000001-0000-4000-8000-000000000030'
   OR punch_list_id = 'b1000001-0000-4000-8000-000000000050';

DELETE FROM punch_lists
WHERE id = 'b1000001-0000-4000-8000-000000000050'
   OR job_id = 'b1000001-0000-4000-8000-000000000030';

-- Job children (harmless no-ops if empty)
DELETE FROM expenses WHERE job_id = 'b1000001-0000-4000-8000-000000000030';
DELETE FROM photos WHERE job_id = 'b1000001-0000-4000-8000-000000000030';
DELETE FROM communications WHERE job_id = 'b1000001-0000-4000-8000-000000000030'
   OR id IN (
     'b1000001-0000-4000-8000-000000000070',
     'b1000001-0000-4000-8000-000000000071'
   );
DELETE FROM daily_logs WHERE job_id = 'b1000001-0000-4000-8000-000000000030'
   OR id = 'b1000001-0000-4000-8000-000000000060';
DELETE FROM change_orders WHERE job_id = 'b1000001-0000-4000-8000-000000000030';
DELETE FROM schedule_entries WHERE job_id = 'b1000001-0000-4000-8000-000000000030';
DELETE FROM permits WHERE job_id = 'b1000001-0000-4000-8000-000000000030';
DELETE FROM warranties WHERE job_id = 'b1000001-0000-4000-8000-000000000030';
DELETE FROM time_entries WHERE job_id = 'b1000001-0000-4000-8000-000000000030';
DELETE FROM billing_cycles WHERE job_id = 'b1000001-0000-4000-8000-000000000030';
DELETE FROM billing_schedule WHERE job_id = 'b1000001-0000-4000-8000-000000000030';
DELETE FROM mileage WHERE job_id = 'b1000001-0000-4000-8000-000000000030';
DELETE FROM lien_waivers WHERE job_id = 'b1000001-0000-4000-8000-000000000030';
DELETE FROM documents WHERE job_id = 'b1000001-0000-4000-8000-000000000030';
DELETE FROM notification_logs WHERE job_id = 'b1000001-0000-4000-8000-000000000030';
DELETE FROM social_posts WHERE job_id = 'b1000001-0000-4000-8000-000000000030';
DELETE FROM smart_notes WHERE job_id = 'b1000001-0000-4000-8000-000000000030';
DELETE FROM tasks WHERE job_id = 'b1000001-0000-4000-8000-000000000030';

-- Generated docs (BoldSign review leftovers)
DELETE FROM job_documents WHERE job_id = 'b1000001-0000-4000-8000-000000000030';

DELETE FROM payments WHERE id = 'b1000001-0000-4000-8000-000000000031'
   OR job_id = 'b1000001-0000-4000-8000-000000000030';
DELETE FROM invoices WHERE job_id = 'b1000001-0000-4000-8000-000000000030';

DELETE FROM jobs WHERE id = 'b1000001-0000-4000-8000-000000000030';

-- Estimating chain
DELETE FROM estimate_requests WHERE id = 'b1000001-0000-4000-8000-000000000010';
DELETE FROM payment_schedules WHERE estimate_id = 'b1000001-0000-4000-8000-000000000020'
   OR id IN (
     'b1000001-0000-4000-8000-000000000024',
     'b1000001-0000-4000-8000-000000000025',
     'b1000001-0000-4000-8000-000000000026'
   );
DELETE FROM estimate_line_items WHERE estimate_id = 'b1000001-0000-4000-8000-000000000020';
DELETE FROM estimate_sub_items WHERE estimate_id = 'b1000001-0000-4000-8000-000000000020';
DELETE FROM estimates WHERE id = 'b1000001-0000-4000-8000-000000000020';

-- Client + properties (+ any client-only comms)
DELETE FROM communications WHERE client_id = 'b1000001-0000-4000-8000-000000000001';
DELETE FROM properties WHERE client_id = 'b1000001-0000-4000-8000-000000000001';
DELETE FROM clients WHERE id = 'b1000001-0000-4000-8000-000000000001';

-- Verify empty
SELECT
  (SELECT COUNT(*) FROM clients WHERE id = 'b1000001-0000-4000-8000-000000000001') AS clients_left,
  (SELECT COUNT(*) FROM jobs WHERE id = 'b1000001-0000-4000-8000-000000000030') AS jobs_left,
  (SELECT COUNT(*) FROM punch_lists WHERE id = 'b1000001-0000-4000-8000-000000000050') AS punch_lists_left;

-- Session F Phase 2 — 01: JOB-108 cost-plus children (FK-order fixed)
-- Scope: JOB-108 (760c1458-3d76-48b9-8258-0d48fe611a1b) only
-- Client: Test Client (79738377-b314-49bc-b273-eb550c49d682)
-- Linked estimate: EST-99011 (72e7a79a-d034-4de0-9db6-ed65be3fa99f)
-- DB rows only. Does NOT delete Drive/R2 objects.
--
-- CRITICAL FK (circular — must break before either parent delete):
--   billing_cycles.invoice_id              → invoices(id)
--   billing_cycles.reconciliation_invoice_id → invoices(id)
--   invoices.cost_plus_cycle_id            → billing_cycles(id)
-- Previous failure: DELETE invoices while cycles still pointed at them.
--
-- Delete order (children → parents):
--   1) Detach circular invoice ↔ cycle FKs + expense/photo/selection detaches
--   2) receipt / expense children
--   3) payments → invoices → expenses
--   4) punch children → punch_lists
--   5) warranties / warranty_calls
--   6) billing_cycles (after invoices gone + cycle→invoice FKs nulled)
--   7) EST-99011 selections / payment_schedules
--   8) Remaining JOB-108 job-scoped rows

-- ========== PREVIEW COUNTS ==========
SELECT 'billing_cycles' AS tbl, COUNT(*) AS n FROM billing_cycles
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
SELECT 'invoices' AS tbl, COUNT(*) AS n FROM invoices
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
SELECT 'payments' AS tbl, COUNT(*) AS n FROM payments
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
SELECT 'expenses' AS tbl, COUNT(*) AS n FROM expenses
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
SELECT 'expense_line_items' AS tbl, COUNT(*) AS n FROM expense_line_items
 WHERE expense_id IN (SELECT id FROM expenses WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b');
SELECT 'receipt_photos' AS tbl, COUNT(*) AS n FROM receipt_photos
 WHERE expense_id IN (SELECT id FROM expenses WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b');
SELECT 'punch_lists' AS tbl, COUNT(*) AS n FROM punch_lists
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
SELECT 'punch_list_items' AS tbl, COUNT(*) AS n FROM punch_list_items
 WHERE punch_list_id IN (SELECT id FROM punch_lists WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b');
SELECT 'punch_list_sub_tokens' AS tbl, COUNT(*) AS n FROM punch_list_sub_tokens
 WHERE punch_list_id IN (SELECT id FROM punch_lists WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b');
SELECT 'warranties' AS tbl, COUNT(*) AS n FROM warranties
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
SELECT 'payment_schedules_99011' AS tbl, COUNT(*) AS n FROM payment_schedules
 WHERE estimate_id = '72e7a79a-d034-4de0-9db6-ed65be3fa99f';
SELECT 'selections_99011' AS tbl, COUNT(*) AS n FROM selections
 WHERE estimate_id = '72e7a79a-d034-4de0-9db6-ed65be3fa99f'
    OR job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
SELECT 'cycles_pointing_at_invoices' AS tbl, COUNT(*) AS n FROM billing_cycles
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b'
   AND (invoice_id IS NOT NULL OR reconciliation_invoice_id IS NOT NULL);

-- ========== 1) DETACH (break circular + soft FKs) ==========
-- Break billing_cycles → invoices BEFORE deleting invoices
UPDATE billing_cycles
   SET invoice_id = NULL,
       reconciliation_invoice_id = NULL
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';

-- Break invoices → billing_cycles before deleting cycles (also safe before invoice delete)
UPDATE invoices
   SET cost_plus_cycle_id = NULL
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';

-- expenses.receipt_photo_id → photos(id)
UPDATE expenses SET receipt_photo_id = NULL
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';

-- selections.chosen_choice_id → selection_choices(id)
UPDATE selections SET chosen_choice_id = NULL
 WHERE estimate_id = '72e7a79a-d034-4de0-9db6-ed65be3fa99f'
    OR job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';

UPDATE photos SET before_after_pair_id = NULL
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';

UPDATE users SET current_job_id = NULL
 WHERE current_job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';

-- ========== 2) Expense / receipt children ==========
-- expense_line_items.receipt_photo_id → receipt_photos (logical); expense_id → expenses
DELETE FROM expense_line_items
 WHERE expense_id IN (SELECT id FROM expenses WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b');

-- receipt_photos.expense_id → expenses(id); also photo_id → photos
DELETE FROM receipt_photos
 WHERE expense_id IN (SELECT id FROM expenses WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b')
    OR photo_id IN (SELECT id FROM photos WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b');

-- ========== 3) payments / other invoice children → invoices → expenses ==========
-- payments.invoice_id → invoices(id)
DELETE FROM payments
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b'
    OR invoice_id IN (
      '0c5d1069-e3ba-4d5b-99f6-aa857d31899a',
      '88c3e0e7-e448-457d-ab50-c9949263e556',
      '8b6404bd-5d4a-4255-b871-7ad9800e39b4'
    );

-- client_lien_waivers.invoice_id → invoices(id) (may be empty for JOB-108)
DELETE FROM client_lien_waivers
 WHERE invoice_id IN (
   '0c5d1069-e3ba-4d5b-99f6-aa857d31899a',
   '88c3e0e7-e448-457d-ab50-c9949263e556',
   '8b6404bd-5d4a-4255-b871-7ad9800e39b4'
 )
    OR job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';

DELETE FROM invoices
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b'
   AND id IN (
     '0c5d1069-e3ba-4d5b-99f6-aa857d31899a', -- INV-003
     '88c3e0e7-e448-457d-ab50-c9949263e556', -- INV-004
     '8b6404bd-5d4a-4255-b871-7ad9800e39b4'  -- INV-005
   );

DELETE FROM expenses
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';

-- ========== 4) Punch list children → lists ==========
DELETE FROM punch_list_sub_tokens
 WHERE punch_list_id IN (SELECT id FROM punch_lists WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b');

DELETE FROM punch_list_items
 WHERE punch_list_id IN (SELECT id FROM punch_lists WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b');

DELETE FROM punch_lists
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';

-- ========== 5) Warranty ==========
DELETE FROM warranty_calls
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';

DELETE FROM warranties
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';

-- ========== 6) billing_cycles (invoices already gone; cycle→invoice FKs nulled) ==========
DELETE FROM billing_cycles
 WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';

-- ========== 7) EST-99011 selections / schedules ==========
DELETE FROM selection_choices
 WHERE selection_id IN (
   SELECT id FROM selections
    WHERE estimate_id = '72e7a79a-d034-4de0-9db6-ed65be3fa99f'
       OR job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b'
 );

DELETE FROM selections
 WHERE estimate_id = '72e7a79a-d034-4de0-9db6-ed65be3fa99f'
    OR job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';

DELETE FROM payment_schedules
 WHERE estimate_id = '72e7a79a-d034-4de0-9db6-ed65be3fa99f';

-- ========== 8) Remaining JOB-108 job-scoped rows ==========
-- signature_events.job_document_id → job_documents(id)
DELETE FROM signature_events
 WHERE job_document_id IN (SELECT id FROM job_documents WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b');

DELETE FROM job_documents WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
DELETE FROM billing_schedule WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
-- photos after receipt_photos cleared; before tasks/daily_logs (photos may ref those cols)
DELETE FROM photos WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
DELETE FROM tasks WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
DELETE FROM time_entries WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
DELETE FROM daily_logs WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
DELETE FROM schedule_entries WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
DELETE FROM change_orders WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
DELETE FROM permits WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
DELETE FROM mileage WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
DELETE FROM lien_waivers WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
DELETE FROM social_posts WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
DELETE FROM smart_notes WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
DELETE FROM quotes WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';
DELETE FROM line_items WHERE job_id = '760c1458-3d76-48b9-8258-0d48fe611a1b';

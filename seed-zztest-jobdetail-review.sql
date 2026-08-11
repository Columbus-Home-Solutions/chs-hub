-- =============================================================================
-- ZZTEST-JOBDETAIL — seed a realistic job for mobile/tablet Job Detail review
-- =============================================================================
-- Approach: hand-seeded conversion shape (client → properties → estimate request
-- → approved estimate + line items → job + deposit payment → tasks mirroring
-- line-item groups). Same lineage as real quote-to-job jobs, without calling
-- the converter (keeps fixed UUIDs for easy cleanup).
--
-- Status: punch_list — Tasks + Punch List tabs both meaningful.
--
-- Run (Tony):
--   npx wrangler d1 execute chs-hub-db --remote --file=seed-zztest-jobdetail-review.sql
--
-- If this fails on UNIQUE/PK, run cleanup first:
--   npx wrangler d1 execute chs-hub-db --remote --file=cleanup-zztest-jobdetail-review.sql
-- =============================================================================

-- Fixed IDs (all b1000001-… namespace — do not reuse elsewhere)
-- Client          b1000001-0000-4000-8000-000000000001
-- Property A/B    …0002 / …0003
-- Est. request    …0010
-- Estimate        …0020
-- Line items      …0021 / …0022 / …0023
-- Pay schedule    …0024 / …0025 / …0026
-- Job             …0030
-- Payment         …0031
-- Tasks           …0041 …0049
-- Punch list      …0050
-- Punch items     …0051 …0054
-- Daily log       …0060
-- Communications  …0070 / …0071

-- 1. Client (enough depth for Client Detail)
INSERT INTO clients (
  id, name, first_name, last_name, email, phone, phone_secondary,
  address_street, address_city, address_state, address_postal,
  mailing_address, mailing_city, mailing_state, mailing_zip,
  lead_source, is_repeat_client, notes,
  synced_at, created_at, updated_at, created_by
) VALUES (
  'b1000001-0000-4000-8000-000000000001',
  'ZZTEST-JOBDETAIL Review Client',
  'ZZTEST-JOBDETAIL', 'Review Client',
  'tony@homesolutionsar.com', '5012632050', '5015550199',
  '4501 ZZTEST-JOBDETAIL Oak Ave', 'Little Rock', 'Arkansas', '72205',
  '4501 ZZTEST-JOBDETAIL Oak Ave', 'Little Rock', 'Arkansas', '72205',
  'referral', 1,
  'ZZTEST seed client for Job Detail / Client Detail / punch / BoldSign review. Safe to delete via cleanup-zztest-jobdetail-review.sql.',
  datetime('now'), datetime('now'), datetime('now'),
  'tony@homesolutionsar.com'
);

-- 2. Two properties (primary job address + a second for Client Detail)
INSERT INTO properties (
  id, client_id, address, city, state, zip, property_type, notes, created_at
) VALUES
(
  'b1000001-0000-4000-8000-000000000002',
  'b1000001-0000-4000-8000-000000000001',
  '4501 ZZTEST-JOBDETAIL Oak Ave', 'Little Rock', 'Arkansas', '72205',
  'single_family',
  'Primary job site — kitchen remodel (ZZTEST).',
  datetime('now')
),
(
  'b1000001-0000-4000-8000-000000000003',
  'b1000001-0000-4000-8000-000000000001',
  '882 ZZTEST-JOBDETAIL Pine Ct', 'North Little Rock', 'Arkansas', '72114',
  'single_family',
  'Second property on file — not the active job (ZZTEST).',
  datetime('now')
);

-- 3. Estimate request
INSERT INTO estimate_requests (
  id, request_number, status, client_id, property_id,
  property_address, property_city, property_state, property_zip,
  job_type, lead_source, created_at, updated_at, created_by
) VALUES (
  'b1000001-0000-4000-8000-000000000010',
  99101,
  'sent',
  'b1000001-0000-4000-8000-000000000001',
  'b1000001-0000-4000-8000-000000000002',
  '4501 ZZTEST-JOBDETAIL Oak Ave', 'Little Rock', 'Arkansas', '72205',
  'kitchen_remodel', 'referral',
  datetime('now'), datetime('now'), 'tony@homesolutionsar.com'
);

-- 4. Approved estimate (conversion-ready shape)
INSERT INTO estimates (
  id, estimate_number, request_id, client_id, title, estimate_mode, billing_model,
  status, subtotal, tax_amount, total, margin_percent,
  deposit_amount, deposit_type, deposit_percentage, valid_days,
  include_reviews, include_contract, version, is_current_version,
  sent_at, signed_date, approved_date, portal_token,
  created_at, updated_at, created_by
) VALUES (
  'b1000001-0000-4000-8000-000000000020',
  99101,
  'b1000001-0000-4000-8000-000000000010',
  'b1000001-0000-4000-8000-000000000001',
  'ZZTEST-JOBDETAIL Kitchen Remodel Estimate',
  'fixed_price', 'fixed_price',
  'approved', 18500.00, 0, 18500.00, 0,
  6105.00, 'percentage', 33, 14,
  1, 1, 1, 1,
  datetime('now'), date('now'), date('now'),
  'zztestjobdetailportalest00000001',
  datetime('now'), datetime('now'),
  '00000000-0000-0000-0000-000000000001'
);

UPDATE estimate_requests
SET estimate_id = 'b1000001-0000-4000-8000-000000000020',
    updated_at = datetime('now')
WHERE id = 'b1000001-0000-4000-8000-000000000010';

-- 5. Parent line items → become task groups on conversion
INSERT INTO estimate_line_items (
  id, estimate_id, sort_order, product_service, description,
  quantity, unit, unit_price, total, created_at
) VALUES
(
  'b1000001-0000-4000-8000-000000000021',
  'b1000001-0000-4000-8000-000000000020', 1,
  'Demolition & Prep',
  'Remove cabinets, protect floors, haul debris',
  1, 'lot', 3500.00, 3500.00, datetime('now')
),
(
  'b1000001-0000-4000-8000-000000000022',
  'b1000001-0000-4000-8000-000000000020', 2,
  'Plumbing Rough-In',
  'Relocate sink supply/drain, dishwasher stub-out',
  1, 'lot', 4200.00, 4200.00, datetime('now')
),
(
  'b1000001-0000-4000-8000-000000000023',
  'b1000001-0000-4000-8000-000000000020', 3,
  'Cabinets & Finish',
  'Install cabinets, hardware, trim, and final paint touch-up',
  1, 'lot', 10800.00, 10800.00, datetime('now')
);

-- 5b. Payment schedule (33 / 33 / 34 — matches deposit_amount 6105 on $18,500)
INSERT INTO payment_schedules (
  id, estimate_id, sort_order, description, percentage, fixed_amount, amount,
  is_deposit, trigger, created_at
) VALUES
(
  'b1000001-0000-4000-8000-000000000024',
  'b1000001-0000-4000-8000-000000000020', 0,
  'Deposit (due before work begins)', 33, NULL, 6105.00,
  1, 'contract_signing', datetime('now')
),
(
  'b1000001-0000-4000-8000-000000000025',
  'b1000001-0000-4000-8000-000000000020', 1,
  'Progress Payment', 33, NULL, 6105.00,
  0, 'milestone', datetime('now')
),
(
  'b1000001-0000-4000-8000-000000000026',
  'b1000001-0000-4000-8000-000000000020', 2,
  'Final Payment (due upon completion)', 34, NULL, 6290.00,
  0, 'completion', datetime('now')
);

-- 6. Job (conversion shape, punch_list stage)
INSERT INTO jobs (
  id, job_number, title, status, client_id, source, total,
  created_at, synced_at, updated_at, created_by,
  billing_model, property_id, property_address, property_city, property_state, property_zip,
  job_type, lead_source, estimate_id, contract_total, deposit_amount, deposit_paid,
  portal_token, portal_type, conversion_complete
) SELECT
  'b1000001-0000-4000-8000-000000000030',
  COALESCE((SELECT MAX(job_number) FROM jobs), 0) + 1,
  'ZZTEST-JOBDETAIL Kitchen Remodel',
  'punch_list',
  'b1000001-0000-4000-8000-000000000001',
  'estimate', 18500.00,
  datetime('now'), datetime('now'), datetime('now'),
  '00000000-0000-0000-0000-000000000001',
  'fixed_price',
  'b1000001-0000-4000-8000-000000000002',
  '4501 ZZTEST-JOBDETAIL Oak Ave', 'Little Rock', 'Arkansas', '72205',
  'kitchen_remodel', 'referral',
  'b1000001-0000-4000-8000-000000000020',
  18500.00, 6105.00, 1,
  'zztestjobdetailportaljob00000001',
  'standard', 1;

UPDATE estimate_requests
SET status = 'won',
    converted_job_id = 'b1000001-0000-4000-8000-000000000030',
    updated_at = datetime('now')
WHERE id = 'b1000001-0000-4000-8000-000000000010';

-- 7. Deposit payment
INSERT INTO payments (
  id, job_id, estimate_id, client_id, amount, net_amount,
  payment_method, received_date, collected_at, notes, synced_at, created_at
) VALUES (
  'b1000001-0000-4000-8000-000000000031',
  'b1000001-0000-4000-8000-000000000030',
  'b1000001-0000-4000-8000-000000000020',
  'b1000001-0000-4000-8000-000000000001',
  6105.00, 6105.00,
  'check', date('now'), datetime('now'),
  'ZZTEST-JOBDETAIL deposit (test data)',
  datetime('now'), datetime('now')
);

-- 8. Tasks — 3 groups, mixed statuses (mirrors conversion + extra detail rows)
INSERT INTO tasks (
  id, job_id, task_group, task_group_order, title, status, sort_order,
  is_punch_list, completed_date, notes, created_at
) VALUES
-- Demolition & Prep
(
  'b1000001-0000-4000-8000-000000000041',
  'b1000001-0000-4000-8000-000000000030',
  'Demolition & Prep', 0, 'Start Demolition & Prep', 'complete', 0, 0,
  date('now', '-10 days'), NULL, datetime('now')
),
(
  'b1000001-0000-4000-8000-000000000042',
  'b1000001-0000-4000-8000-000000000030',
  'Demolition & Prep', 0, 'Protect floors and haul debris', 'complete', 1, 0,
  date('now', '-9 days'), NULL, datetime('now')
),
(
  'b1000001-0000-4000-8000-000000000043',
  'b1000001-0000-4000-8000-000000000030',
  'Demolition & Prep', 0, 'Final clean of demo area', 'complete', 2, 0,
  date('now', '-8 days'), NULL, datetime('now')
),
-- Plumbing Rough-In
(
  'b1000001-0000-4000-8000-000000000044',
  'b1000001-0000-4000-8000-000000000030',
  'Plumbing Rough-In', 1, 'Start Plumbing Rough-In', 'complete', 0, 0,
  date('now', '-6 days'), NULL, datetime('now')
),
(
  'b1000001-0000-4000-8000-000000000045',
  'b1000001-0000-4000-8000-000000000030',
  'Plumbing Rough-In', 1, 'Set dishwasher stub-out', 'in_progress', 1, 0,
  NULL, 'Waiting on client appliance delivery', datetime('now')
),
(
  'b1000001-0000-4000-8000-000000000046',
  'b1000001-0000-4000-8000-000000000030',
  'Plumbing Rough-In', 1, 'Pressure test supply lines', 'pending', 2, 0,
  NULL, NULL, datetime('now')
),
-- Cabinets & Finish
(
  'b1000001-0000-4000-8000-000000000047',
  'b1000001-0000-4000-8000-000000000030',
  'Cabinets & Finish', 2, 'Start Cabinets & Finish', 'complete', 0, 0,
  date('now', '-3 days'), NULL, datetime('now')
),
(
  'b1000001-0000-4000-8000-000000000048',
  'b1000001-0000-4000-8000-000000000030',
  'Cabinets & Finish', 2, 'Install uppers and bases', 'complete', 1, 0,
  date('now', '-2 days'), NULL, datetime('now')
),
(
  'b1000001-0000-4000-8000-000000000049',
  'b1000001-0000-4000-8000-000000000030',
  'Cabinets & Finish', 2, 'Hardware + paint touch-up', 'pending', 2, 0,
  NULL, NULL, datetime('now')
);

-- 9. Punch list + mixed item states (open / done; one “assigned” via description)
INSERT INTO punch_lists (
  id, job_id, name, status, created_at, updated_at
) VALUES (
  'b1000001-0000-4000-8000-000000000050',
  'b1000001-0000-4000-8000-000000000030',
  'General',
  'open',
  datetime('now'), datetime('now')
);

INSERT INTO punch_list_items (
  id, punch_list_id, job_id, description, status, sort_order,
  completed_at, completed_note, created_at, updated_at
) VALUES
(
  'b1000001-0000-4000-8000-000000000051',
  'b1000001-0000-4000-8000-000000000050',
  'b1000001-0000-4000-8000-000000000030',
  'Touch up paint on pantry door jamb',
  'open', 0, NULL, NULL, datetime('now'), datetime('now')
),
(
  'b1000001-0000-4000-8000-000000000052',
  'b1000001-0000-4000-8000-000000000050',
  'b1000001-0000-4000-8000-000000000030',
  '[ZZTEST Tile Sub] Regrout backsplash corner near window',
  'open', 1, NULL, NULL, datetime('now'), datetime('now')
),
(
  'b1000001-0000-4000-8000-000000000053',
  'b1000001-0000-4000-8000-000000000050',
  'b1000001-0000-4000-8000-000000000030',
  'Adjust soft-close on trash pull-out',
  'done', 2, datetime('now', '-1 day'), 'Adjusted hinge — good', datetime('now'), datetime('now')
),
(
  'b1000001-0000-4000-8000-000000000054',
  'b1000001-0000-4000-8000-000000000050',
  'b1000001-0000-4000-8000-000000000030',
  'Replace chipped toe-kick at island end',
  'open', 3, NULL, NULL, datetime('now'), datetime('now')
);

-- 10. Daily log
INSERT INTO daily_logs (
  id, job_id, log_date, weather, work_performed, issues, materials_used,
  crew_on_site, hours_worked, entered_via, created_at, created_by
) VALUES (
  'b1000001-0000-4000-8000-000000000060',
  'b1000001-0000-4000-8000-000000000030',
  date('now', '-1 day'),
  'Clear, mid-80s, light breeze',
  'Finished cabinet install on north wall. Started hardware. Client walked punch items with Tony — three open items remain on General punch list.',
  'Dishwasher still not on site; plumbing stub-out waiting.',
  'Cabinet screws, soft-close hinges, touch-up paint (SW Agreeable Gray)',
  'Tony + 1 helper',
  7.5,
  'web',
  datetime('now'),
  'tony@homesolutionsar.com'
);

-- 11. Communications (Client Detail timeline depth)
INSERT INTO communications (
  id, client_id, job_id, channel, direction, summary, body,
  sent_via, logged_by, created_at
) VALUES
(
  'b1000001-0000-4000-8000-000000000070',
  'b1000001-0000-4000-8000-000000000001',
  'b1000001-0000-4000-8000-000000000030',
  'phone_call', 'outbound',
  'ZZTEST — confirmed punch walk-through for Friday',
  'Called client; agreed to walk remaining punch items Friday morning.',
  'manual', 'tony@homesolutionsar.com', datetime('now', '-2 days')
),
(
  'b1000001-0000-4000-8000-000000000071',
  'b1000001-0000-4000-8000-000000000001',
  'b1000001-0000-4000-8000-000000000030',
  'email', 'inbound',
  'ZZTEST — client emailed dishwasher delivery date',
  'Client: dishwasher arrives next Tuesday — please hold final plumbing connection.',
  'manual', 'tony@homesolutionsar.com', datetime('now', '-1 days')
);

-- Verify helper (optional — comment out if you only want inserts)
SELECT
  'ZZTEST-JOBDETAIL seeded' AS ok,
  (SELECT id FROM clients WHERE id = 'b1000001-0000-4000-8000-000000000001') AS client_id,
  (SELECT id || ' · JOB-' || job_number FROM jobs WHERE id = 'b1000001-0000-4000-8000-000000000030') AS job,
  (SELECT COUNT(*) FROM tasks WHERE job_id = 'b1000001-0000-4000-8000-000000000030') AS tasks,
  (SELECT COUNT(*) FROM punch_list_items WHERE job_id = 'b1000001-0000-4000-8000-000000000030') AS punch_items,
  (SELECT COUNT(*) FROM properties WHERE client_id = 'b1000001-0000-4000-8000-000000000001') AS properties;

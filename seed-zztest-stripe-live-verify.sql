-- =============================================================================
-- ZZTEST Stripe Live Verification — $1-deposit sent estimate (not signed)
-- =============================================================================
-- Prepares the CHS-side quote so Tony can open the public link, sign, and pay
-- $1 + 3.5% convenience fee with a real card. Does NOT sign, accept, or charge.
--
-- Deposit source of truth for Stripe is payment_schedules.is_deposit
-- (src/lib/deposit-from-schedule.ts), not estimates.deposit_amount alone.
-- Flat $1 via fixed_amount on a $1 total (100% deposit).
--
-- Formal test flag: clients.is_test = 1 (migration 0118).
-- Estimate number 99901 is a high test slot — does NOT bump
-- system_settings.next_estimate_number (currently 283).
--
-- Run:
--   npx wrangler d1 execute chs-hub-db --remote --file=seed-zztest-stripe-live-verify.sql
--
-- Public quote URL:
--   https://client.homesolutionsar.com/quote/zzteststripliveverify0000000001
-- =============================================================================

-- Fixed IDs (c3000001-… namespace — do not reuse elsewhere)
-- Client          c3000001-0000-4000-8000-000000000001
-- Property        …0002
-- Est. request    …0010
-- Estimate        …0020
-- Line item       …0021
-- Pay schedule    …0024

-- 1. Client (is_test = 1 so dashboards/KPIs/pipelines exclude it)
INSERT INTO clients (
  id, name, first_name, last_name, email, phone,
  address_street, address_city, address_state, address_postal,
  mailing_address, mailing_city, mailing_state, mailing_zip,
  lead_source, is_repeat_client, notes,
  is_test, sms_opt_out,
  synced_at, created_at, updated_at, created_by
) VALUES (
  'c3000001-0000-4000-8000-000000000001',
  'ZZTEST Stripe Live Verification',
  'ZZTEST', 'Stripe Live Verification',
  'tony@homesolutionsar.com', '5012632050',
  '1 ZZTEST Stripe Live Lane', 'Little Rock', 'Arkansas', '72201',
  '1 ZZTEST Stripe Live Lane', 'Little Rock', 'Arkansas', '72201',
  'direct_call', 0,
  'ZZTEST — live Stripe webhook verification ($1 deposit). Do not fulfill. Flagged is_test. Safe to delete after Tony confirms payment recorded + refunds the $1.',
  1, 1,
  datetime('now'), datetime('now'), datetime('now'),
  'tony@homesolutionsar.com'
);

-- 2. Property
INSERT INTO properties (
  id, client_id, address, city, state, zip, property_type, notes, created_at
) VALUES (
  'c3000001-0000-4000-8000-000000000002',
  'c3000001-0000-4000-8000-000000000001',
  '1 ZZTEST Stripe Live Lane', 'Little Rock', 'Arkansas', '72201',
  'residential',
  'ZZTEST Stripe live verification — not a real job site.',
  datetime('now')
);

-- 3. Estimate request (sent, not won). follow_up_count=4 so 15-min quote
-- follow-up cron will not SMS/email this fixture (first real touch is Day 3).
INSERT INTO estimate_requests (
  id, request_number, status, client_id, property_id,
  property_address, property_city, property_state, property_zip,
  job_type, lead_source, source,
  sent_date, follow_up_count, follow_up_sequence_active,
  lead_outreach_sequence_active, lead_outreach_count,
  created_at, updated_at, created_by
) VALUES (
  'c3000001-0000-4000-8000-000000000010',
  99901,
  'sent',
  'c3000001-0000-4000-8000-000000000001',
  'c3000001-0000-4000-8000-000000000002',
  '1 ZZTEST Stripe Live Lane', 'Little Rock', 'Arkansas', '72201',
  'other', 'direct_call', 'manual',
  datetime('now'), 4, 0,
  0, 0,
  datetime('now'), datetime('now'), 'tony@homesolutionsar.com'
);

-- 4. Sent estimate — unsigned, unapproved, payable via public quote token.
-- include_contract=1 with no BoldSign document → typed in-page signature,
-- which is the gate handlePublicQuotePayIntent checks before creating a PI.
INSERT INTO estimates (
  id, estimate_number, request_id, client_id, title, estimate_mode, billing_model,
  status, subtotal, tax_amount, total, margin_percent,
  deposit_amount, deposit_type, deposit_percentage, valid_days, expiration_date,
  include_reviews, include_contract, contract_text, version, is_current_version,
  sent_at, portal_token,
  created_at, updated_at, created_by
) VALUES (
  'c3000001-0000-4000-8000-000000000020',
  99901,
  'c3000001-0000-4000-8000-000000000010',
  'c3000001-0000-4000-8000-000000000001',
  'ZZTEST Stripe Live Verification — DO NOT FULFILL',
  'lump_sum', 'fixed_price',
  'sent', 1.00, 0, 1.00, 0,
  1.00, 'fixed', NULL, 14, date('now', '+14 days'),
  0, 1,
  'ZZTEST Stripe Live Verification. This is not a real service agreement and is not a real job. Sign only to exercise the deposit-on-signed-estimate payment path. Do not fulfill.',
  1, 1,
  datetime('now'),
  'zzteststripliveverify0000000001',
  datetime('now'), datetime('now'),
  '00000000-0000-0000-0000-000000000001'
);

UPDATE estimate_requests
SET estimate_id = 'c3000001-0000-4000-8000-000000000020',
    updated_at = datetime('now')
WHERE id = 'c3000001-0000-4000-8000-000000000010';

-- 5. Line item
INSERT INTO estimate_line_items (
  id, estimate_id, sort_order, product_service, description,
  quantity, unit, unit_price, total, created_at
) VALUES (
  'c3000001-0000-4000-8000-000000000021',
  'c3000001-0000-4000-8000-000000000020', 1,
  'Live Stripe Verification Test',
  'Live Stripe Verification Test — DO NOT FULFILL.',
  1, 'lot', 1.00, 1.00, datetime('now')
);

-- 6. Payment schedule — $1 deposit (fixed). Public pay/intent reads this row.
INSERT INTO payment_schedules (
  id, estimate_id, sort_order, description, percentage, fixed_amount, amount,
  is_deposit, trigger, created_at
) VALUES (
  'c3000001-0000-4000-8000-000000000024',
  'c3000001-0000-4000-8000-000000000020', 0,
  'Deposit (ZZTEST $1 live Stripe verification)', 100, 1.00, 1.00,
  1, 'contract_signing', datetime('now')
);

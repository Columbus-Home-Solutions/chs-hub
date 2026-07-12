-- ZZTEST-PRELAUNCH pre-launch functional test data set
-- Inserts in dependency order. All contact info is Tony's own.

-- 1. Client
INSERT INTO clients (
  id, first_name, last_name, email, phone,
  address_street, address_city, address_state, address_postal,
  synced_at, created_at, updated_at
) VALUES (
  '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c',
  'ZZTEST-PRELAUNCH', 'Test Client',
  'tony@homesolutionsar.com', '5012632050',
  '123 ZZTEST-PRELAUNCH Test Lane', 'Little Rock', 'Arkansas', '72201',
  datetime('now'), datetime('now'), datetime('now')
);

-- 2. Property
INSERT INTO properties (
  id, client_id, address, city, state, zip, property_type, created_at
) VALUES (
  '6b3a0e1d-7c2f-4d80-b4a5-1c7e9d2f3a4b',
  '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c',
  '123 ZZTEST-PRELAUNCH Test Lane', 'Little Rock', 'Arkansas', '72201',
  'single_family', datetime('now')
);

-- 3. Estimate request (linked after estimate + job exist)
INSERT INTO estimate_requests (
  id, request_number, status, client_id, property_id,
  property_address, property_city, property_state, property_zip,
  job_type, lead_source, created_at, updated_at, created_by
) VALUES (
  '5a290d0c-6b1e-4c70-a394-0b6d8c1e2f3a',
  99001,
  'sent',
  '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c',
  '6b3a0e1d-7c2f-4d80-b4a5-1c7e9d2f3a4b',
  '123 ZZTEST-PRELAUNCH Test Lane', 'Little Rock', 'Arkansas', '72201',
  'bathroom_remodel', 'referral',
  datetime('now'), datetime('now'), 'tony@homesolutionsar.com'
);

-- 4. Estimate (approved, sent, current version — Go-to-Job shape)
INSERT INTO estimates (
  id, estimate_number, request_id, client_id, title, estimate_mode, billing_model,
  status, subtotal, tax_amount, total, margin_percent,
  deposit_amount, deposit_type, deposit_percentage, valid_days,
  include_reviews, include_contract, version, is_current_version,
  sent_at, signed_date, approved_date, portal_token,
  created_at, updated_at, created_by
) VALUES (
  '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f',
  99001,
  '5a290d0c-6b1e-4c70-a394-0b6d8c1e2f3a',
  '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c',
  'ZZTEST-PRELAUNCH Bathroom Remodel Estimate',
  'fixed_price', 'fixed_price',
  'approved', 8000.00, 0, 8000.00, 0,
  2640.00, 'percentage', 33, 7,
  1, 1, 1, 1,
  datetime('now'), date('now'), date('now'),
  'prelaunch6b3a0e1d7c2f4d80b4a51c7e',
  datetime('now'), datetime('now'),
  '00000000-0000-0000-0000-000000000001'
);

UPDATE estimate_requests
SET estimate_id = '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f',
    updated_at = datetime('now')
WHERE id = '5a290d0c-6b1e-4c70-a394-0b6d8c1e2f3a';

-- 5. Estimate line items
INSERT INTO estimate_line_items (
  id, estimate_id, sort_order, product_service, description,
  quantity, unit, unit_price, total, created_at
) VALUES
(
  '3e070b8a-490c-4a50-8172-8a4b6c9d0e1f',
  '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f', 1,
  'Demolition & Prep', 'Remove existing fixtures and prepare surfaces for remodel',
  1, 'lot', 3000.00, 3000.00, datetime('now')
),
(
  '2d060a79-380b-493f-7061-7a3a5b8c9d0e',
  '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f', 2,
  'Finish Carpentry', 'Install trim, vanity, and final finish work',
  1, 'lot', 5000.00, 5000.00, datetime('now')
);

-- 6. Job (estimate conversion shape — NOT quick_job)
INSERT INTO jobs (
  id, job_number, title, status, client_id, source, total,
  created_at, synced_at, updated_at, created_by,
  billing_model, property_id, property_address, property_city, property_state, property_zip,
  job_type, lead_source, estimate_id, contract_total, deposit_amount, deposit_paid,
  portal_token, portal_type, conversion_complete
) SELECT
  '1c040987-270a-482e-5f50-6a293a7b8c9d',
  COALESCE((SELECT MAX(job_number) FROM jobs), 0) + 1,
  'ZZTEST-PRELAUNCH Bathroom Remodel',
  'in_progress',
  '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c',
  'estimate', 8000.00,
  datetime('now'), datetime('now'), datetime('now'),
  '00000000-0000-0000-0000-000000000001',
  'fixed_price',
  '6b3a0e1d-7c2f-4d80-b4a5-1c7e9d2f3a4b',
  '123 ZZTEST-PRELAUNCH Test Lane', 'Little Rock', 'Arkansas', '72201',
  'bathroom_remodel', 'referral',
  '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f',
  8000.00, 2640.00, 1,
  'prelaunch7c4a1f2e8b3d4e91a5c62d8f9e',
  'standard', 1;

UPDATE estimate_requests
SET status = 'won',
    converted_job_id = '1c040987-270a-482e-5f50-6a293a7b8c9d',
    updated_at = datetime('now')
WHERE id = '5a290d0c-6b1e-4c70-a394-0b6d8c1e2f3a';

-- 7. Deposit payment (conversion record)
INSERT INTO payments (
  id, job_id, estimate_id, client_id, amount, net_amount,
  payment_method, received_date, collected_at, notes, synced_at, created_at
) VALUES (
  '0b030876-1609-471d-4e4f-5a1829678b8c',
  '1c040987-270a-482e-5f50-6a293a7b8c9d',
  '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f',
  '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c',
  2640.00, 2640.00,
  'check', date('now'), datetime('now'),
  'ZZTEST-PRELAUNCH deposit (test data)',
  datetime('now'), datetime('now')
);

-- 8. Subcontractors
INSERT INTO subcontractors (
  id, company_name, contact_name, email, phone, trade,
  is_active, active_status, coi_expiration_date,
  created_at, updated_at
) VALUES (
  '9a020765-0508-460c-3d3e-4a0718567a7b',
  'ZZTEST-PRELAUNCH Sub A', 'Tony Test',
  'tony@homesolutionsar.com', '5012632050', 'electrical',
  1, 'Active', '2026-07-22',
  datetime('now'), datetime('now')
);

INSERT INTO subcontractors (
  id, company_name, contact_name, email, phone, trade,
  is_active, active_status,
  created_at, updated_at
) VALUES (
  '89010754-9407-45fb-2c2d-390607457a6a',
  'ZZTEST-PRELAUNCH Sub B', 'Tony Test',
  'tony@homesolutionsar.com', '5012632050', 'plumbing',
  1, 'Active',
  datetime('now'), datetime('now')
);

-- 9. Bid request + recipients (sealed)
INSERT INTO bid_requests (
  id, estimate_id, job_id, title, scope_description,
  quantities_notes, status, bid_mode, notify_losers, created_at
) VALUES (
  '7800f643-8306-44ea-1b1c-2805f6346969',
  '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f',
  '1c040987-270a-482e-5f50-6a293a7b8c9d',
  'ZZTEST-PRELAUNCH Electrical Rough-In Bid',
  'Rough-in electrical for bathroom remodel: new GFCI circuit, vanity lighting, exhaust fan connection.',
  '1 bathroom, standard residential scope',
  'open', 'sealed', 1, datetime('now')
);

INSERT INTO bid_request_recipients (
  id, bid_request_id, sub_id, portal_token, sent_at, created_at
) VALUES
(
  '6700e532-7205-43d9-0a0b-1704e5235858',
  '7800f643-8306-44ea-1b1c-2805f6346969',
  '9a020765-0508-460c-3d3e-4a0718567a7b',
  'a1b2c3d4e5f6478990ab12cd34ef5678',
  datetime('now'), datetime('now')
),
(
  '5600d421-6104-42c8-f90a-0603d4124747',
  '7800f643-8306-44ea-1b1c-2805f6346969',
  '89010754-9407-45fb-2c2d-390607457a6a',
  'b2c3d4e5f6a7489901ab2cd34ef5678',
  datetime('now'), datetime('now')
);

-- 10. Daily log (AI weekly recap source material)
INSERT INTO daily_logs (
  id, job_id, log_date, weather, work_performed, materials_used,
  crew_on_site, hours_worked, entered_via, created_at, created_by
) VALUES (
  '4500c310-5003-41b7-e809-9502c3013636',
  '1c040987-270a-482e-5f50-6a293a7b8c9d',
  date('now'),
  'Partly cloudy, 82°F',
  'Removed the old vanity and toilet, prepped subfloor for new tile, and framed the shower niche. Electrical rough-in inspection is scheduled for Thursday.',
  'Schluter membrane, thinset, 2x4 lumber',
  'Mike (lead), Jake (helper)',
  7.5,
  'web',
  datetime('now'),
  'tony@homesolutionsar.com'
);

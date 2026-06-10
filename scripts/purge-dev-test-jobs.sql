-- Purge CHS-created dev/E2E test jobs (#100–#105) and their test clients.
-- Does NOT delete R2 blobs. Run:
--   npx wrangler d1 execute chs-hub-db --remote --file scripts/purge-dev-test-jobs.sql

DELETE FROM signature_events
 WHERE job_document_id IN (
   SELECT id FROM job_documents WHERE job_id IN (
     '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
     'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
     '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
   )
 );

DELETE FROM job_documents WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

-- permits + lien_waivers hold document_id FK → must go before documents
DELETE FROM permits WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM lien_waivers WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM documents WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM photos WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM billing_cycles WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM payments WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM payments WHERE invoice_id IN (
  SELECT id FROM invoices WHERE job_id IN (
    '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
    'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
    '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
  )
);

DELETE FROM invoices WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM expenses WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM line_items WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM quotes WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM time_entries WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM daily_logs WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM change_orders WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM schedule_entries WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM tasks WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM mileage WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

UPDATE notification_logs SET communication_id = NULL
 WHERE communication_id IN (
   SELECT id FROM communications WHERE job_id IN (
     '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
     'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
     '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
   )
 );

DELETE FROM communications WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM smart_notes WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM billing_schedule WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM job_files WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM warranty_calls WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

UPDATE estimate_requests SET converted_job_id = NULL WHERE converted_job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

UPDATE notification_logs SET job_id = NULL WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

UPDATE users SET current_job_id = NULL WHERE current_job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM social_posts WHERE job_id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM drive_mirror_folders WHERE path_key IN (
  'stub_1f986c08-f7be-4c82-b774-7dfd21001aa1','job_1f986c08-f7be-4c82-b774-7dfd21001aa1',
  'stub_cd72e0f0-7eb2-44d3-bf31-94490602c317','job_cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'stub_e476bd1a-2d51-40e0-9c88-dc522fc7ba51','job_e476bd1a-2d51-40e0-9c88-dc522fc7ba51',
  'stub_d23e8a57-7507-4513-b92b-b99a6fa04ef1','job_d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  'stub_1c015d87-4f3a-4c52-a998-fed066624399','job_1c015d87-4f3a-4c52-a998-fed066624399',
  'stub_34fb13ba-d832-4039-8ebe-558a7113759b','job_34fb13ba-d832-4039-8ebe-558a7113759b'
);

DELETE FROM jobs WHERE id IN (
  '1f986c08-f7be-4c82-b774-7dfd21001aa1','cd72e0f0-7eb2-44d3-bf31-94490602c317',
  'e476bd1a-2d51-40e0-9c88-dc522fc7ba51','d23e8a57-7507-4513-b92b-b99a6fa04ef1',
  '1c015d87-4f3a-4c52-a998-fed066624399','34fb13ba-d832-4039-8ebe-558a7113759b'
);

UPDATE notification_logs SET estimate_request_id = NULL
 WHERE estimate_request_id IN (
   SELECT id FROM estimate_requests WHERE client_id IN (
     '5c537c72-58e6-40c0-ac0a-e2fac11ba329',
     'f84611c6-4da2-4607-9045-02c15c2edad2',
     'f71f02b1-2dd8-4bd0-999a-ba9d45bb742a'
   )
 );

UPDATE photos SET estimate_request_id = NULL
 WHERE estimate_request_id IN (
   SELECT id FROM estimate_requests WHERE client_id IN (
     '5c537c72-58e6-40c0-ac0a-e2fac11ba329',
     'f84611c6-4da2-4607-9045-02c15c2edad2',
     'f71f02b1-2dd8-4bd0-999a-ba9d45bb742a'
   )
 );

DELETE FROM estimate_requests WHERE client_id IN (
  '5c537c72-58e6-40c0-ac0a-e2fac11ba329',
  'f84611c6-4da2-4607-9045-02c15c2edad2',
  'f71f02b1-2dd8-4bd0-999a-ba9d45bb742a'
);

DELETE FROM estimates WHERE client_id IN (
  '5c537c72-58e6-40c0-ac0a-e2fac11ba329',
  'f84611c6-4da2-4607-9045-02c15c2edad2',
  'f71f02b1-2dd8-4bd0-999a-ba9d45bb742a'
);

UPDATE notification_logs SET communication_id = NULL
 WHERE communication_id IN (
   SELECT id FROM communications WHERE client_id IN (
     '5c537c72-58e6-40c0-ac0a-e2fac11ba329',
     'f84611c6-4da2-4607-9045-02c15c2edad2',
     'f71f02b1-2dd8-4bd0-999a-ba9d45bb742a'
   )
 );

DELETE FROM communications WHERE client_id IN (
  '5c537c72-58e6-40c0-ac0a-e2fac11ba329',
  'f84611c6-4da2-4607-9045-02c15c2edad2',
  'f71f02b1-2dd8-4bd0-999a-ba9d45bb742a'
);

DELETE FROM properties WHERE client_id IN (
  '5c537c72-58e6-40c0-ac0a-e2fac11ba329',
  'f84611c6-4da2-4607-9045-02c15c2edad2',
  'f71f02b1-2dd8-4bd0-999a-ba9d45bb742a'
);

DELETE FROM documents WHERE client_id IN (
  '5c537c72-58e6-40c0-ac0a-e2fac11ba329',
  'f84611c6-4da2-4607-9045-02c15c2edad2',
  'f71f02b1-2dd8-4bd0-999a-ba9d45bb742a'
);

UPDATE notification_logs SET client_id = NULL WHERE client_id IN (
  '5c537c72-58e6-40c0-ac0a-e2fac11ba329',
  'f84611c6-4da2-4607-9045-02c15c2edad2',
  'f71f02b1-2dd8-4bd0-999a-ba9d45bb742a'
);

DELETE FROM clients WHERE id IN (
  '5c537c72-58e6-40c0-ac0a-e2fac11ba329',
  'f84611c6-4da2-4607-9045-02c15c2edad2',
  'f71f02b1-2dd8-4bd0-999a-ba9d45bb742a'
);

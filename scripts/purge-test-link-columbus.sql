-- One-off prod cleanup: test client Link Columbus + job b77df7d1...
-- Run: npx wrangler d1 execute chs-hub-db --remote --file=scripts/purge-test-link-columbus.sql

-- Job children (b77df7d1-46c2-4867-a3ec-3b867ff32e5c)
DELETE FROM notification_logs WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM time_entries WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM expenses WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM payments WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM invoices WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM change_orders WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM schedule_entries WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM tasks WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM daily_logs WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM job_files WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM photos WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM notes WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM lien_waivers WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM warranties WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM job_documents WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM billing_cycles WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM billing_schedule WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM permits WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM warranty_calls WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM smart_notes WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM mileage WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM documents WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM social_posts WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM notification_logs WHERE communication_id IN (
  SELECT id FROM communications WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c'
);
DELETE FROM communications WHERE job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
UPDATE estimate_requests SET converted_job_id = NULL WHERE converted_job_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
UPDATE jobs SET created_by = NULL WHERE id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM audit_logs WHERE entity_id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';
DELETE FROM jobs WHERE id = 'b77df7d1-46c2-4867-a3ec-3b867ff32e5c';

-- Estimate (81f32bdd-4e9c-4648-9389-c0c6b9391e97)
DELETE FROM estimate_sub_items WHERE parent_line_item_id IN (
  SELECT id FROM estimate_line_items WHERE estimate_id = '81f32bdd-4e9c-4648-9389-c0c6b9391e97'
);
DELETE FROM estimate_line_items WHERE estimate_id = '81f32bdd-4e9c-4648-9389-c0c6b9391e97';
DELETE FROM payment_schedules WHERE estimate_id = '81f32bdd-4e9c-4648-9389-c0c6b9391e97';
DELETE FROM audit_logs WHERE entity_id = '81f32bdd-4e9c-4648-9389-c0c6b9391e97';
UPDATE estimate_requests SET estimate_id = NULL WHERE estimate_id = '81f32bdd-4e9c-4648-9389-c0c6b9391e97';
DELETE FROM estimates WHERE id = '81f32bdd-4e9c-4648-9389-c0c6b9391e97';

-- Estimate request + client (b0268def-503a-4517-bcf6-998b62216871)
DELETE FROM notification_logs WHERE estimate_request_id = 'd23968a8-c677-43f5-b3a5-a1eee1e2bd4e';
DELETE FROM notification_logs WHERE communication_id IN (
  SELECT id FROM communications WHERE client_id = 'b0268def-503a-4517-bcf6-998b62216871'
);
DELETE FROM notification_logs WHERE client_id = 'b0268def-503a-4517-bcf6-998b62216871';
DELETE FROM communications WHERE client_id = 'b0268def-503a-4517-bcf6-998b62216871';
DELETE FROM estimate_requests WHERE client_id = 'b0268def-503a-4517-bcf6-998b62216871';
DELETE FROM properties WHERE client_id = 'b0268def-503a-4517-bcf6-998b62216871';
DELETE FROM audit_logs WHERE entity_id = 'b0268def-503a-4517-bcf6-998b62216871';
DELETE FROM clients WHERE id = 'b0268def-503a-4517-bcf6-998b62216871';

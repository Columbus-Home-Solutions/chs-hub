-- Preview-reviewed status correction. Dates stay null.
-- Do not run from an agent. Tony runs:
--   npx wrangler d1 execute chs-hub-db --remote --file=scripts/jobber-import/correct-imported-status.sql
-- Untouched: #105, #106, #107, #109, #110, #111 (their statements match zero rows once applied).
-- #78, #96, #99 match id + data_source, not source. Rollback is in correct-imported-status.ts.

INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       SELECT lower(hex(randomblob(16))), 'correction-script', 'job_status_changed', 'job', id,
              '{"from":"unscheduled","to":"complete","via":"imported_status_correction","actual_end_date":"left_null","start_date":"left_null"}', datetime('now')
         FROM jobs
        WHERE id = '0f80002e-29e6-4eb4-8021-ab67ee81f086' AND source = 'jobber_import' AND status = 'unscheduled';
UPDATE jobs
          SET status = 'complete', updated_at = datetime('now')
        WHERE id = '0f80002e-29e6-4eb4-8021-ab67ee81f086' AND source = 'jobber_import' AND status = 'unscheduled';
INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       SELECT lower(hex(randomblob(16))), 'correction-script', 'job_status_changed', 'job', id,
              '{"from":"unscheduled","to":"complete","via":"imported_status_correction","actual_end_date":"left_null","start_date":"left_null"}', datetime('now')
         FROM jobs
        WHERE id = '99190438-f0a8-4d36-ae78-f8b19a805931' AND source = 'jobber_import' AND status = 'unscheduled';
UPDATE jobs
          SET status = 'complete', updated_at = datetime('now')
        WHERE id = '99190438-f0a8-4d36-ae78-f8b19a805931' AND source = 'jobber_import' AND status = 'unscheduled';
INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       SELECT lower(hex(randomblob(16))), 'correction-script', 'job_status_changed', 'job', id,
              '{"from":"action_required","to":"scheduled","via":"imported_status_correction","actual_end_date":"left_null","start_date":"left_null"}', datetime('now')
         FROM jobs
        WHERE id = '17522999-ad05-427d-9f5a-6428ed4b506e' AND source = 'jobber_import' AND status = 'action_required';
UPDATE jobs
          SET status = 'scheduled', updated_at = datetime('now')
        WHERE id = '17522999-ad05-427d-9f5a-6428ed4b506e' AND source = 'jobber_import' AND status = 'action_required';
INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       SELECT lower(hex(randomblob(16))), 'correction-script', 'job_status_changed', 'job', id,
              '{"from":"' || status || '","to":"complete","via":"imported_status_correction","actual_end_date":"left_null"}',
              datetime('now')
         FROM jobs
        WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xMzM0Njk0Mjg=' AND data_source = 'jobber_import' AND status IN ('unscheduled', 'action_required');
UPDATE jobs
          SET status = 'complete', updated_at = datetime('now')
        WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xMzM0Njk0Mjg=' AND data_source = 'jobber_import' AND status IN ('unscheduled', 'action_required');
INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       SELECT lower(hex(randomblob(16))), 'correction-script', 'job_status_changed', 'job', id,
              '{"from":"' || status || '","to":"complete","via":"imported_status_correction","actual_end_date":"left_null"}',
              datetime('now')
         FROM jobs
        WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xNDM1ODQwMTg=' AND data_source = 'jobber_import' AND status IN ('unscheduled', 'action_required');
UPDATE jobs
          SET status = 'complete', updated_at = datetime('now')
        WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xNDM1ODQwMTg=' AND data_source = 'jobber_import' AND status IN ('unscheduled', 'action_required');
INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       SELECT lower(hex(randomblob(16))), 'correction-script', 'job_status_changed', 'job', id,
              '{"from":"' || status || '","to":"complete","via":"imported_status_correction","actual_end_date":"left_null"}',
              datetime('now')
         FROM jobs
        WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xNDM4ODAxNjI=' AND data_source = 'jobber_import' AND status IN ('unscheduled', 'action_required');
UPDATE jobs
          SET status = 'complete', updated_at = datetime('now')
        WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xNDM4ODAxNjI=' AND data_source = 'jobber_import' AND status IN ('unscheduled', 'action_required');

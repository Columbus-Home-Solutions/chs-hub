-- Hidden Jobber imports. Dates stay null. One block per job.
-- Delete any block Tony does not want before running this file.
-- Does not touch #78, #96, #99, #105, #106, #107, #109, #110, or #111.
-- Do not run from an agent. Tony runs:
--   npx wrangler d1 execute chs-hub-db --remote --file=scripts/jobber-import/correct-imported-status-hidden.sql
--
-- Preview (read-only; not part of the execute):
-- SELECT job_number, id, title, status, source, data_source, actual_end_date, start_date
--   FROM jobs
--  WHERE id IN (
--    'Z2lkOi8vSm9iYmVyL0pvYi8xMzMzMzg5NTc=',
--    'Z2lkOi8vSm9iYmVyL0pvYi8xNDExNDI0MzU=',
--    'Z2lkOi8vSm9iYmVyL0pvYi8xNDExNDM2NDE=',
--    'Z2lkOi8vSm9iYmVyL0pvYi8xNDE0ODA0OTQ=',
--    'Z2lkOi8vSm9iYmVyL0pvYi8xNDM1ODQ0Njc='
--  )
--  ORDER BY job_number;
--
-- Rollback (leave the audit rows):
-- UPDATE jobs SET status = 'requires_invoicing', updated_at = datetime('now')
--  WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xMzMzMzg5NTc='
--    AND status = 'complete' AND actual_end_date IS NULL AND data_source = 'jobber_import';
-- UPDATE jobs SET status = 'late', updated_at = datetime('now')
--  WHERE id IN (
--    'Z2lkOi8vSm9iYmVyL0pvYi8xNDExNDI0MzU=',
--    'Z2lkOi8vSm9iYmVyL0pvYi8xNDExNDM2NDE=',
--    'Z2lkOi8vSm9iYmVyL0pvYi8xNDE0ODA0OTQ=',
--    'Z2lkOi8vSm9iYmVyL0pvYi8xNDM1ODQ0Njc='
--  ) AND status = 'complete' AND actual_end_date IS NULL AND data_source = 'jobber_import';

-- #75 Ian Hawk — Property Management and Maintenance (requires_invoicing)
INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       SELECT lower(hex(randomblob(16))), 'correction-script', 'job_status_changed', 'job', id,
              '{"from":"' || status || '","to":"complete","via":"imported_status_correction","actual_end_date":"left_null"}',
              datetime('now')
         FROM jobs
        WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xMzMzMzg5NTc=' AND data_source = 'jobber_import' AND status IN ('late', 'requires_invoicing');
UPDATE jobs
          SET status = 'complete', updated_at = datetime('now')
        WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xMzMzMzg5NTc=' AND data_source = 'jobber_import' AND status IN ('late', 'requires_invoicing');

-- #91 Guardian Construction — Georgetown Apartments (late)
INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       SELECT lower(hex(randomblob(16))), 'correction-script', 'job_status_changed', 'job', id,
              '{"from":"' || status || '","to":"complete","via":"imported_status_correction","actual_end_date":"left_null"}',
              datetime('now')
         FROM jobs
        WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xNDExNDI0MzU=' AND data_source = 'jobber_import' AND status IN ('late', 'requires_invoicing');
UPDATE jobs
          SET status = 'complete', updated_at = datetime('now')
        WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xNDExNDI0MzU=' AND data_source = 'jobber_import' AND status IN ('late', 'requires_invoicing');

-- #92 Guardian Construction — Masonry (late)
INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       SELECT lower(hex(randomblob(16))), 'correction-script', 'job_status_changed', 'job', id,
              '{"from":"' || status || '","to":"complete","via":"imported_status_correction","actual_end_date":"left_null"}',
              datetime('now')
         FROM jobs
        WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xNDExNDM2NDE=' AND data_source = 'jobber_import' AND status IN ('late', 'requires_invoicing');
UPDATE jobs
          SET status = 'complete', updated_at = datetime('now')
        WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xNDExNDM2NDE=' AND data_source = 'jobber_import' AND status IN ('late', 'requires_invoicing');

-- #93 Triple Diamond Gutters — Johnson Siding (late)
INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       SELECT lower(hex(randomblob(16))), 'correction-script', 'job_status_changed', 'job', id,
              '{"from":"' || status || '","to":"complete","via":"imported_status_correction","actual_end_date":"left_null"}',
              datetime('now')
         FROM jobs
        WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xNDE0ODA0OTQ=' AND data_source = 'jobber_import' AND status IN ('late', 'requires_invoicing');
UPDATE jobs
          SET status = 'complete', updated_at = datetime('now')
        WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xNDE0ODA0OTQ=' AND data_source = 'jobber_import' AND status IN ('late', 'requires_invoicing');

-- #97 John Davis — Gate Repair (late)
INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
       SELECT lower(hex(randomblob(16))), 'correction-script', 'job_status_changed', 'job', id,
              '{"from":"' || status || '","to":"complete","via":"imported_status_correction","actual_end_date":"left_null"}',
              datetime('now')
         FROM jobs
        WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xNDM1ODQ0Njc=' AND data_source = 'jobber_import' AND status IN ('late', 'requires_invoicing');
UPDATE jobs
          SET status = 'complete', updated_at = datetime('now')
        WHERE id = 'Z2lkOi8vSm9iYmVyL0pvYi8xNDM1ODQ0Njc=' AND data_source = 'jobber_import' AND status IN ('late', 'requires_invoicing');

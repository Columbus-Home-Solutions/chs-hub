-- 0122_jobber_accepted_import.sql
-- Transition-period tool: recreate a Jobber-accepted estimate as a real CHS
-- estimate without faking a BoldSign envelope.
--
-- estimates.data_source already exists (historical Jobber CSV rows use
-- 'jobber_import'; native CHS rows are NULL). This migration does NOT add a
-- second discriminator — the new live-recreation value is
-- 'jobber_accepted_import', written by the owner-only mark-imported action.
--
-- Paper-trail columns so the import is readable months later:
ALTER TABLE estimates ADD COLUMN imported_signed_at TEXT;
ALTER TABLE estimates ADD COLUMN imported_signed_note TEXT;

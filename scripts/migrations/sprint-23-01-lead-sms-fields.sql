-- Sprint 23: Add SMS lead tracking fields to estimate_requests
-- Run locally: wrangler d1 execute chs-hub-db --local --file=scripts/migrations/sprint-23-01-lead-sms-fields.sql
-- Run remote:  wrangler d1 execute chs-hub-db --file=scripts/migrations/sprint-23-01-lead-sms-fields.sql
-- Always backup remote first:
--   wrangler d1 export chs-hub-db --output=backups/pre-sprint-23-$(date +%Y%m%d).sql
--
-- D1 rules: no BEGIN TRANSACTION, COMMIT, or PRAGMA statements.

ALTER TABLE estimate_requests ADD COLUMN last_sms_at TEXT;
ALTER TABLE estimate_requests ADD COLUMN last_sms_preview TEXT;
ALTER TABLE estimate_requests ADD COLUMN source TEXT DEFAULT 'manual'
  CHECK(source IN ('manual', 'inbound_sms', 'high_level', 'website_form'));

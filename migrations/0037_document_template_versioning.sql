-- 0037_document_template_versioning.sql  (additive only) — Sprint 15
-- Document-template version lineage (copy-on-write versioning).
--
-- Step-0 PRAGMA confirmed document_templates has name/template_type/content/
-- merge_fields/is_active/version but NO column linking the rows that are
-- versions OF THE SAME template. Versioning is implemented copy-on-write
-- (edit → new row, version+1, previous_version_id → the superseded row), so a
-- lineage key is required to walk a template's history. This is the ONLY
-- additive migration this sprint (documents / lien_waivers were already
-- complete — zero new columns there).
--
-- DO NOT run `wrangler d1 migrations apply` (ledger only records 0001–0013;
-- 0014+ are applied-but-unrecorded). Direct-execute this file:
--   npx wrangler d1 execute chs-hub-db --local --file=migrations/0037_document_template_versioning.sql
--   (remote: add --remote, backup-first, per the remote-deploy runbook)

ALTER TABLE document_templates ADD COLUMN previous_version_id TEXT;  -- points at the row this supersedes (NULL = original/v1)

-- Walk-back lineage lookups + "head of each lineage" scans stay cheap.
CREATE INDEX IF NOT EXISTS idx_doc_templates_lineage
  ON document_templates(previous_version_id) WHERE previous_version_id IS NOT NULL;

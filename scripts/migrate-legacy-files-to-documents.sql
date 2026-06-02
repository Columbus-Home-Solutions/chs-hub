-- Sprint 15 — one-time DATA migration: legacy `files` + `company_documents`
-- → the unified `documents` table (Schema Bridge §"Migrating file records").
--
-- This is NOT a schema migration. Run it directly (local first, then remote
-- backup-first per the remote-deploy runbook):
--   npx wrangler d1 execute chs-hub-db --local  --file=scripts/migrate-legacy-files-to-documents.sql
--   npx wrangler d1 execute chs-hub-db --remote --file=scripts/migrate-legacy-files-to-documents.sql
--
-- Legacy tables are KEPT as archive (Schema Bridge). The original row id is
-- preserved as documents.id, and every INSERT is guarded with NOT EXISTS, so
-- re-running is idempotent (no duplicates). Column names below were captured
-- from the LIVE schema in Step 0:
--   files:             id,r2_key,filename,mime_type,size_bytes,uploaded_by,uploaded_at,
--                      job_id,lead_id,estimate_id,category,deleted_at,archived
--   company_documents: id,title,doc_type,r2_key,filename,mime_type,size_bytes,
--                      uploaded_by,created_at,updated_at,drive_mirrored_at
--
-- mirror_status is set NULL for migrated archive rows so the hourly Drive mirror
-- does NOT re-upload files that already had a mirror lifecycle in their legacy
-- table. New documents (uploads/generation) set mirror_status='pending' in code.

-- ── files → documents (job / estimate / company by FK presence) ──────────────
INSERT INTO documents
  (id, title, file_type, file_size, r2_key, r2_url, mirror_status,
   context_type, job_id, client_id, estimate_id, document_category,
   is_active, uploaded_by, created_at, updated_at)
SELECT
  f.id,
  COALESCE(NULLIF(f.filename, ''), 'Document'),
  COALESCE(NULLIF(f.mime_type, ''), 'application/octet-stream'),
  f.size_bytes,
  f.r2_key,
  '/api/documents/' || f.id || '/file',
  NULL,
  CASE WHEN f.job_id IS NOT NULL THEN 'job'
       WHEN f.estimate_id IS NOT NULL THEN 'estimate'
       ELSE 'company' END,
  f.job_id,
  NULL,
  f.estimate_id,
  COALESCE(NULLIF(f.category, ''), 'other'),
  CASE WHEN f.deleted_at IS NOT NULL THEN 0
       WHEN COALESCE(f.archived, 0) = 1 THEN 0
       ELSE 1 END,
  f.uploaded_by,
  COALESCE(f.uploaded_at, datetime('now')),
  COALESCE(f.uploaded_at, datetime('now'))
FROM files f
WHERE f.r2_key IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = f.id);

-- ── company_documents → documents (context_type='company') ───────────────────
INSERT INTO documents
  (id, title, file_type, file_size, r2_key, r2_url, mirror_status,
   context_type, job_id, client_id, estimate_id, document_category,
   is_active, uploaded_by, created_at, updated_at)
SELECT
  cd.id,
  COALESCE(NULLIF(cd.title, ''), NULLIF(cd.filename, ''), 'Company Document'),
  COALESCE(NULLIF(cd.mime_type, ''), 'application/octet-stream'),
  cd.size_bytes,
  cd.r2_key,
  '/api/documents/' || cd.id || '/file',
  NULL,
  'company',
  NULL,
  NULL,
  NULL,
  COALESCE(NULLIF(cd.doc_type, ''), 'other'),
  1,
  cd.uploaded_by,
  COALESCE(cd.created_at, datetime('now')),
  COALESCE(cd.updated_at, cd.created_at, datetime('now'))
FROM company_documents cd
WHERE cd.r2_key IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = cd.id);

-- ── Verification (counts should reconcile; re-run prints stable numbers) ──────
SELECT
  (SELECT COUNT(*) FROM files)                                            AS files_total,
  (SELECT COUNT(*) FROM company_documents)                               AS company_docs_total,
  (SELECT COUNT(*) FROM documents WHERE id IN (SELECT id FROM files))    AS migrated_from_files,
  (SELECT COUNT(*) FROM documents WHERE id IN (SELECT id FROM company_documents)) AS migrated_from_company,
  (SELECT COUNT(*) FROM documents)                                       AS documents_total;

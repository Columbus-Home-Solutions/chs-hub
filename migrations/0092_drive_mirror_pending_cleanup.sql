-- 0092_drive_mirror_pending_cleanup.sql
-- Clear ghost pending rows on superseded estimate contracts, and queue signed
-- selection approvals that predate mirror_status='pending' on sign completion.
--
-- Apply remotely:
--   npx wrangler d1 execute chs-hub-db --remote --file=migrations/0092_drive_mirror_pending_cleanup.sql

UPDATE documents
   SET mirror_status = 'skipped'
 WHERE is_active = 0
   AND mirror_status = 'pending';

UPDATE documents
   SET mirror_status = 'pending'
 WHERE mirror_status IS NULL
   AND COALESCE(is_active, 1) = 1
   AND is_signed = 1
   AND r2_key IS NOT NULL
   AND document_category = 'selection_approval';

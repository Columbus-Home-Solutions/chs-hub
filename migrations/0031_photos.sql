-- 0031_photos.sql
-- Sprint 8 — Photo Capture & Smart Notes.
--
-- The four module tables (photos, receipt_photos, daily_logs, smart_notes)
-- already exist with every column this sprint needs (created in the 0017/0019
-- job/photo-document migrations and extended in 0014_schema_bridge). PRAGMA
-- table_info confirmed all columns are present locally, so Sprint 8 needs NO
-- DDL on the tables themselves — only a handful of missing performance indexes
-- for the new lookups (daily-log/task photo linking, the receipt-processing
-- queue). Idempotent; safe to run once. Do NOT re-create the tables.

-- Photos linked to a daily log (daily-log photo-of-the-day rendering) and to a
-- task (punch-list-needs-a-photo). The (job_id, taken_at) timeline index already
-- exists as idx_photos_job.
CREATE INDEX IF NOT EXISTS idx_photos_daily_log ON photos(daily_log_id);
CREATE INDEX IF NOT EXISTS idx_photos_task ON photos(task_id);

-- Active-photo timeline filter (soft-delete is_active=0 rows are excluded).
CREATE INDEX IF NOT EXISTS idx_photos_job_active ON photos(job_id, is_active, taken_at);

-- Receipt-processing queue is queried by status (pending → processed/failed).
CREATE INDEX IF NOT EXISTS idx_receipt_photos_status ON receipt_photos(processing_status);

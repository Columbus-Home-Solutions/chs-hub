-- Track Drive mirror completion for per-job project files (job_files table).

ALTER TABLE job_files ADD COLUMN drive_mirrored_at TEXT;
CREATE INDEX IF NOT EXISTS idx_job_files_drive_mirrored ON job_files(drive_mirrored_at);

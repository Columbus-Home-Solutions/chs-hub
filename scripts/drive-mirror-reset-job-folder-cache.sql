-- Clears client_*, year_*, yr_*, yc_*, job_*, stub_* cache keys (legacy + current Jobs layout).
-- After this, the next mirror run recreates `Jobs/<year>/<client>/<#num Title>/Photos|Receipts|Files` (e.g. `#99 Deck Railing`).
--
-- Old folders in Google Drive are NOT removed — delete or rename them in Drive if you want a clean tree.
--
-- Optional: re-upload all hub files into the new folders by clearing mirror checkpoints first:
--   UPDATE photos SET drive_mirrored_at = NULL WHERE drive_mirrored_at IS NOT NULL;
--   UPDATE expenses SET drive_mirrored_at = NULL WHERE receipt_r2_key IS NOT NULL AND drive_mirrored_at IS NOT NULL;
--   UPDATE job_files SET drive_mirrored_at = NULL WHERE drive_mirrored_at IS NOT NULL;
--   UPDATE company_documents SET drive_mirrored_at = NULL WHERE drive_mirrored_at IS NOT NULL;
-- (Expect duplicate files if you leave old Drive folders in place.)

DELETE FROM drive_mirror_folders
WHERE path_key LIKE 'client\_%' ESCAPE '\'
   OR path_key LIKE 'year\_%' ESCAPE '\'
   OR path_key LIKE 'yr\_%' ESCAPE '\'
   OR path_key LIKE 'yc\_%' ESCAPE '\'
   OR path_key LIKE 'job\_%' ESCAPE '\'
   OR path_key LIKE 'stub\_%' ESCAPE '\';

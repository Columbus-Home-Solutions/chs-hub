-- Session F Phase 2 — 04: drive_mirror_folders DB rows only
-- Removes app references to Drive folders for test jobs/clients.
-- Does NOT delete anything in Google Drive or R2 (Tony handles Drive manually).
-- Expected (Phase 1): ~29 rows matching these job id path keys.

-- ========== PREVIEW COUNTS ==========
SELECT 'drive_mirror_folders' AS tbl, COUNT(*) AS n FROM drive_mirror_folders
 WHERE path_key LIKE '%7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c%'
    OR path_key LIKE '%79738377-b314-49bc-b273-eb550c49d682%'
    OR path_key LIKE '%1c040987-270a-482e-5f50-6a293a7b8c9d%'
    OR path_key LIKE '%4dca37fb-8df3-49d0-9a42-f5c11e52ffd8%'
    OR path_key LIKE '%1de4f226-3f26-4388-9472-6a7979e8966b%'
    OR path_key LIKE '%0f6420d6-4aaf-431c-a662-9c3964335dbe%'
    OR path_key LIKE '%971d7222-66a9-4c67-8ba1-7bb0ec431830%'
    OR path_key LIKE '%a420c3be-d984-4af8-a73d-8712ed963bb3%'
    OR path_key LIKE '%1ba146fe-1b8d-4918-aa40-b58a5d6e2870%'
    OR path_key LIKE '%19238d70-7aaa-45f1-94eb-7d3fd67be7f4%'
    OR path_key LIKE '%760c1458-3d76-48b9-8258-0d48fe611a1b%'
    OR path_key LIKE '%1cddd144-2a08-4c17-ab0e-0a70d086fb44%'
    OR path_key LIKE '%2645c483-569c-48f6-8fc1-9e6aa1c41255%';

-- Sample keys about to be removed
SELECT path_key, drive_folder_id FROM drive_mirror_folders
 WHERE path_key LIKE '%7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c%'
    OR path_key LIKE '%79738377-b314-49bc-b273-eb550c49d682%'
    OR path_key LIKE '%1c040987-270a-482e-5f50-6a293a7b8c9d%'
    OR path_key LIKE '%4dca37fb-8df3-49d0-9a42-f5c11e52ffd8%'
    OR path_key LIKE '%1de4f226-3f26-4388-9472-6a7979e8966b%'
    OR path_key LIKE '%0f6420d6-4aaf-431c-a662-9c3964335dbe%'
    OR path_key LIKE '%971d7222-66a9-4c67-8ba1-7bb0ec431830%'
    OR path_key LIKE '%a420c3be-d984-4af8-a73d-8712ed963bb3%'
    OR path_key LIKE '%1ba146fe-1b8d-4918-aa40-b58a5d6e2870%'
    OR path_key LIKE '%19238d70-7aaa-45f1-94eb-7d3fd67be7f4%'
    OR path_key LIKE '%760c1458-3d76-48b9-8258-0d48fe611a1b%'
    OR path_key LIKE '%1cddd144-2a08-4c17-ab0e-0a70d086fb44%'
    OR path_key LIKE '%2645c483-569c-48f6-8fc1-9e6aa1c41255%'
 ORDER BY path_key;

-- ========== DELETE ==========
DELETE FROM drive_mirror_folders
 WHERE path_key LIKE '%7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c%'
    OR path_key LIKE '%79738377-b314-49bc-b273-eb550c49d682%'
    OR path_key LIKE '%1c040987-270a-482e-5f50-6a293a7b8c9d%'
    OR path_key LIKE '%4dca37fb-8df3-49d0-9a42-f5c11e52ffd8%'
    OR path_key LIKE '%1de4f226-3f26-4388-9472-6a7979e8966b%'
    OR path_key LIKE '%0f6420d6-4aaf-431c-a662-9c3964335dbe%'
    OR path_key LIKE '%971d7222-66a9-4c67-8ba1-7bb0ec431830%'
    OR path_key LIKE '%a420c3be-d984-4af8-a73d-8712ed963bb3%'
    OR path_key LIKE '%1ba146fe-1b8d-4918-aa40-b58a5d6e2870%'
    OR path_key LIKE '%19238d70-7aaa-45f1-94eb-7d3fd67be7f4%'
    OR path_key LIKE '%760c1458-3d76-48b9-8258-0d48fe611a1b%'
    OR path_key LIKE '%1cddd144-2a08-4c17-ab0e-0a70d086fb44%'
    OR path_key LIKE '%2645c483-569c-48f6-8fc1-9e6aa1c41255%';

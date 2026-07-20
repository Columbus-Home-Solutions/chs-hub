-- Session F Phase 2 — 03: documents + communications + notification_logs (FK-order fixed)
-- Scoped to both test clients, all 11 test jobs, and all EST-99001…99019.
-- DB rows only — does NOT delete Drive/R2 file bytes.
-- Expected (Phase 1): documents ~47, communications ~71, notification_logs ~79.
--
-- CRITICAL FKs (caused / would cause SQLITE_CONSTRAINT_FOREIGNKEY):
--   selection_choices.client_signature_document_id → documents(id)
--     Live: 4 rows on orphan estimates (99004 / 99013 / 99019) still point at scoped docs.
--   notification_logs.communication_id → communications(id)
--     Live: ~70 logs point at scoped communications — must delete/null BEFORE communications.
-- Also detach (defensive, even if currently 0 rows):
--   lien_waivers.document_id → documents(id)
--   client_lien_waivers.document_id → documents(id)
--   permits.document_id → documents(id)
--   subcontractor_packet_documents.document_id → documents(id)
--   subcontractor_packets.agreement_document_id → documents(id)
--
-- Delete order:
--   1) NULL all FKs into scoped documents
--   2) DELETE notification_logs (scoped + any that reference scoped communications)
--   3) DELETE documents
--   4) DELETE communications

-- Clients:
--   7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c  ZZTEST-PRELAUNCH Test Client
--   79738377-b314-49bc-b273-eb550c49d682  Test Client

-- ========== PREVIEW COUNTS ==========
SELECT 'documents' AS tbl, COUNT(*) AS n FROM documents
 WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
    OR job_id IN (
      '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
      '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
      '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
      '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
      '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
      '2645c483-569c-48f6-8fc1-9e6aa1c41255'
    )
    OR estimate_id IN (
      '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
      'b375f3d5-db89-4cd7-9e76-53d2636cc984','02e2a571-a385-4560-8247-8cd658737c26',
      'c5165a41-7366-4498-b34c-e449dd7acbb0','aac09d23-fc50-4c69-99fa-b3d319be371a',
      '2c8cc959-e990-4323-b3d4-f770791ada10','f10487bc-c6ef-4685-b28d-ee2987b01304',
      '76c83eee-66ae-463c-b7a7-a1292afc6834','a916c0dd-3ddf-47e8-add0-5b82a65d223e',
      '72e7a79a-d034-4de0-9db6-ed65be3fa99f','dc73cbef-34e1-4ebb-91da-4ef181e72b38',
      '035b8c5e-f172-42b8-b479-a17f1e623666','ad4868f2-2632-4f14-80f6-5fa09564134f',
      'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
      'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
      'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
    );

SELECT 'communications' AS tbl, COUNT(*) AS n FROM communications
 WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
    OR job_id IN (
      '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
      '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
      '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
      '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
      '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
      '2645c483-569c-48f6-8fc1-9e6aa1c41255'
    );

SELECT 'notification_logs' AS tbl, COUNT(*) AS n FROM notification_logs
 WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
    OR job_id IN (
      '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
      '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
      '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
      '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
      '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
      '2645c483-569c-48f6-8fc1-9e6aa1c41255'
    )
    OR estimate_request_id IN (
      SELECT id FROM estimate_requests
       WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
    )
    OR communication_id IN (
      SELECT id FROM communications
       WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
          OR job_id IN (
            '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
            '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
            '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
            '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
            '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
            '2645c483-569c-48f6-8fc1-9e6aa1c41255'
          )
    );

SELECT 'selection_choices_pointing_at_docs' AS tbl, COUNT(*) AS n FROM selection_choices
 WHERE client_signature_document_id IN (
   SELECT id FROM documents
    WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
       OR job_id IN (
         '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
         '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
         '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
         '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
         '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
         '2645c483-569c-48f6-8fc1-9e6aa1c41255'
       )
       OR estimate_id IN (
         '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
         'b375f3d5-db89-4cd7-9e76-53d2636cc984','02e2a571-a385-4560-8247-8cd658737c26',
         'c5165a41-7366-4498-b34c-e449dd7acbb0','aac09d23-fc50-4c69-99fa-b3d319be371a',
         '2c8cc959-e990-4323-b3d4-f770791ada10','f10487bc-c6ef-4685-b28d-ee2987b01304',
         '76c83eee-66ae-463c-b7a7-a1292afc6834','a916c0dd-3ddf-47e8-add0-5b82a65d223e',
         '72e7a79a-d034-4de0-9db6-ed65be3fa99f','dc73cbef-34e1-4ebb-91da-4ef181e72b38',
         '035b8c5e-f172-42b8-b479-a17f1e623666','ad4868f2-2632-4f14-80f6-5fa09564134f',
         'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
         'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
         'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
       )
 );

SELECT 'notif_logs_pointing_at_comms' AS tbl, COUNT(*) AS n FROM notification_logs
 WHERE communication_id IN (
   SELECT id FROM communications
    WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
       OR job_id IN (
         '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
         '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
         '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
         '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
         '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
         '2645c483-569c-48f6-8fc1-9e6aa1c41255'
       )
 );

-- ========== 1) DETACH FKs into scoped documents ==========
UPDATE selection_choices
   SET client_signature_document_id = NULL
 WHERE client_signature_document_id IN (
   SELECT id FROM documents
    WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
       OR job_id IN (
         '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
         '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
         '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
         '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
         '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
         '2645c483-569c-48f6-8fc1-9e6aa1c41255'
       )
       OR estimate_id IN (
         '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
         'b375f3d5-db89-4cd7-9e76-53d2636cc984','02e2a571-a385-4560-8247-8cd658737c26',
         'c5165a41-7366-4498-b34c-e449dd7acbb0','aac09d23-fc50-4c69-99fa-b3d319be371a',
         '2c8cc959-e990-4323-b3d4-f770791ada10','f10487bc-c6ef-4685-b28d-ee2987b01304',
         '76c83eee-66ae-463c-b7a7-a1292afc6834','a916c0dd-3ddf-47e8-add0-5b82a65d223e',
         '72e7a79a-d034-4de0-9db6-ed65be3fa99f','dc73cbef-34e1-4ebb-91da-4ef181e72b38',
         '035b8c5e-f172-42b8-b479-a17f1e623666','ad4868f2-2632-4f14-80f6-5fa09564134f',
         'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
         'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
         'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
       )
 );

UPDATE lien_waivers
   SET document_id = NULL
 WHERE document_id IN (
   SELECT id FROM documents
    WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
       OR job_id IN (
         '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
         '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
         '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
         '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
         '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
         '2645c483-569c-48f6-8fc1-9e6aa1c41255'
       )
       OR estimate_id IN (
         '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
         'b375f3d5-db89-4cd7-9e76-53d2636cc984','02e2a571-a385-4560-8247-8cd658737c26',
         'c5165a41-7366-4498-b34c-e449dd7acbb0','aac09d23-fc50-4c69-99fa-b3d319be371a',
         '2c8cc959-e990-4323-b3d4-f770791ada10','f10487bc-c6ef-4685-b28d-ee2987b01304',
         '76c83eee-66ae-463c-b7a7-a1292afc6834','a916c0dd-3ddf-47e8-add0-5b82a65d223e',
         '72e7a79a-d034-4de0-9db6-ed65be3fa99f','dc73cbef-34e1-4ebb-91da-4ef181e72b38',
         '035b8c5e-f172-42b8-b479-a17f1e623666','ad4868f2-2632-4f14-80f6-5fa09564134f',
         'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
         'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
         'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
       )
 );

UPDATE client_lien_waivers
   SET document_id = NULL
 WHERE document_id IN (
   SELECT id FROM documents
    WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
       OR job_id IN (
         '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
         '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
         '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
         '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
         '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
         '2645c483-569c-48f6-8fc1-9e6aa1c41255'
       )
       OR estimate_id IN (
         '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
         'b375f3d5-db89-4cd7-9e76-53d2636cc984','02e2a571-a385-4560-8247-8cd658737c26',
         'c5165a41-7366-4498-b34c-e449dd7acbb0','aac09d23-fc50-4c69-99fa-b3d319be371a',
         '2c8cc959-e990-4323-b3d4-f770791ada10','f10487bc-c6ef-4685-b28d-ee2987b01304',
         '76c83eee-66ae-463c-b7a7-a1292afc6834','a916c0dd-3ddf-47e8-add0-5b82a65d223e',
         '72e7a79a-d034-4de0-9db6-ed65be3fa99f','dc73cbef-34e1-4ebb-91da-4ef181e72b38',
         '035b8c5e-f172-42b8-b479-a17f1e623666','ad4868f2-2632-4f14-80f6-5fa09564134f',
         'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
         'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
         'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
       )
 );

UPDATE permits
   SET document_id = NULL
 WHERE document_id IN (
   SELECT id FROM documents
    WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
       OR job_id IN (
         '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
         '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
         '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
         '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
         '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
         '2645c483-569c-48f6-8fc1-9e6aa1c41255'
       )
       OR estimate_id IN (
         '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
         'b375f3d5-db89-4cd7-9e76-53d2636cc984','02e2a571-a385-4560-8247-8cd658737c26',
         'c5165a41-7366-4498-b34c-e449dd7acbb0','aac09d23-fc50-4c69-99fa-b3d319be371a',
         '2c8cc959-e990-4323-b3d4-f770791ada10','f10487bc-c6ef-4685-b28d-ee2987b01304',
         '76c83eee-66ae-463c-b7a7-a1292afc6834','a916c0dd-3ddf-47e8-add0-5b82a65d223e',
         '72e7a79a-d034-4de0-9db6-ed65be3fa99f','dc73cbef-34e1-4ebb-91da-4ef181e72b38',
         '035b8c5e-f172-42b8-b479-a17f1e623666','ad4868f2-2632-4f14-80f6-5fa09564134f',
         'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
         'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
         'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
       )
 );

UPDATE subcontractor_packet_documents
   SET document_id = NULL
 WHERE document_id IN (
   SELECT id FROM documents
    WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
       OR job_id IN (
         '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
         '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
         '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
         '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
         '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
         '2645c483-569c-48f6-8fc1-9e6aa1c41255'
       )
       OR estimate_id IN (
         '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
         'b375f3d5-db89-4cd7-9e76-53d2636cc984','02e2a571-a385-4560-8247-8cd658737c26',
         'c5165a41-7366-4498-b34c-e449dd7acbb0','aac09d23-fc50-4c69-99fa-b3d319be371a',
         '2c8cc959-e990-4323-b3d4-f770791ada10','f10487bc-c6ef-4685-b28d-ee2987b01304',
         '76c83eee-66ae-463c-b7a7-a1292afc6834','a916c0dd-3ddf-47e8-add0-5b82a65d223e',
         '72e7a79a-d034-4de0-9db6-ed65be3fa99f','dc73cbef-34e1-4ebb-91da-4ef181e72b38',
         '035b8c5e-f172-42b8-b479-a17f1e623666','ad4868f2-2632-4f14-80f6-5fa09564134f',
         'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
         'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
         'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
       )
 );

UPDATE subcontractor_packets
   SET agreement_document_id = NULL
 WHERE agreement_document_id IN (
   SELECT id FROM documents
    WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
       OR job_id IN (
         '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
         '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
         '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
         '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
         '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
         '2645c483-569c-48f6-8fc1-9e6aa1c41255'
       )
       OR estimate_id IN (
         '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
         'b375f3d5-db89-4cd7-9e76-53d2636cc984','02e2a571-a385-4560-8247-8cd658737c26',
         'c5165a41-7366-4498-b34c-e449dd7acbb0','aac09d23-fc50-4c69-99fa-b3d319be371a',
         '2c8cc959-e990-4323-b3d4-f770791ada10','f10487bc-c6ef-4685-b28d-ee2987b01304',
         '76c83eee-66ae-463c-b7a7-a1292afc6834','a916c0dd-3ddf-47e8-add0-5b82a65d223e',
         '72e7a79a-d034-4de0-9db6-ed65be3fa99f','dc73cbef-34e1-4ebb-91da-4ef181e72b38',
         '035b8c5e-f172-42b8-b479-a17f1e623666','ad4868f2-2632-4f14-80f6-5fa09564134f',
         'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
         'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
         'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
       )
 );

-- ========== 2) notification_logs BEFORE communications ==========
DELETE FROM notification_logs
 WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
    OR job_id IN (
      '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
      '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
      '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
      '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
      '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
      '2645c483-569c-48f6-8fc1-9e6aa1c41255'
    )
    OR estimate_request_id IN (
      SELECT id FROM estimate_requests
       WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
    )
    OR communication_id IN (
      SELECT id FROM communications
       WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
          OR job_id IN (
            '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
            '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
            '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
            '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
            '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
            '2645c483-569c-48f6-8fc1-9e6aa1c41255'
          )
    );

-- ========== 3) documents (after all inbound FKs nulled) ==========
DELETE FROM documents
 WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
    OR job_id IN (
      '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
      '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
      '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
      '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
      '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
      '2645c483-569c-48f6-8fc1-9e6aa1c41255'
    )
    OR estimate_id IN (
      '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f','1425c3da-3401-498a-b6a7-3bafb63d9375',
      'b375f3d5-db89-4cd7-9e76-53d2636cc984','02e2a571-a385-4560-8247-8cd658737c26',
      'c5165a41-7366-4498-b34c-e449dd7acbb0','aac09d23-fc50-4c69-99fa-b3d319be371a',
      '2c8cc959-e990-4323-b3d4-f770791ada10','f10487bc-c6ef-4685-b28d-ee2987b01304',
      '76c83eee-66ae-463c-b7a7-a1292afc6834','a916c0dd-3ddf-47e8-add0-5b82a65d223e',
      '72e7a79a-d034-4de0-9db6-ed65be3fa99f','dc73cbef-34e1-4ebb-91da-4ef181e72b38',
      '035b8c5e-f172-42b8-b479-a17f1e623666','ad4868f2-2632-4f14-80f6-5fa09564134f',
      'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
      'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
      'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
    );

-- ========== 4) communications (after notification_logs cleared) ==========
DELETE FROM communications
 WHERE client_id IN ('7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c','79738377-b314-49bc-b273-eb550c49d682')
    OR job_id IN (
      '1c040987-270a-482e-5f50-6a293a7b8c9d','4dca37fb-8df3-49d0-9a42-f5c11e52ffd8',
      '1de4f226-3f26-4388-9472-6a7979e8966b','0f6420d6-4aaf-431c-a662-9c3964335dbe',
      '971d7222-66a9-4c67-8ba1-7bb0ec431830','a420c3be-d984-4af8-a73d-8712ed963bb3',
      '1ba146fe-1b8d-4918-aa40-b58a5d6e2870','19238d70-7aaa-45f1-94eb-7d3fd67be7f4',
      '760c1458-3d76-48b9-8258-0d48fe611a1b','1cddd144-2a08-4c17-ab0e-0a70d086fb44',
      '2645c483-569c-48f6-8fc1-9e6aa1c41255'
    );

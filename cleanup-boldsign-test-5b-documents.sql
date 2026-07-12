-- Cleanup step 3 (file 5b) — documents rows created by live BoldSign tests
-- RUN ORDER: 3 of 7
--
-- Must run AFTER steps 1 and 3 (choices + packet gone) and BEFORE step 6 (clients).
-- The selection document has client_id FK → clients(id); that blocked the original
-- step-6 clients delete until these rows were removed.
--
-- Known IDs from the successful live tests (July 2026):
--   1ee5481e-0ed9-4815-bc05-20f2a6dfc141  context_type='selection'
--   2f54fd6d-3b36-4acb-97a4-5e4e02db6cc9  context_type='subcontractor_agreement'

DELETE FROM documents WHERE id IN (
  '1ee5481e-0ed9-4815-bc05-20f2a6dfc141',
  '2f54fd6d-3b36-4acb-97a4-5e4e02db6cc9'
);

-- Safety net: catch any documents tied to the test entities by signature_data
DELETE FROM documents
WHERE context_type IN ('selection', 'subcontractor_agreement')
  AND (
    json_extract(signature_data, '$.selection_id') = '1ac2522e-9c9b-4775-a041-c7800b1e0b3b'
    OR json_extract(signature_data, '$.choice_id')   = '65e79c79-3d73-41a5-a4e4-422255994506'
    OR json_extract(signature_data, '$.job_id')      = '9b45e128-07a3-4856-904e-fc147713b256'
    OR json_extract(signature_data, '$.packet_id')   = '58e9f26d-03f0-495f-8743-62bb7980ef1c'
  );

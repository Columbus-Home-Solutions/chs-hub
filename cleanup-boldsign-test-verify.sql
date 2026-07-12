-- Final verification — run AFTER all cleanup files in this order:
--   1-selection-choices → 3-subcontractor-packets → 5b-documents →
--   2-selections → 4-subcontractors → 5-jobs → 6-clients
--
-- D1 rejects compound SELECTs with more than ~5 UNION ALL terms ("too many terms
-- in compound SELECT"). Each statement below stays at 3 terms max.
-- Expect zero rows back from every statement.

SELECT 'clients' AS tbl, id FROM clients WHERE first_name = 'ZZTEST-BOLDSIGN'
UNION ALL
SELECT 'jobs', id FROM jobs WHERE title LIKE '%ZZTEST-BOLDSIGN%'
UNION ALL
SELECT 'subcontractors', id FROM subcontractors WHERE company_name LIKE 'ZZTEST-BOLDSIGN%';

SELECT 'selections' AS tbl, id FROM selections WHERE title LIKE '%ZZTEST-BOLDSIGN%'
UNION ALL
SELECT 'selection_choices', id FROM selection_choices WHERE title LIKE '%ZZTEST-BOLDSIGN%'
UNION ALL
SELECT 'subcontractor_packets', id FROM subcontractor_packets WHERE id = '58e9f26d-03f0-495f-8743-62bb7980ef1c';

SELECT 'doc_selection' AS tbl, id FROM documents WHERE id = '1ee5481e-0ed9-4815-bc05-20f2a6dfc141'
UNION ALL
SELECT 'doc_agreement', id FROM documents WHERE id = '2f54fd6d-3b36-4acb-97a4-5e4e02db6cc9'
UNION ALL
SELECT 'doc_by_sig', id FROM documents
  WHERE context_type IN ('selection', 'subcontractor_agreement')
    AND json_extract(signature_data, '$.job_id') = '9b45e128-07a3-4856-904e-fc147713b256';

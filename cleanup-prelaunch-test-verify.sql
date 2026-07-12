-- Final verification — run AFTER all 8 cleanup files.
-- D1 compound-SELECT limit: max 3 UNION ALL terms per statement.
-- Expect zero rows back from every statement.

SELECT 'clients' AS tbl, id FROM clients WHERE first_name = 'ZZTEST-PRELAUNCH'
UNION ALL
SELECT 'jobs', id FROM jobs WHERE title LIKE '%ZZTEST-PRELAUNCH%'
UNION ALL
SELECT 'subcontractors', id FROM subcontractors WHERE company_name LIKE 'ZZTEST-PRELAUNCH%';

SELECT 'bid_requests' AS tbl, id FROM bid_requests WHERE title LIKE '%ZZTEST-PRELAUNCH%'
UNION ALL
SELECT 'daily_logs', id FROM daily_logs WHERE id = '4500c310-5003-41b7-e809-9502c3013636'
UNION ALL
SELECT 'estimates', id FROM estimates WHERE id = '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f';

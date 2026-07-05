PRAGMA defer_foreign_keys = TRUE;

UPDATE estimate_requests SET estimate_id = NULL
  WHERE id = '4a3ba535-460f-4c8d-b3c9-2aba18294854';

DELETE FROM notification_logs WHERE client_id = '037f35b6-0e06-4c95-983b-dcf00e126c9f'
  OR estimate_request_id = '4a3ba535-460f-4c8d-b3c9-2aba18294854';

DELETE FROM documents WHERE client_id = '037f35b6-0e06-4c95-983b-dcf00e126c9f'
  OR estimate_id = 'c5859f38-4053-47ce-b07a-dc1e62d7a4e5';

DELETE FROM communications WHERE client_id = '037f35b6-0e06-4c95-983b-dcf00e126c9f';

DELETE FROM files WHERE estimate_id = 'c5859f38-4053-47ce-b07a-dc1e62d7a4e5';

UPDATE google_reviews SET matched_client_id = NULL
  WHERE matched_client_id = '037f35b6-0e06-4c95-983b-dcf00e126c9f';

DELETE FROM photos WHERE estimate_request_id = '4a3ba535-460f-4c8d-b3c9-2aba18294854';

DELETE FROM estimates WHERE id = 'c5859f38-4053-47ce-b07a-dc1e62d7a4e5';

DELETE FROM estimate_requests WHERE id = '4a3ba535-460f-4c8d-b3c9-2aba18294854'
  AND client_id = '037f35b6-0e06-4c95-983b-dcf00e126c9f';

DELETE FROM clients WHERE id = '037f35b6-0e06-4c95-983b-dcf00e126c9f'
  AND first_name = 'test' AND last_name = 'test';

PRAGMA defer_foreign_keys = TRUE;

UPDATE expenses SET receipt_photo_id = NULL
  WHERE receipt_photo_id IN (SELECT id FROM photos WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60');

UPDATE estimate_requests SET converted_job_id = NULL
  WHERE converted_job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

UPDATE photos SET before_after_pair_id = NULL
  WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

UPDATE users SET current_job_id = NULL
  WHERE current_job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

UPDATE google_reviews SET matched_client_id = NULL
  WHERE matched_client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';

DELETE FROM receipt_photos WHERE expense_id IN (
  SELECT id FROM expenses WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60'
);
DELETE FROM signature_events WHERE job_document_id IN (
  SELECT id FROM job_documents WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60'
);

DELETE FROM expenses WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM photos WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

DELETE FROM photos WHERE estimate_request_id IN (
  SELECT id FROM estimate_requests WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910'
);

DELETE FROM quotes            WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM files             WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM billing_schedule  WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM job_documents     WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM communications    WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM daily_logs        WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM change_orders     WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM schedule_entries  WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM permits           WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM warranties        WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM time_entries      WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM billing_cycles    WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM mileage           WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM lien_waivers      WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM documents         WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM notification_logs WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM social_posts      WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM smart_notes       WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM tasks             WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

DELETE FROM payments WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';
DELETE FROM invoices WHERE job_id = 'a900736b-0efd-44f2-89aa-76fec4155a60';

DELETE FROM jobs WHERE id = 'a900736b-0efd-44f2-89aa-76fec4155a60'
  AND job_number = 100;

DELETE FROM quotes            WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM communications    WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM notification_logs WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM documents         WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM properties        WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM estimates         WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';
DELETE FROM estimate_requests WHERE client_id = 'cc994be0-d17b-4f66-9688-f3253b897910';

DELETE FROM clients WHERE id = 'cc994be0-d17b-4f66-9688-f3253b897910';

-- Cleanup step 5: jobs (+ payment + estimate_request FK holder)
-- estimate_requests.converted_job_id → jobs(id) — delete request first.
DELETE FROM estimate_requests WHERE id IN (
  '5a290d0c-6b1e-4c70-a394-0b6d8c1e2f3a'
);

DELETE FROM payments WHERE id IN (
  '0b030876-1609-471d-4e4f-5a1829678b8c'
);

DELETE FROM jobs WHERE id IN (
  '1c040987-270a-482e-5f50-6a293a7b8c9d'
);

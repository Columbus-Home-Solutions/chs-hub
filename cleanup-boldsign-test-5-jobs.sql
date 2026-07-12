-- Cleanup step 6 (file 5) — jobs
-- RUN ORDER: 6 of 7
--
-- Overage note: the $150 selection overage only updated jobs.contract_total inline
-- (no change_orders row). Deleting the job removes the overage side effect.

DELETE FROM jobs WHERE id IN (
  '9b45e128-07a3-4856-904e-fc147713b256'
);

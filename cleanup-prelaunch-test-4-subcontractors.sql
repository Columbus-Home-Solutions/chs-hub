-- Cleanup step 4: subcontractors
DELETE FROM subcontractors WHERE id IN (
  '9a020765-0508-460c-3d3e-4a0718567a7b',
  '89010754-9407-45fb-2c2d-390607457a6a'
);

-- Cleanup step 6: estimates (+ line items)
DELETE FROM estimate_line_items WHERE id IN (
  '3e070b8a-490c-4a50-8172-8a4b6c9d0e1f',
  '2d060a79-380b-493f-7061-7a3a5b8c9d0e'
);

DELETE FROM estimates WHERE id IN (
  '4f180c9b-5a0d-4b60-9283-9a5c7b0d1e2f'
);

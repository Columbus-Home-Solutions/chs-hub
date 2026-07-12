-- Cleanup step 2: bid_request_recipients
DELETE FROM bid_request_recipients WHERE id IN (
  '6700e532-7205-43d9-0a0b-1704e5235858',
  '5600d421-6104-42c8-f90a-0603d4124747'
);

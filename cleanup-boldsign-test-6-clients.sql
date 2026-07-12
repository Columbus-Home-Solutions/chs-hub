-- Cleanup step 7 (file 6) — clients
-- RUN ORDER: 7 of 7 — must run AFTER 5b-documents.sql

DELETE FROM clients WHERE id IN (
  '3b1bf0e3-37ed-471b-970c-965ceb2f025a'
);

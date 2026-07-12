-- Cleanup step 1 — selection_choices
-- RUN ORDER: 1 of 7 (see comments in each file)
--
-- FK note: client_signature_document_id → documents(id). Deleting the choice row
-- is safe; it does not block later document deletes.

DELETE FROM selection_choices WHERE id IN (
  '65e79c79-3d73-41a5-a4e4-422255994506'
);

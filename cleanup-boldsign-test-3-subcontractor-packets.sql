-- Cleanup step 2 (file 3) — subcontractor_packet_documents + subcontractor_packets
-- RUN ORDER: 2 of 7
--
-- FK note: agreement_document_id on the packet points TO documents. Delete the
-- packet row before deleting documents (step 5b) so nothing holds a ref to them.
-- packet_documents rows must go before the packet itself.

DELETE FROM subcontractor_packet_documents WHERE packet_id IN (
  '58e9f26d-03f0-495f-8743-62bb7980ef1c'
);

DELETE FROM subcontractor_packets WHERE id IN (
  '58e9f26d-03f0-495f-8743-62bb7980ef1c'
);

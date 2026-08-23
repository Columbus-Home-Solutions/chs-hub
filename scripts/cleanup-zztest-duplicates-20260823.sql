-- Cleanup duplicate ZZTEST clients (after R2 backup 2026-08-23).
-- KEEP: b1000001-0000-4000-8000-000000000001
-- Prerequisite: selections.chosen_choice_id already nulled for deleted estimates.

DELETE FROM selection_choices
 WHERE selection_id IN (
   SELECT id FROM selections WHERE estimate_id IN (
     'eb1266d9-ef5b-4fd3-94a5-83ddc93acd68',
     'd2b4ca00-c00d-4c90-a121-473d44c0b6ce',
     '4a9dd12c-ca52-4953-ae96-80dbdc33740d'
   )
 );

DELETE FROM selections
 WHERE estimate_id IN (
   'eb1266d9-ef5b-4fd3-94a5-83ddc93acd68',
   'd2b4ca00-c00d-4c90-a121-473d44c0b6ce',
   '4a9dd12c-ca52-4953-ae96-80dbdc33740d'
 );

DELETE FROM estimate_line_items
 WHERE estimate_id IN (
   'eb1266d9-ef5b-4fd3-94a5-83ddc93acd68',
   'd2b4ca00-c00d-4c90-a121-473d44c0b6ce',
   '4a9dd12c-ca52-4953-ae96-80dbdc33740d'
 );

DELETE FROM payment_schedules
 WHERE estimate_id IN (
   'eb1266d9-ef5b-4fd3-94a5-83ddc93acd68',
   'd2b4ca00-c00d-4c90-a121-473d44c0b6ce',
   '4a9dd12c-ca52-4953-ae96-80dbdc33740d'
 );

DELETE FROM documents
 WHERE estimate_id IN (
   'eb1266d9-ef5b-4fd3-94a5-83ddc93acd68',
   'd2b4ca00-c00d-4c90-a121-473d44c0b6ce',
   '4a9dd12c-ca52-4953-ae96-80dbdc33740d'
 );

DELETE FROM bid_requests
 WHERE estimate_id IN (
   'eb1266d9-ef5b-4fd3-94a5-83ddc93acd68',
   'd2b4ca00-c00d-4c90-a121-473d44c0b6ce',
   '4a9dd12c-ca52-4953-ae96-80dbdc33740d'
 );

DELETE FROM pending_quote_imports
 WHERE estimate_id IN (
   'eb1266d9-ef5b-4fd3-94a5-83ddc93acd68',
   'd2b4ca00-c00d-4c90-a121-473d44c0b6ce',
   '4a9dd12c-ca52-4953-ae96-80dbdc33740d'
 );

DELETE FROM notification_logs
 WHERE client_id IN (
   '0cd69c8e-d74d-4f84-b624-9cf6fc88093e',
   '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c'
 );

DELETE FROM communications
 WHERE client_id IN (
   '0cd69c8e-d74d-4f84-b624-9cf6fc88093e',
   '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c'
 );

DELETE FROM estimates
 WHERE id IN (
   'eb1266d9-ef5b-4fd3-94a5-83ddc93acd68',
   'd2b4ca00-c00d-4c90-a121-473d44c0b6ce',
   '4a9dd12c-ca52-4953-ae96-80dbdc33740d'
 );

DELETE FROM estimate_requests
 WHERE client_id IN (
   '0cd69c8e-d74d-4f84-b624-9cf6fc88093e',
   '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c'
 );

DELETE FROM client_contacts
 WHERE client_id IN (
   '0cd69c8e-d74d-4f84-b624-9cf6fc88093e',
   '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c'
 );

UPDATE clients SET is_test = 1, updated_at = datetime('now')
 WHERE id = 'b1000001-0000-4000-8000-000000000001';

DELETE FROM clients
 WHERE id IN (
   '0cd69c8e-d74d-4f84-b624-9cf6fc88093e',
   '7c4a1f2e-8b3d-4e91-a5c6-2d8f9e1a3b4c'
 );

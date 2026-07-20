-- Session F Phase 2 — 05: Orphan / never-converted estimates
-- Estimates NOT referenced by jobs.estimate_id (Phase 1 inventory):
--   99004 02e2a571-a385-4560-8247-8cd658737c26  viewed
--   99006 aac09d23-fc50-4c69-99fa-b3d319be371a  revised (parent of 99007/99008)
--   99007 2c8cc959-e990-4323-b3d4-f770791ada10  draft
--   99009 76c83eee-66ae-463c-b7a7-a1292afc6834  draft
--   99010 a916c0dd-3ddf-47e8-add0-5b82a65d223e  sent cost_plus (parent of 99011)
--   99013 035b8c5e-f172-42b8-b479-a17f1e623666  viewed (parent of 99014)
--   99015 ed847b14-ed1f-4e72-85d6-f9f41e75301d  sent E2E
--   99016 b72f9055-173b-4c4e-94ad-46a12334b026  sent E2E
--   99017 af33dad6-e892-4746-9a8d-dcdbe90d7766  sent E2E
--   99018 590fdd26-9d04-494f-af51-2710f296b925  sent E2E
--   99019 b7c7ee48-cbf4-4c99-b89d-e2280f685a85  signed E2E
--
-- Also clears remaining estimate children (line items, schedules, selections)
-- and nulls revised_from_id on still-living converted estimates (99008/99011/99014).

-- ========== PREVIEW COUNTS ==========
SELECT 'orphan_estimates' AS tbl, COUNT(*) AS n FROM estimates
 WHERE id IN (
   '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
   '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
   'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
   'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
   'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
   'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
 );
SELECT 'payment_schedules' AS tbl, COUNT(*) AS n FROM payment_schedules
 WHERE estimate_id IN (
   '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
   '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
   'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
   'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
   'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
   'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
 );
SELECT 'selections' AS tbl, COUNT(*) AS n FROM selections
 WHERE estimate_id IN (
   '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
   '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
   'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
   'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
   'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
   'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
 );
SELECT 'estimate_line_items' AS tbl, COUNT(*) AS n FROM estimate_line_items
 WHERE estimate_id IN (
   '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
   '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
   'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
   'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
   'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
   'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
 );
SELECT 'estimate_sub_items' AS tbl, COUNT(*) AS n FROM estimate_sub_items
 WHERE parent_line_item_id IN (
   SELECT id FROM estimate_line_items WHERE estimate_id IN (
     '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
     '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
     'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
     'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
     'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
     'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
   )
 );
SELECT 'payments_on_orphan_estimates' AS tbl, COUNT(*) AS n FROM payments
 WHERE estimate_id IN (
   '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
   '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
   'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
   'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
   'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
   'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
 );

-- ========== DETACH revised_from on converted estimates that still exist ==========
UPDATE estimates SET revised_from_id = NULL
 WHERE revised_from_id IN (
   '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
   '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
   'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
   'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
   'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
   'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
 );

UPDATE selections SET chosen_choice_id = NULL
 WHERE estimate_id IN (
   '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
   '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
   'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
   'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
   'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
   'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
 );

UPDATE estimate_requests SET estimate_id = NULL
 WHERE estimate_id IN (
   '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
   '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
   'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
   'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
   'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
   'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
 );

-- ========== DELETE CHILDREN THEN ESTIMATES ==========
DELETE FROM payments
 WHERE estimate_id IN (
   '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
   '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
   'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
   'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
   'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
   'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
 );

DELETE FROM selection_choices
 WHERE selection_id IN (
   SELECT id FROM selections WHERE estimate_id IN (
     '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
     '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
     'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
     'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
     'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
     'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
   )
 );

DELETE FROM selections
 WHERE estimate_id IN (
   '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
   '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
   'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
   'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
   'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
   'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
 );

DELETE FROM payment_schedules
 WHERE estimate_id IN (
   '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
   '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
   'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
   'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
   'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
   'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
 );

DELETE FROM estimate_sub_items
 WHERE parent_line_item_id IN (
   SELECT id FROM estimate_line_items WHERE estimate_id IN (
     '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
     '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
     'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
     'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
     'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
     'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
   )
 );

-- Clear self-FK on line items before delete
UPDATE estimate_line_items SET blocked_by_line_item_id = NULL
 WHERE estimate_id IN (
   '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
   '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
   'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
   'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
   'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
   'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
 );

DELETE FROM estimate_line_items
 WHERE estimate_id IN (
   '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
   '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
   'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
   'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
   'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
   'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
 );

DELETE FROM files
 WHERE estimate_id IN (
   '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
   '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
   'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
   'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
   'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
   'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
 );

DELETE FROM estimates
 WHERE id IN (
   '02e2a571-a385-4560-8247-8cd658737c26','aac09d23-fc50-4c69-99fa-b3d319be371a',
   '2c8cc959-e990-4323-b3d4-f770791ada10','76c83eee-66ae-463c-b7a7-a1292afc6834',
   'a916c0dd-3ddf-47e8-add0-5b82a65d223e','035b8c5e-f172-42b8-b479-a17f1e623666',
   'ed847b14-ed1f-4e72-85d6-f9f41e75301d','b72f9055-173b-4c4e-94ad-46a12334b026',
   'af33dad6-e892-4746-9a8d-dcdbe90d7766','590fdd26-9d04-494f-af51-2710f296b925',
   'b7c7ee48-cbf4-4c99-b89d-e2280f685a85'
 )
 AND estimate_number IN (99004,99006,99007,99009,99010,99013,99015,99016,99017,99018,99019);

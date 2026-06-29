-- 0059_receipt_line_item_matching.sql — Sprint 30 Run 1
-- AI-extracted receipt line items + estimate line item match results.

ALTER TABLE receipt_photos ADD COLUMN extracted_items TEXT;

ALTER TABLE receipt_photos ADD COLUMN match_results TEXT;

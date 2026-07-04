-- Migration 0076: Receipt match learning — preserve original AI suggestion separately
-- from the final human-confirmed allocation so corrections become training signal.
--
-- ai_suggested_sub_item_id: set once at matching time, never overwritten.
-- matched_estimate_sub_item_id: updated at confirm time to reflect the human's final choice.
-- A correction exists wherever these two values differ.

ALTER TABLE expense_line_items ADD COLUMN ai_suggested_sub_item_id TEXT;

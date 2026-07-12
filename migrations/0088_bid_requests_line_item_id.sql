-- Tie bid requests to a parent estimate line item when created from the
-- Internal Cost Breakdown (even when no specific sub-item is selected).

ALTER TABLE bid_requests ADD COLUMN estimate_line_item_id TEXT REFERENCES estimate_line_items(id);

CREATE INDEX IF NOT EXISTS idx_bid_requests_line_item ON bid_requests(estimate_line_item_id);

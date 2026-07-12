-- Link schedule_entries back to the bid request that auto-assigned the sub.
-- Enables idempotent award/conversion sync (one schedule row per bid_request_id).

ALTER TABLE schedule_entries ADD COLUMN bid_request_id TEXT REFERENCES bid_requests(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_entries_bid_request
  ON schedule_entries(bid_request_id)
  WHERE bid_request_id IS NOT NULL;

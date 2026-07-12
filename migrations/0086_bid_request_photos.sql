-- Owner-attached reference photos on bid requests (estimate-side bid solicitation).
-- photos.bid_request_id follows the same direct-FK-per-context pattern as job_id,
-- estimate_request_id, task_id, daily_log_id.
-- photo_type = 'bid_request' for owner uploads; 'bid_attachment' remains for sub submissions.

ALTER TABLE photos ADD COLUMN bid_request_id TEXT REFERENCES bid_requests(id);

CREATE INDEX IF NOT EXISTS idx_photos_bid_request ON photos(bid_request_id);

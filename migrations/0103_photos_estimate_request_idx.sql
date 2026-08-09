-- Index for visit photos linked to estimate requests (Visit Capture).
-- Column estimate_request_id already exists from 0014_schema_bridge.sql.

CREATE INDEX IF NOT EXISTS idx_photos_estimate_request
  ON photos(estimate_request_id, is_active, taken_at);

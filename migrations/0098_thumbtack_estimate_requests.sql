-- Thumbtack webhook lead creation (Step 2)
--
-- 1) Extend estimate_requests.source CHECK to allow 'thumbtack'
--    (live CHECK: manual, inbound_sms, high_level, website_form)
-- 2) Add thumbtack_negotiation_id (idempotency) + thumbtack_raw_payload
--
-- Pattern: table rebuild (same as 0084 / 0097). Live row count was 0 at write time;
-- INSERT SELECT still copies any rows that may exist.

CREATE TABLE estimate_requests_new (
  id TEXT PRIMARY KEY,
  request_number INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN (
    'new_request','appointment_set','visit_done','building','sent','follow_up','won','lost'
  )),
  client_id TEXT NOT NULL REFERENCES clients(id),
  property_address TEXT NOT NULL,
  property_city TEXT NOT NULL,
  property_state TEXT NOT NULL DEFAULT 'Arkansas',
  property_zip TEXT NOT NULL,
  job_type TEXT NOT NULL,
  lead_source TEXT NOT NULL,
  lead_source_detail TEXT,
  high_level_opportunity_id TEXT,
  appointment_date TEXT,
  appointment_completed INTEGER DEFAULT 0,
  visit_notes TEXT,
  visit_photo_ids TEXT,
  estimate_id TEXT REFERENCES estimates(id),
  sent_date TEXT,
  follow_up_count INTEGER DEFAULT 0,
  last_follow_up_date TEXT,
  lost_reason TEXT,
  lost_notes TEXT,
  converted_job_id TEXT REFERENCES jobs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  appointment_time TEXT,
  lat REAL,
  lon REAL,
  last_sms_at TEXT,
  last_sms_preview TEXT,
  source TEXT DEFAULT 'manual'
    CHECK(source IN ('manual', 'inbound_sms', 'high_level', 'website_form', 'thumbtack')),
  follow_up_sequence_active INTEGER DEFAULT 0,
  follow_up_completed_at TEXT,
  proposal_review_date TEXT,
  lead_outreach_sequence_active INTEGER DEFAULT 0,
  lead_outreach_count INTEGER DEFAULT 0,
  last_outreach_date TEXT,
  lead_outreach_completed_at TEXT,
  scope_draft TEXT,
  sketches TEXT,
  property_id TEXT REFERENCES properties(id),
  thumbtack_negotiation_id TEXT UNIQUE,
  thumbtack_raw_payload TEXT
);

INSERT INTO estimate_requests_new (
  id, request_number, status, client_id,
  property_address, property_city, property_state, property_zip,
  job_type, lead_source, lead_source_detail, high_level_opportunity_id,
  appointment_date, appointment_completed, visit_notes, visit_photo_ids,
  estimate_id, sent_date, follow_up_count, last_follow_up_date,
  lost_reason, lost_notes, converted_job_id, created_at, updated_at, created_by,
  appointment_time, lat, lon, last_sms_at, last_sms_preview, source,
  follow_up_sequence_active, follow_up_completed_at, proposal_review_date,
  lead_outreach_sequence_active, lead_outreach_count, last_outreach_date,
  lead_outreach_completed_at, scope_draft, sketches, property_id,
  thumbtack_negotiation_id, thumbtack_raw_payload
)
SELECT
  id, request_number, status, client_id,
  property_address, property_city, property_state, property_zip,
  job_type, lead_source, lead_source_detail, high_level_opportunity_id,
  appointment_date, appointment_completed, visit_notes, visit_photo_ids,
  estimate_id, sent_date, follow_up_count, last_follow_up_date,
  lost_reason, lost_notes, converted_job_id, created_at, updated_at, created_by,
  appointment_time, lat, lon, last_sms_at, last_sms_preview, source,
  follow_up_sequence_active, follow_up_completed_at, proposal_review_date,
  lead_outreach_sequence_active, lead_outreach_count, last_outreach_date,
  lead_outreach_completed_at, scope_draft, sketches, property_id,
  NULL, NULL
FROM estimate_requests;

DROP TABLE estimate_requests;

ALTER TABLE estimate_requests_new RENAME TO estimate_requests;

CREATE INDEX IF NOT EXISTS idx_estimate_requests_status ON estimate_requests(status);
CREATE INDEX IF NOT EXISTS idx_estimate_requests_client_id ON estimate_requests(client_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_estimate_requests_thumbtack_negotiation_id
  ON estimate_requests(thumbtack_negotiation_id)
  WHERE thumbtack_negotiation_id IS NOT NULL;

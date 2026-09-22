-- Allow status='contacted' on estimate_requests and add contacted_at.
-- Same CHECK-rebuild as 0121: park notification_logs.estimate_request_id
-- (the only FK), defer_foreign_keys, rebuild, restore pointers.
-- contacted_at is added in the new table; a prior ALTER would be dropped.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE _er_notif_backup_0125 AS
  SELECT id, estimate_request_id
  FROM notification_logs
  WHERE estimate_request_id IS NOT NULL;

UPDATE notification_logs
SET estimate_request_id = NULL
WHERE estimate_request_id IS NOT NULL;

CREATE TABLE estimate_requests_new (
  id TEXT PRIMARY KEY,
  request_number INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN (
    'new_request','contacted','appointment_set','visit_done','building','sent','follow_up','won','lost'
  )),
  client_id TEXT,
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
  estimate_id TEXT,
  sent_date TEXT,
  follow_up_count INTEGER DEFAULT 0,
  last_follow_up_date TEXT,
  lost_reason TEXT,
  lost_notes TEXT,
  converted_job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  appointment_time TEXT,
  lat REAL,
  lon REAL,
  last_sms_at TEXT,
  last_sms_preview TEXT,
  source TEXT DEFAULT 'manual'
    CHECK(source IN ('manual', 'inbound_sms', 'high_level', 'website_form', 'thumbtack', 'google_lsa')),
  follow_up_sequence_active INTEGER DEFAULT 0,
  follow_up_completed_at TEXT,
  proposal_review_date TEXT,
  lead_outreach_sequence_active INTEGER DEFAULT 0,
  lead_outreach_count INTEGER DEFAULT 0,
  last_outreach_date TEXT,
  lead_outreach_completed_at TEXT,
  scope_draft TEXT,
  sketches TEXT,
  property_id TEXT,
  thumbtack_negotiation_id TEXT UNIQUE,
  thumbtack_raw_payload TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  job_type_detail TEXT,
  contacted_at TEXT
);

INSERT INTO estimate_requests_new (
  id, request_number, status, client_id,
  property_address, property_city, property_state, property_zip,
  job_type, lead_source, lead_source_detail, high_level_opportunity_id,
  appointment_date, appointment_completed, visit_notes, visit_photo_ids,
  estimate_id, sent_date, follow_up_count, last_follow_up_date,
  lost_reason, lost_notes, converted_job_id,
  created_at, updated_at, created_by,
  appointment_time, lat, lon, last_sms_at, last_sms_preview, source,
  follow_up_sequence_active, follow_up_completed_at, proposal_review_date,
  lead_outreach_sequence_active, lead_outreach_count, last_outreach_date,
  lead_outreach_completed_at, scope_draft, sketches, property_id,
  thumbtack_negotiation_id, thumbtack_raw_payload,
  contact_name, contact_phone, contact_email, job_type_detail,
  contacted_at
)
SELECT
  id, request_number, status, client_id,
  property_address, property_city, property_state, property_zip,
  job_type, lead_source, lead_source_detail, high_level_opportunity_id,
  appointment_date, appointment_completed, visit_notes, visit_photo_ids,
  estimate_id, sent_date, follow_up_count, last_follow_up_date,
  lost_reason, lost_notes, converted_job_id,
  created_at, updated_at, created_by,
  appointment_time, lat, lon, last_sms_at, last_sms_preview, source,
  follow_up_sequence_active, follow_up_completed_at, proposal_review_date,
  lead_outreach_sequence_active, lead_outreach_count, last_outreach_date,
  lead_outreach_completed_at, scope_draft, sketches, property_id,
  thumbtack_negotiation_id, thumbtack_raw_payload,
  contact_name, contact_phone, contact_email, job_type_detail,
  NULL
FROM estimate_requests;

DROP TABLE estimate_requests;
ALTER TABLE estimate_requests_new RENAME TO estimate_requests;

UPDATE notification_logs
SET estimate_request_id = (
  SELECT b.estimate_request_id FROM _er_notif_backup_0125 b WHERE b.id = notification_logs.id
)
WHERE id IN (SELECT id FROM _er_notif_backup_0125);

DROP TABLE _er_notif_backup_0125;

CREATE INDEX IF NOT EXISTS idx_estimate_requests_status ON estimate_requests(status);
CREATE INDEX IF NOT EXISTS idx_estimate_requests_client_id ON estimate_requests(client_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_estimate_requests_thumbtack_negotiation_id
  ON estimate_requests(thumbtack_negotiation_id)
  WHERE thumbtack_negotiation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_estimate_requests_hl_opportunity_id
  ON estimate_requests(high_level_opportunity_id)
  WHERE high_level_opportunity_id IS NOT NULL;

PRAGMA defer_foreign_keys = OFF;

-- Sprint 39 Run 1: Subcontractor Onboarding Packet (Document Collection)
--
-- Lets Tony send a no-login secure link to a sub for collecting W-9,
-- GL COI, WC COI (or exemption), and license documents. Tony then reviews
-- and approves, which populates the real subcontractors fields.
--
-- Two new tables. No existing tables modified (subcontractors fields already
-- added in Sprint 38 Run 1).

CREATE TABLE IF NOT EXISTS subcontractor_packets (
  id                          TEXT PRIMARY KEY,
  sub_id                      TEXT NOT NULL REFERENCES subcontractors(id),
  portal_token                TEXT NOT NULL UNIQUE,
  status                      TEXT NOT NULL DEFAULT 'sent'
                                CHECK(status IN ('sent','in_progress','submitted','approved')),
  workers_comp_exempt         INTEGER NOT NULL DEFAULT 0,
  workers_comp_exemption_reason TEXT,
  sent_at                     TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at                TEXT,
  approved_at                 TEXT,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subcontractor_packet_documents (
  id              TEXT PRIMARY KEY,
  packet_id       TEXT NOT NULL REFERENCES subcontractor_packets(id),
  document_type   TEXT NOT NULL CHECK(document_type IN ('w9','coi_general_liability','coi_workers_comp','license')),
  document_id     TEXT REFERENCES documents(id),
  expiration_date TEXT,
  uploaded_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Notification template: owner in-app when a sub submits a completed packet
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, created_at, updated_at)
VALUES
  ('nt-packet-submitted', 'packet_submitted', 'Sub Onboarding Packet Submitted', 'owner', 'in_app', NULL,
   'CHS: {{sub_name}} submitted their onboarding packet. Review and approve in the Subcontractors section.',
   '["sub_name"]', 1, datetime('now'), datetime('now'));

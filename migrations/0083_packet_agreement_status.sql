-- Sprint 39 Run 2: Subcontractor Agreement E-Signature.
--
-- Extends subcontractor_packets.status CHECK constraint to include
-- 'awaiting_signature' and 'signed', and adds two new columns:
--   signed_at             TEXT  — timestamp when sub completed the agreement signature
--   agreement_document_id TEXT  — FK to documents row tracking the BoldSign agreement
--
-- SQLite doesn't support modifying CHECK constraints via ALTER TABLE.
-- The table must be rebuilt. This is safe: the table had zero rows at
-- migration time (confirmed via SELECT COUNT(*) = 0 before running).
--
-- Pattern follows migrations/0044_warranty_calendar.sql.

CREATE TABLE subcontractor_packets_new (
  id                            TEXT PRIMARY KEY,
  sub_id                        TEXT NOT NULL REFERENCES subcontractors(id),
  portal_token                  TEXT NOT NULL UNIQUE,
  status                        TEXT NOT NULL DEFAULT 'sent'
                                  CHECK(status IN ('sent','in_progress','submitted','approved','awaiting_signature','signed')),
  workers_comp_exempt           INTEGER NOT NULL DEFAULT 0,
  workers_comp_exemption_reason TEXT,
  sent_at                       TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at                  TEXT,
  approved_at                   TEXT,
  signed_at                     TEXT,
  agreement_document_id         TEXT REFERENCES documents(id),
  created_at                    TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO subcontractor_packets_new
  (id, sub_id, portal_token, status, workers_comp_exempt, workers_comp_exemption_reason,
   sent_at, submitted_at, approved_at, created_at)
SELECT
  id, sub_id, portal_token, status, workers_comp_exempt, workers_comp_exemption_reason,
  sent_at, submitted_at, approved_at, created_at
FROM subcontractor_packets;

DROP TABLE subcontractor_packets;

ALTER TABLE subcontractor_packets_new RENAME TO subcontractor_packets;

-- Sprint 38 Run 4: Selections & Allowances
--
-- Lets Tony present material/finish choices to a client with a dollar
-- allowance tied to each. Client approves via BoldSign e-signature through
-- the portal. Overage flows into job.contract_total the same way a
-- change-order does.
--
-- Two new tables. No existing tables modified.

CREATE TABLE IF NOT EXISTS selections (
  id                      TEXT PRIMARY KEY,
  estimate_id             TEXT REFERENCES estimates(id),
  job_id                  TEXT REFERENCES jobs(id),
  estimate_sub_item_id    TEXT REFERENCES estimate_sub_items(id),
  title                   TEXT NOT NULL,
  category                TEXT,
  location                TEXT,
  allowance_amount        REAL NOT NULL,
  is_shared_allowance     INTEGER NOT NULL DEFAULT 0,
  shared_allowance_group_id TEXT,
  required                INTEGER NOT NULL DEFAULT 1,
  deadline_date           TEXT,
  public_instructions     TEXT,
  internal_notes          TEXT,
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK(status IN ('pending','sent','approved')),
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS selection_choices (
  id                          TEXT PRIMARY KEY,
  selection_id                TEXT NOT NULL REFERENCES selections(id),
  title                       TEXT NOT NULL,
  description                 TEXT,
  price                       REAL NOT NULL,
  photo_ids                   TEXT,
  vendor_name                 TEXT,
  is_client_added             INTEGER NOT NULL DEFAULT 0,
  approved                    INTEGER NOT NULL DEFAULT 0,
  approved_at                 TEXT,
  client_signature_document_id TEXT REFERENCES documents(id),
  created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Notification template: owner in-app when a client approves a selection
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, created_at, updated_at)
VALUES
  ('nt-selection-approved', 'selection_approved', 'Selection Approved by Client', 'owner', 'in_app', NULL,
   'CHS: {{client_name}} approved "{{choice_title}}" for {{selection_title}} (${{price}}).',
   '["client_name","choice_title","selection_title","price"]', 1, datetime('now'), datetime('now'));

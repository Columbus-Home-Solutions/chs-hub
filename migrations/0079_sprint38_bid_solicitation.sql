-- Sprint 38 Run 3: Multi-Vendor Bid Solicitation
--
-- Price discovery system: solicit quotes from multiple subs for a scope,
-- compare side-by-side, award to a winner, flow the price into
-- vendor_materials and the estimate/job budget.
--
-- Three new tables. No existing tables are modified.

CREATE TABLE IF NOT EXISTS bid_requests (
  id                    TEXT PRIMARY KEY,
  estimate_id           TEXT REFERENCES estimates(id),
  job_id                TEXT REFERENCES jobs(id),
  estimate_sub_item_id  TEXT REFERENCES estimate_sub_items(id),
  title                 TEXT NOT NULL,
  scope_description     TEXT NOT NULL,
  quantities_notes      TEXT,
  needed_by_date        TEXT,
  status                TEXT NOT NULL DEFAULT 'open'
                          CHECK(status IN ('open','awarded','cancelled')),
  bid_mode              TEXT NOT NULL DEFAULT 'sealed'
                          CHECK(bid_mode IN ('sealed','open')),
  notify_losers         INTEGER NOT NULL DEFAULT 1,
  awarded_sub_id        TEXT REFERENCES subcontractors(id),
  awarded_bid_id        TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bid_request_recipients (
  id              TEXT PRIMARY KEY,
  bid_request_id  TEXT NOT NULL REFERENCES bid_requests(id),
  sub_id          TEXT NOT NULL REFERENCES subcontractors(id),
  portal_token    TEXT NOT NULL UNIQUE,
  sent_at         TEXT,
  viewed_at       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bid_submissions (
  id               TEXT PRIMARY KEY,
  bid_request_id   TEXT NOT NULL REFERENCES bid_requests(id),
  sub_id           TEXT NOT NULL REFERENCES subcontractors(id),
  price            REAL NOT NULL,
  notes            TEXT,
  attachment_photo_id TEXT REFERENCES photos(id),
  status           TEXT NOT NULL DEFAULT 'submitted'
                     CHECK(status IN ('submitted','won','lost')),
  submitted_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Notification template: owner in-app alert when a sub submits a bid ──────
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, created_at, updated_at)
VALUES
  ('nt-bid-received', 'bid_received', 'Bid Received', 'owner', 'in_app', NULL,
   'CHS: {{sub_name}} submitted a bid of ${{price}} for "{{scope_title}}".',
   '["sub_name","price","scope_title"]', 1, datetime('now'), datetime('now'));

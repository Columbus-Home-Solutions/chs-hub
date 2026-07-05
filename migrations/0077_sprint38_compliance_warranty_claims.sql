-- Sprint 38 Run 1: Sub Compliance Tracking + Client-Submitted Warranty Claims
--
-- Part A: Add expiration date columns to subcontractors for COI and license.
-- Part B: Add submitted_by + viewed_by_owner to warranties for client claim path.
-- Notification templates for owner alerts (in_app channel, matches existing portal pattern).

-- ── Part A: Sub compliance expiration dates ────────────────────────────────────
ALTER TABLE subcontractors ADD COLUMN coi_expiration_date TEXT;
ALTER TABLE subcontractors ADD COLUMN license_expiration_date TEXT;

-- ── Part B: Client-submitted warranty claims ──────────────────────────────────
ALTER TABLE warranties ADD COLUMN submitted_by TEXT NOT NULL DEFAULT 'owner'
  CHECK(submitted_by IN ('owner', 'client'));
ALTER TABLE warranties ADD COLUMN viewed_by_owner INTEGER NOT NULL DEFAULT 0;

-- ── Notification templates ────────────────────────────────────────────────────
-- sub_coi_expiring: owner alert when a sub's COI is 30/15/0 days from expiry
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, created_at, updated_at)
VALUES
  ('nt-sub-coi-expiring', 'sub_coi_expiring', 'Sub COI Expiring', 'owner', 'in_app', NULL,
   'CHS: COI for {{sub_name}} expires in {{days_until}} day(s) on {{expiration_date}}. Update on file before it lapses.',
   '["sub_name","days_until","expiration_date"]', 1, datetime('now'), datetime('now'));

-- sub_license_expiring: owner alert when a sub's license is 30/15/0 days from expiry
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, created_at, updated_at)
VALUES
  ('nt-sub-license-expiring', 'sub_license_expiring', 'Sub License Expiring', 'owner', 'in_app', NULL,
   'CHS: License for {{sub_name}} expires in {{days_until}} day(s) on {{expiration_date}}. Update on file before it lapses.',
   '["sub_name","days_until","expiration_date"]', 1, datetime('now'), datetime('now'));

-- warranty_claim_submitted: owner alert when a client submits a warranty claim via portal
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, created_at, updated_at)
VALUES
  ('nt-warranty-claim-submitted', 'warranty_claim_submitted', 'Warranty Claim Submitted by Client', 'owner', 'in_app', NULL,
   'CHS: {{client_name}} submitted a warranty claim for {{job_title}}: "{{description}}"',
   '["client_name","job_title","description"]', 1, datetime('now'), datetime('now'));

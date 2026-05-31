-- 0030_notifications.sql
-- Sprint 7 — Notification Engine & Communications: the genuinely-missing
-- engine columns. The notification tables already exist
-- (0020_notification_tables.sql) and the full 26-row catalog was already seeded
-- (0024_seed_data.sql) — confirmed by PRAGMA + COUNT(*)=26 before writing this.
-- So this migration ADDS ONLY the scheduling / retry / in-app / dedupe columns
-- the engine needs, plus clients.notification_preferences (the spec §4.4 says
-- preferences live on both users and clients; only users had it).
--
-- One ALTER per statement; additive only (SQLite ALTER cannot add NOT NULL
-- without a constant default, and never DROPs). Applied once via
--   npx wrangler d1 execute chs-hub-db --local --file=migrations/0030_notifications.sql
-- (NOT `migrations apply` — the local d1_migrations tracker is out of sync with
-- the directly-executed 0020–0029, so an apply would try to re-run those and
-- fail on already-existing columns).
--
-- The status CHECK on notification_logs ('queued','sent','delivered','failed',
-- 'bounced') already covers every state the engine uses, so it is NOT touched:
--   queued    → enqueued, scheduled_for set, not yet dispatched
--   sent      → dispatched (real send) OR simulated/push-noop (see external_id)
--   delivered → Twilio/Resend status callback confirmed delivery
--   failed    → exhausted retries (escalated to dead_letter_queue)
--   bounced   → email bounce reported by the provider

-- ── notification_logs: scheduling ───────────────────────────────────────────
-- When a queued row becomes due. Immediate sends set it to enqueue-time; delayed
-- sends (appointment reminder 24h before, work_starting 6 PM the night before,
-- quote follow-ups Day 3/5/7) set it to the future. The */15 cron sends rows
-- where status='queued' AND scheduled_for <= now.
ALTER TABLE notification_logs ADD COLUMN scheduled_for TEXT;

-- ── notification_logs: first-class retry (chosen mechanism) ─────────────────
-- Retries are first-class ON THE LOG ROW (retry_count + next_retry_at) with
-- exponential backoff (1m / 5m / 30m). The shared dead_letter_queue is reserved
-- for TRUE dead letters: only after max retries is a row escalated there, so the
-- DLQ viewer keeps showing genuine dead letters and not transient blips.
ALTER TABLE notification_logs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_logs ADD COLUMN next_retry_at TEXT;

-- ── notification_logs: in-app delivery (decision (d): reuse, no 2nd table) ──
-- in_app rows are just notification_logs rows with channel='in_app',
-- recipient_user_id set, and is_read/read_at tracked. One log, one timeline —
-- the inbox endpoints key off these. No separate in_app_notifications table.
ALTER TABLE notification_logs ADD COLUMN recipient_user_id TEXT;
ALTER TABLE notification_logs ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_logs ADD COLUMN read_at TEXT;
-- Optional deep-link target for the bell ("open the related record"): an app
-- path like /app/jobs/<id> or /app/estimating/<id>. Nullable.
ALTER TABLE notification_logs ADD COLUMN link_path TEXT;

-- ── notification_logs: idempotency / no-double-send key ─────────────────────
-- Deterministic dedupe value = trigger_event + target-entity id + channel +
-- logical-instance key (e.g. follow_up_1, or the appointment_date). Enqueue
-- checks-before-insert AND a UNIQUE index backstops the race (webhook
-- redelivery, a status save that re-runs): a duplicate enqueue hits the index
-- and is swallowed by INSERT OR IGNORE, so a real client never gets the same
-- message twice. NULL dedupe_key (manual/legacy rows) is exempt — SQLite allows
-- many NULLs under a UNIQUE index.
ALTER TABLE notification_logs ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_logs_dedupe
  ON notification_logs(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Cron drain index: find due queued rows fast.
CREATE INDEX IF NOT EXISTS idx_notification_logs_due
  ON notification_logs(status, scheduled_for);
-- Inbox index: a user's unread in_app rows.
CREATE INDEX IF NOT EXISTS idx_notification_logs_inbox
  ON notification_logs(recipient_user_id, is_read, created_at);
-- Status-callback lookup by provider id (Twilio SID / Resend id).
CREATE INDEX IF NOT EXISTS idx_notification_logs_external
  ON notification_logs(external_id);

-- ── system_alert template (owner in-app bell) ──────────────────────────────
-- notification_logs.template_id is NOT NULL + FK to notification_templates, but
-- engine-generated owner alerts (inbound SMS surfaced to the bell, a send that
-- dead-lettered after 3 retries) don't originate from a catalog row. This one
-- generic internal in_app template gives those alerts a valid template_id and a
-- single {{message}} body. Idempotent insert; phase='system' keeps it out of
-- the client-facing template editor groups.
INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, subject, body_template, merge_fields, is_active, delay_minutes, phase, sort_order, created_at, updated_at)
VALUES
  ('tmpl-system-alert', 'system_alert', 'System Alert (in-app)', 'owner', 'in_app', NULL,
   '{{message}}', '["message"]', 1, 0, 'system', 999, datetime('now'), datetime('now'));

-- ── clients.notification_preferences (spec §4.4 / opt-out rule §6.3) ────────
-- JSON blob, NULL = all enabled (default). Only opt-out-eligible
-- (marketing/informational) notifications consult this; transactional ones
-- (deposit/estimate delivery) ignore it (§6.2). Shape mirrors
-- users.notification_preferences: e.g. {"sms":true,"email":true,
-- "marketing":false}.
ALTER TABLE clients ADD COLUMN notification_preferences TEXT;

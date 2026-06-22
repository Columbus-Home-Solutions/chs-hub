-- Sprint 24: SMS opt-out flag on clients + twilio_sid on communications + thread index
-- Run via: npx wrangler d1 execute chs-hub-db --remote --file=scripts/migrations/sprint-24-00-sms-opt-out-flag.sql
-- D1 rules: no BEGIN/COMMIT, no PRAGMA, no NOT NULL without DEFAULT

-- Add dedicated SMS opt-out columns to clients.
-- sms_opt_out is the authoritative flag (replaces the notification_preferences JSON approach).
ALTER TABLE clients ADD COLUMN sms_opt_out INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN sms_opt_out_at TEXT;

-- Add twilio_sid to communications for outbound message SID tracking (Sprint 25 delivery receipts).
ALTER TABLE communications ADD COLUMN twilio_sid TEXT;

-- Performance index for thread queries (filter by client + channel, ordered by time).
CREATE INDEX IF NOT EXISTS idx_communications_client_channel
  ON communications(client_id, channel, created_at);

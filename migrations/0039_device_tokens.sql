-- 0039_device_tokens.sql  (additive — new table only) — Sprint 18
-- Push device registration store. notifications.channel already supports 'push'
-- and users.notification_preferences already carries a 'push' key (S7 + S17),
-- but there was NO place to map a user → their registered device token(s). A
-- user can have multiple devices, so this is a child table keyed UNIQUE on the
-- token (re-registering the same token from the same device is an idempotent
-- upsert, never a duplicate row).
--
-- This is the ONLY schema change in Sprint 18. Photo annotations / before-after
-- pairing / photo reports / project packet are pure code over EXISTING columns
-- (photos.is_annotated, photos.annotation_data, photos.before_after_pair_id from
-- 0031; documents.document_category is free-text so 'photo_report' needs no DDL).
--
-- Conventions matched to the neighboring tables (documents / users): TEXT UUID
-- primary key, created_at TEXT DEFAULT (datetime('now')).
--
-- DO NOT run `wrangler d1 migrations apply` (ledger only records 0001–0013;
-- 0014+ are applied-but-unrecorded). Direct-execute this file:
--   npx wrangler d1 execute chs-hub-db --local --file=migrations/0039_device_tokens.sql
--   (remote: add --remote, backup-first, per the remote-deploy runbook)

CREATE TABLE IF NOT EXISTS device_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  platform      TEXT NOT NULL CHECK (platform IN ('ios','android','web')),
  token         TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT
);

-- One row per physical token; the registration endpoint upserts on this.
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_tokens_token ON device_tokens(token);
-- Dispatcher lookup: a user's active devices.
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id, is_active);

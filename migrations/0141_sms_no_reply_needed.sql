-- Per-conversation "No reply needed". Silences inbound SMS that are already
-- waiting, without sending a message or deleting anything. A later inbound
-- (created_at after this timestamp) counts as unread again.
ALTER TABLE sms_conversation_state ADD COLUMN no_reply_needed_at TEXT;

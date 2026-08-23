-- Attachment metadata for inbound quote emails (every attachment seen, not only extractable).
ALTER TABLE pending_quote_imports ADD COLUMN attachments TEXT;

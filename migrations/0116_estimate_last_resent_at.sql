-- Manual "Resend Estimate" audit stamp — does not affect status / viewed / signed.
ALTER TABLE estimates ADD COLUMN last_resent_at TEXT;

-- Add error_message column to client_lien_waivers so BoldSign send failures are
-- diagnosable from the database without needing a live wrangler tail session.
ALTER TABLE client_lien_waivers ADD COLUMN error_message TEXT;

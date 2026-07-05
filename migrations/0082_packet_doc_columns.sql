-- Fix overloaded expiration_date field in subcontractor_packet_documents.
-- Adds two dedicated columns so each column holds exactly one kind of value.
--
-- After this migration:
--   captured_tax_id          TEXT  — W-9 only: EIN or SSN entered by the sub
--   captured_license_number  TEXT  — license only: contractor license number
--   expiration_date          TEXT  — real date (YYYY-MM-DD) or NULL; never
--                                    stores EIN, license numbers, or pipe-delimited values
--
-- No backfill needed — table was empty at migration time (confirmed by
-- SELECT COUNT(*) = 0 before running this migration).

ALTER TABLE subcontractor_packet_documents ADD COLUMN captured_tax_id TEXT;
ALTER TABLE subcontractor_packet_documents ADD COLUMN captured_license_number TEXT;

-- Add optional geocoordinate columns to estimate_requests and jobs
-- Populated at address entry time via Google Places autocomplete
-- Nullable — existing records without coordinates are valid

ALTER TABLE estimate_requests ADD COLUMN lat REAL;
ALTER TABLE estimate_requests ADD COLUMN lon REAL;

ALTER TABLE jobs ADD COLUMN lat REAL;
ALTER TABLE jobs ADD COLUMN lon REAL;

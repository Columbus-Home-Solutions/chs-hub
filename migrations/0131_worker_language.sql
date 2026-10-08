-- Day-rate check-in language. Existing workers stay English until someone switches.
ALTER TABLE subcontractors ADD COLUMN preferred_language TEXT NOT NULL DEFAULT 'en'
  CHECK (preferred_language IN ('en', 'es'));

-- Free-text detail when job_type = 'other', so internal labels can show
-- something useful instead of the literal word "other".
ALTER TABLE estimate_requests ADD COLUMN job_type_detail TEXT;
ALTER TABLE jobs ADD COLUMN job_type_detail TEXT;

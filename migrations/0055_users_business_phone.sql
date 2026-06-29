-- Client-facing PM / document contact number (distinct from users.phone personal cell).
--
-- Schema-already-exists guard (run before applying remotely):
--   SELECT name FROM pragma_table_info('users') WHERE name='business_phone';
-- Empty result = safe to apply. Row returned = already applied, skip.

ALTER TABLE users ADD COLUMN business_phone TEXT;

-- PM assignment on jobs — nullable FK to users.id (separate from created_by).
--
-- Schema-already-exists guard (run before applying remotely):
--   SELECT name FROM pragma_table_info('jobs') WHERE name='assigned_to';
-- Empty result = safe to apply. Row returned = already applied, skip.

ALTER TABLE jobs ADD COLUMN assigned_to TEXT REFERENCES users(id);

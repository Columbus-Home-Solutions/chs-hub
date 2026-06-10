-- migration 0050: internal resources settings (owner-managed link list)

INSERT OR REPLACE INTO system_settings (key, value, value_type, category, label, description) VALUES
  ('internal_drive_url', '', 'string', 'internal', 'Internal Google Drive URL', 'URL to the company Google Drive shared folder'),
  ('internal_resource_links', '[]', 'json', 'internal', 'Internal Resource Links', 'JSON array of {id, label, url} custom resource links');

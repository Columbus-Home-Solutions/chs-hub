-- Visit Capture layout on Estimate Request Detail (phone/tablet).
-- redesigned = hero tiles + Record modal + collapsed request details
-- legacy     = original stacked cards layout
-- Desktop always uses legacy regardless of this setting.
INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
VALUES (
  'visit_capture_layout',
  'redesigned',
  'string',
  'mobile',
  'Visit Capture layout',
  'Phone/tablet Estimate Request layout: redesigned (hero Visit Capture) or legacy (original cards). Desktop is always legacy. Switch anytime — no redeploy needed.',
  datetime('now')
)
ON CONFLICT(key) DO NOTHING;

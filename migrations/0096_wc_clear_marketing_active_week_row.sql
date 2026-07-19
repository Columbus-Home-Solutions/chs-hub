-- 0096_wc_clear_marketing_active_week_row.sql
-- Automatic week-row discovery/creation replaces the manual row fallback.
DELETE FROM system_settings WHERE key = 'wc_marketing_active_week_row';

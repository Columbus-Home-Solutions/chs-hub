-- Customer self-scheduling from lead outreach.
-- Tokens and booking source live on the estimate request. Availability rules
-- are system_settings (category scheduling). No new appointment table.
--
-- Does not change existing outreach template text. Tony adds {{booking_link}}
-- in Settings when he is ready. The master switch ships off.

ALTER TABLE estimate_requests ADD COLUMN booking_token TEXT;
ALTER TABLE estimate_requests ADD COLUMN booking_token_expires_at TEXT;
ALTER TABLE estimate_requests ADD COLUMN booking_source TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_estimate_requests_booking_token
  ON estimate_requests(booking_token);

INSERT OR IGNORE INTO system_settings (key, value, value_type, category, label, description) VALUES
  ('scheduling_enabled', '0', 'string', 'scheduling', 'Customer self-scheduling',
   'Off until turned on. Outreach texts omit the booking link while this is off.'),
  ('scheduling_days', '1,2,3,4,5,6', 'string', 'scheduling', 'Days available',
   '0=Sunday through 6=Saturday. Default Monday–Saturday.'),
  ('scheduling_start', '08:00', 'string', 'scheduling', 'Day starts',
   'Earliest estimate visit, America/Chicago, 24-hour HH:MM.'),
  ('scheduling_end', '17:00', 'string', 'scheduling', 'Day ends',
   'Latest a visit may finish, America/Chicago, 24-hour HH:MM.'),
  ('scheduling_visit_minutes', '60', 'string', 'scheduling', 'Visit length',
   'Minutes on site.'),
  ('scheduling_buffer_minutes', '30', 'string', 'scheduling', 'Travel buffer',
   'Minutes blocked before and after every busy event.'),
  ('scheduling_min_notice_hours', '4', 'string', 'scheduling', 'Minimum notice',
   'Hours from now before the first offered slot.'),
  ('scheduling_horizon_days', '14', 'string', 'scheduling', 'How far ahead',
   'Days into the future a customer may book.'),
  ('scheduling_max_per_day', '2', 'string', 'scheduling', 'Max self-booked visits per day',
   'Cap on customer-booked estimate visits. Does not count visits Tony sets himself.'),
  ('scheduling_slot_minutes', '30', 'string', 'scheduling', 'Slot increment',
   'Minutes between offered start times.'),
  ('scheduling_blocked_dates', '', 'string', 'scheduling', 'Blocked dates',
   'Comma-separated YYYY-MM-DD days with no slots.');

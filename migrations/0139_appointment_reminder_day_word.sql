-- The reminder day word is filled from the visit. "today" is no longer typed
-- into the sentence. Apply this after the reminder code is deployed, in the
-- same window. Do not apply it first: the token would be blank until the code
-- sends appointment_day.
--
-- Backup, run before the UPDATE:
--   SELECT id, body_template, merge_fields, is_active, updated_at
--     FROM notification_templates
--    WHERE id = 'nt-appointment-reminder-sms';
--
-- Rollback, using the body from that backup:
--   UPDATE notification_templates
--      SET body_template = '<paste the backed-up body_template>',
--          merge_fields = '["appointment_time","property_address"]',
--          updated_at = datetime('now')
--    WHERE id = 'nt-appointment-reminder-sms'
--      AND trigger_event = 'appointment_reminder';

UPDATE notification_templates
   SET body_template = 'Hey {{client_first_name}}, just a reminder — Tony from Columbus Home Solutions is looking forward to meeting with you {{appointment_day}} at {{appointment_time}}! See you soon. 👋',
       merge_fields = '["appointment_day","appointment_time","property_address"]',
       updated_at = datetime('now')
 WHERE id = 'nt-appointment-reminder-sms'
   AND trigger_event = 'appointment_reminder'
   AND channel = 'sms';

-- Sprint 33: punch list + voice note notification templates

INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, body_template,
   merge_fields, is_active, phase, sort_order, created_at, updated_at)
VALUES (
  lower(hex(randomblob(16))), 'punch_list_sent', 'Punch List Sent', 'internal', 'in_app',
  'Punch list sent to subs for {{job_title}}',
  '["job_title"]', 1, 'job', 20, datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, body_template,
   merge_fields, is_active, phase, sort_order, created_at, updated_at)
VALUES (
  lower(hex(randomblob(16))), 'punch_list_item_done', 'Punch List Item Completed',
  'internal', 'in_app',
  '{{sub_name}} completed {{item_count}} item(s) on {{job_title}} punch list',
  '["sub_name","item_count","job_title"]', 1, 'job', 21, datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, body_template,
   merge_fields, is_active, phase, sort_order, created_at, updated_at)
VALUES (
  lower(hex(randomblob(16))), 'punch_list_complete', 'Punch List Complete',
  'internal', 'in_app',
  'All punch list items complete for {{job_title}} — ready to close out',
  '["job_title"]', 1, 'job', 22, datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO notification_templates
  (id, trigger_event, name, recipient_type, channel, body_template,
   merge_fields, is_active, phase, sort_order, created_at, updated_at)
VALUES (
  lower(hex(randomblob(16))), 'voice_note_unmatched', 'Voice Note Needs Assignment',
  'internal', 'in_app',
  'New voice note needs job assignment',
  '[]', 1, 'job', 23, datetime('now'), datetime('now')
);

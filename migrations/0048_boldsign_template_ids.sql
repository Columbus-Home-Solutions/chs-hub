-- migration 0048: store BoldSign template IDs in system_settings
-- These IDs reference templates created in the BoldSign dashboard where
-- signature/date field positions are set via drag-and-drop.
-- The send-for-signature route reads these and falls back to hardcoded IDs.

INSERT OR REPLACE INTO system_settings (key, value, value_type, category, label, description) VALUES
  ('boldsign_template_id_service_agreement',             '1578f4a8-a7af-4792-b091-6dc2520397a4', 'string', 'esignature', 'BoldSign Template: Service Agreement',             'BoldSign template ID for Service Agreement e-signature'),
  ('boldsign_template_id_cost_plus_agreement',           '6e28b9a4-af85-4c1b-a68d-ffb33af9b736', 'string', 'esignature', 'BoldSign Template: Cost-Plus Agreement',           'BoldSign template ID for Cost-Plus Agreement e-signature'),
  ('boldsign_template_id_change_order',                  '3fe5a120-b44e-4c60-8254-28259de7d44e', 'string', 'esignature', 'BoldSign Template: Change Order',                  'BoldSign template ID for Change Order e-signature'),
  ('boldsign_template_id_lien_waiver_conditional',       '7d6692c2-21e9-4ae9-ba2a-7f45c1f33eba', 'string', 'esignature', 'BoldSign Template: Conditional Lien Waiver',       'BoldSign template ID for Conditional Lien Waiver e-signature'),
  ('boldsign_template_id_lien_waiver_sub_unconditional', '82223390-cff1-4f2e-9320-22dee1e4d0f7', 'string', 'esignature', 'BoldSign Template: Sub Unconditional Lien Waiver', 'BoldSign template ID for Sub Unconditional Lien Waiver e-signature'),
  ('boldsign_template_id_warranty_certificate',          'cea0d213-836a-4f3b-84f8-6be2f348d918', 'string', 'esignature', 'BoldSign Template: Warranty Certificate',          'BoldSign template ID for Warranty Certificate e-signature');

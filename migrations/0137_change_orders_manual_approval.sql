-- Owner-recorded off-platform change order approval.
-- NULL approval_source means a portal e-signature (existing rows).
-- No CHECK, no DROP, no table rebuild.

ALTER TABLE change_orders ADD COLUMN approval_source TEXT;
ALTER TABLE change_orders ADD COLUMN manual_approval_method TEXT;
ALTER TABLE change_orders ADD COLUMN manual_approved_at TEXT;
ALTER TABLE change_orders ADD COLUMN manual_approval_note TEXT;
ALTER TABLE change_orders ADD COLUMN manual_approved_by TEXT;
ALTER TABLE change_orders ADD COLUMN manual_recorded_at TEXT;
ALTER TABLE change_orders ADD COLUMN manual_proof_r2_key TEXT;

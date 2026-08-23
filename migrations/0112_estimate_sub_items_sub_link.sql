-- Link a sub-item to a real subcontractors/labor row (planned vendor at estimate time).
ALTER TABLE estimate_sub_items ADD COLUMN sub_id TEXT REFERENCES subcontractors(id);

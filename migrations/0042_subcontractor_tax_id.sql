-- Migration 0042: Add tax_id to subcontractors
ALTER TABLE subcontractors ADD COLUMN tax_id TEXT;

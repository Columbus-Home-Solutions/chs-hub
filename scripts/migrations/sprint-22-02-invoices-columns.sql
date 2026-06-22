ALTER TABLE invoices ADD COLUMN line_item_ids TEXT;

ALTER TABLE invoices ADD COLUMN payer_id TEXT REFERENCES payers(id);

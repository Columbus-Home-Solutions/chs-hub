-- Forward-looking hold for native invoices, plus Jobber number labels.
-- Jobber history is excluded from late fees and reminders by id prefix and
-- data_source (no column). billing_hold is for non-Jobber invoices Tony
-- wants left alone. Jobber numbers are labels; they are not jobs.job_number.
ALTER TABLE invoices ADD COLUMN billing_hold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN jobber_job_number INTEGER;
ALTER TABLE invoices ADD COLUMN jobber_invoice_number INTEGER;

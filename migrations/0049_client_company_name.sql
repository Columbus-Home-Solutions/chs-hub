-- migration 0049: optional company name on clients

ALTER TABLE clients ADD COLUMN company_name TEXT;

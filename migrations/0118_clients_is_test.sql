-- Flag fixture / regression clients so dashboards, KPIs, pipelines, and reports
-- can exclude them while keeping direct URL/detail access.

ALTER TABLE clients ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_clients_is_test ON clients(is_test);

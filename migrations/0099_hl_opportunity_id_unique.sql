-- HighLevel → CHS lead mirror: unique index on high_level_opportunity_id
-- so the one-time mirror cannot double-insert the same HL opportunity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_estimate_requests_hl_opportunity_id
  ON estimate_requests(high_level_opportunity_id)
  WHERE high_level_opportunity_id IS NOT NULL;

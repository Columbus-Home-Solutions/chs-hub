-- 0023_views.sql
-- Sprint 1 — Computed views (Section 12 of CHS-Database-Schema.md).
-- CREATE VIEW IF NOT EXISTS for idempotency.

-- Job financial summary (replaces computed fields on jobs table)
CREATE VIEW IF NOT EXISTS v_job_financials AS
SELECT
  j.id AS job_id,
  COALESCE(SUM(CASE WHEN i.status != 'void' THEN i.amount END), 0) AS total_invoiced,
  COALESCE(SUM(p.amount), 0) AS total_paid,
  COALESCE(SUM(e.amount), 0) AS total_expenses,
  COALESCE(SUM(p.amount), 0) - COALESCE(SUM(e.amount), 0) AS profit,
  CASE WHEN COALESCE(SUM(p.amount), 0) > 0
    THEN (COALESCE(SUM(p.amount), 0) - COALESCE(SUM(e.amount), 0)) / COALESCE(SUM(p.amount), 0) * 100
    ELSE 0 END AS profit_margin
FROM jobs j
LEFT JOIN invoices i ON i.job_id = j.id
LEFT JOIN payments p ON p.job_id = j.id
LEFT JOIN expenses e ON e.job_id = j.id
GROUP BY j.id;

-- Client computed fields
CREATE VIEW IF NOT EXISTS v_client_summary AS
SELECT
  c.id AS client_id,
  COUNT(DISTINCT j.id) AS total_jobs,
  COALESCE(SUM(p.amount), 0) AS total_revenue
FROM clients c
LEFT JOIN jobs j ON j.client_id = c.id
LEFT JOIN payments p ON p.client_id = c.id
GROUP BY c.id;

-- Content schedule computed counts
CREATE VIEW IF NOT EXISTS v_content_schedule_counts AS
SELECT
  cs.id AS schedule_id,
  COUNT(sp.id) AS total_posts_planned,
  COUNT(CASE WHEN sp.post_type = 'job_completion' THEN 1 END) AS job_completion_count,
  COUNT(CASE WHEN sp.post_type = 'seasonal_tips' THEN 1 END) AS seasonal_count,
  COUNT(CASE WHEN sp.post_type = 'tips_tricks' THEN 1 END) AS tips_count
FROM content_schedules cs
LEFT JOIN social_posts sp ON
  CAST(strftime('%m', sp.scheduled_date) AS INTEGER) = cs.month
  AND CAST(strftime('%Y', sp.scheduled_date) AS INTEGER) = cs.year
GROUP BY cs.id;

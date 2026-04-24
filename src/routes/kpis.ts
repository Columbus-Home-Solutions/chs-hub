/**
 * GET /api/kpis — dashboard top-level KPIs computed from D1.
 *
 * Matches the shape currently produced by jobber_sync.py and written to
 * Google Sheets cell KPI_Sync!B2:G2, so the new dashboard can be validated
 * against the old one with a simple side-by-side comparison.
 *
 *   ytd_revenue_collections → B2 (YTD Revenue — collections if any, else gross)
 *   monthly_collections      → C2 (Monthly Revenue)
 *   weekly_collections       → D2 (Weekly Collections)
 *   ytd_profit               → E2 (YTD Profit — gross revenue minus line-item cost)
 *   monthly_profit           → F2 (Monthly Profit — collections minus line-item cost)
 *   ytd_jobs                 → G2 (Job Count)
 *
 * Caveat: line-item cost does NOT yet include expenses (those need a
 * separate per-job API fetch). Profit numbers will be slightly higher than
 * the Python sync produces. Expenses sync ships in a follow-up pass.
 */

import type { Env } from "../env.js";

type DateRange = { start: string; end: string };

function computeRanges(now = new Date()): {
  year: DateRange;
  month: DateRange;
  week: DateRange;
} {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  const yearStart = new Date(Date.UTC(y, 0, 1));
  const yearEnd = new Date(Date.UTC(y + 1, 0, 1));

  const monthStart = new Date(Date.UTC(y, m, 1));
  const monthEnd = new Date(Date.UTC(y, m + 1, 1));

  // Weeks run Sunday → Saturday, matching the WC KBPI sheet convention.
  const dayOfWeek = now.getUTCDay(); // Sun=0 … Sat=6
  const weekStart = new Date(Date.UTC(y, m, d - dayOfWeek));
  const weekEnd = new Date(Date.UTC(y, m, d - dayOfWeek + 7));

  return {
    year: { start: yearStart.toISOString(), end: yearEnd.toISOString() },
    month: { start: monthStart.toISOString(), end: monthEnd.toISOString() },
    week: { start: weekStart.toISOString(), end: weekEnd.toISOString() },
  };
}

interface KpiResponse {
  as_of: string;
  ranges: {
    year: DateRange;
    month: DateRange;
    week: DateRange;
  };
  ytd_revenue_collections: number;
  ytd_revenue_gross: number;
  monthly_collections: number;
  weekly_collections: number;
  ytd_profit: number;
  monthly_profit: number;
  ytd_jobs: number;
  last_sync: {
    started_at: string | null;
    finished_at: string | null;
    status: string | null;
    rows_affected: number | null;
    duration_ms: number | null;
  } | null;
}

export async function handleKpis(env: Env): Promise<KpiResponse> {
  const ranges = computeRanges();

  const ytdJobs = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM jobs WHERE created_at >= ? AND created_at < ?`,
  )
    .bind(ranges.year.start, ranges.year.end)
    .first<{ n: number }>();

  const ytdRevenueGross = await env.DB.prepare(
    `SELECT COALESCE(SUM(total), 0) AS v FROM jobs WHERE created_at >= ? AND created_at < ?`,
  )
    .bind(ranges.year.start, ranges.year.end)
    .first<{ v: number }>();

  // Cost = line-item cost (labor/subcontract) + expenses (materials,
  // receipts, misc). Matches what the Python sync was computing.
  const ytdLineItemCost = await env.DB.prepare(
    `SELECT COALESCE(SUM(li.quantity * li.unit_cost), 0) AS v
     FROM line_items li
     JOIN jobs j ON j.id = li.job_id
     WHERE j.created_at >= ? AND j.created_at < ?`,
  )
    .bind(ranges.year.start, ranges.year.end)
    .first<{ v: number }>();

  const ytdExpenseCost = await env.DB.prepare(
    `SELECT COALESCE(SUM(e.amount), 0) AS v
     FROM expenses e
     JOIN jobs j ON j.id = e.job_id
     WHERE j.created_at >= ? AND j.created_at < ?`,
  )
    .bind(ranges.year.start, ranges.year.end)
    .first<{ v: number }>();

  // Collections formula: for PAID invoices, use `total` (Jobber's UI treats
  // "paid" as fully collected, and its own `paymentsTotal` under-reports
  // when deposits/refunds aren't re-summed — caused a $13k YTD gap against
  // Jobber's own dashboard). For everything else, use `payments_total` so
  // partial collections on past-due / awaiting-payment still count.
  const collectedExpr = `(CASE WHEN UPPER(status) = 'PAID' THEN COALESCE(total, 0) ELSE COALESCE(payments_total, 0) END)`;

  const ytdCollections = await env.DB.prepare(
    `SELECT COALESCE(SUM(${collectedExpr}), 0) AS v
     FROM invoices
     WHERE issued_date >= ? AND issued_date < ?`,
  )
    .bind(ranges.year.start.slice(0, 10), ranges.year.end.slice(0, 10))
    .first<{ v: number }>();

  const monthlyCollections = await env.DB.prepare(
    `SELECT COALESCE(SUM(${collectedExpr}), 0) AS v
     FROM invoices
     WHERE issued_date >= ? AND issued_date < ?`,
  )
    .bind(ranges.month.start.slice(0, 10), ranges.month.end.slice(0, 10))
    .first<{ v: number }>();

  const weeklyCollections = await env.DB.prepare(
    `SELECT COALESCE(SUM(${collectedExpr}), 0) AS v
     FROM invoices
     WHERE issued_date >= ? AND issued_date < ?`,
  )
    .bind(ranges.week.start.slice(0, 10), ranges.week.end.slice(0, 10))
    .first<{ v: number }>();

  // Monthly cost — same inputs as YTD cost but scoped to jobs whose
  // PAID invoice was issued this month (mirrors Python's monthly_cost logic).
  const monthlyLineItemCost = await env.DB.prepare(
    `SELECT COALESCE(SUM(li.quantity * li.unit_cost), 0) AS v
     FROM line_items li
     JOIN jobs j ON j.id = li.job_id
     JOIN invoices inv ON inv.job_id = j.id
     WHERE UPPER(inv.status) = 'PAID'
       AND inv.issued_date >= ? AND inv.issued_date < ?`,
  )
    .bind(ranges.month.start.slice(0, 10), ranges.month.end.slice(0, 10))
    .first<{ v: number }>();

  const monthlyExpenseCost = await env.DB.prepare(
    `SELECT COALESCE(SUM(e.amount), 0) AS v
     FROM expenses e
     JOIN jobs j ON j.id = e.job_id
     JOIN invoices inv ON inv.job_id = j.id
     WHERE UPPER(inv.status) = 'PAID'
       AND inv.issued_date >= ? AND inv.issued_date < ?`,
  )
    .bind(ranges.month.start.slice(0, 10), ranges.month.end.slice(0, 10))
    .first<{ v: number }>();

  const ytdCollectionsV = ytdCollections?.v ?? 0;
  const ytdRevenueGrossV = ytdRevenueGross?.v ?? 0;
  const ytdCostV = (ytdLineItemCost?.v ?? 0) + (ytdExpenseCost?.v ?? 0);
  const ytdProfit = ytdRevenueGrossV - ytdCostV;
  const monthlyCollectionsV = monthlyCollections?.v ?? 0;
  const monthlyCostV =
    (monthlyLineItemCost?.v ?? 0) + (monthlyExpenseCost?.v ?? 0);
  const monthlyProfit = monthlyCollectionsV - monthlyCostV;

  const lastSyncRow = await env.DB.prepare(
    `SELECT started_at, finished_at, status, rows_affected, duration_ms
     FROM sync_log
     WHERE job_name = 'jobber_full'
     ORDER BY id DESC
     LIMIT 1`,
  ).first<{
    started_at: string;
    finished_at: string | null;
    status: string;
    rows_affected: number | null;
    duration_ms: number | null;
  }>();

  return {
    as_of: new Date().toISOString(),
    ranges,
    ytd_revenue_collections: round2(ytdCollectionsV || ytdRevenueGrossV),
    ytd_revenue_gross: round2(ytdRevenueGrossV),
    monthly_collections: round2(monthlyCollectionsV),
    weekly_collections: round2(weeklyCollections?.v ?? 0),
    ytd_profit: round2(ytdProfit),
    monthly_profit: round2(monthlyProfit),
    ytd_jobs: ytdJobs?.n ?? 0,
    last_sync: lastSyncRow ?? null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

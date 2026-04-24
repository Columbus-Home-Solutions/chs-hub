/**
 * GET /api/kpis — dashboard top-level KPIs computed from D1.
 *
 * Powers the 7 KPI tiles on the main dashboard:
 *   jobs_in_progress          → 🔨 Jobs In Progress
 *   weekly_collections        → 💵 Revenue This Week
 *   unpaid_invoices_total     → 📄 Unpaid Invoices
 *   payments_scheduled_total  → 📅 Pymt Scheduled
 *   monthly_collections       → 📈 Monthly Revenue (collections-based)
 *   ytd_profit / margin_pct   → 💰 YTD Profit — dual-stat tile
 *   pipeline_dollars          → 🎯 Pipeline $ (new 7th tile)
 *
 * Plus supporting numbers used by the Business Pulse section:
 *   ytd_revenue_gross, ytd_revenue_collections, monthly_profit, ytd_jobs
 *
 * Expenses are totaled by incurred_at (matches Jobber's Expense Report).
 * Profit = revenue − line-item cost − expenses, scoped by the relevant
 * date range (year/month).
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

  // Weeks run Sunday → Saturday, matching the KBPI sheet convention.
  const dayOfWeek = now.getUTCDay();
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
  ranges: { year: DateRange; month: DateRange; week: DateRange };
  jobs_in_progress: number;
  weekly_collections: number;
  unpaid_invoices_total: number;
  unpaid_invoices_count: number;
  payments_scheduled_total: number;
  payments_scheduled_count: number;
  monthly_collections: number;
  monthly_profit: number;
  ytd_revenue_gross: number;
  ytd_revenue_collections: number;
  ytd_profit: number;
  ytd_profit_margin_pct: number;
  ytd_jobs: number;
  pipeline_dollars: number;
  pipeline_count: number;
  last_sync: {
    started_at: string | null;
    finished_at: string | null;
    status: string | null;
    rows_affected: number | null;
    duration_ms: number | null;
  } | null;
}

// Jobber status values we treat as "open / in-progress" for the KPI tile.
// "archived" is closed/complete in Jobber's model. Everything else that
// isn't archived is still active work.
const OPEN_JOB_STATUSES = [
  "late",
  "action_required",
  "requires_invoicing",
  "upcoming",
  "on_the_way",
  "active",
  "in_progress",
];

// Pipeline = quotes that have been issued but aren't yet jobs or dead.
const PIPELINE_QUOTE_STATUSES = [
  "awaiting_response",
  "changes_requested",
  "approved",
];

// "paid" case-insensitive — Jobber returns lowercase on the API.
const PAID_EXPR = `UPPER(status) = 'PAID'`;

// For collections, we trust `total` on paid invoices (Jobber's own
// paymentsTotal under-reports) and `payments_total` on everything else.
const COLLECTED_EXPR = `(CASE WHEN ${PAID_EXPR} THEN COALESCE(total, 0) ELSE COALESCE(payments_total, 0) END)`;

export async function handleKpis(env: Env): Promise<KpiResponse> {
  const ranges = computeRanges();

  // ── Count-style KPIs ───────────────────────────────────────────────

  const jobsInProgressPlaceholders = OPEN_JOB_STATUSES.map(() => "?").join(",");
  const jobsInProgress = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM jobs
     WHERE LOWER(COALESCE(status,'')) IN (${jobsInProgressPlaceholders})`,
  )
    .bind(...OPEN_JOB_STATUSES)
    .first<{ n: number }>();

  const ytdJobs = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM jobs WHERE created_at >= ? AND created_at < ?`,
  )
    .bind(ranges.year.start, ranges.year.end)
    .first<{ n: number }>();

  // ── Revenue + profit ───────────────────────────────────────────────

  const ytdRevenueGross = await env.DB.prepare(
    `SELECT COALESCE(SUM(total), 0) AS v FROM jobs WHERE created_at >= ? AND created_at < ?`,
  )
    .bind(ranges.year.start, ranges.year.end)
    .first<{ v: number }>();

  const ytdLineItemCost = await env.DB.prepare(
    `SELECT COALESCE(SUM(li.quantity * li.unit_cost), 0) AS v
     FROM line_items li
     JOIN jobs j ON j.id = li.job_id
     WHERE j.created_at >= ? AND j.created_at < ?`,
  )
    .bind(ranges.year.start, ranges.year.end)
    .first<{ v: number }>();

  // Expenses filter by incurred_at (matches Jobber's Expense Report).
  const ytdExpenseCost = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS v
     FROM expenses
     WHERE incurred_at >= ? AND incurred_at < ?`,
  )
    .bind(ranges.year.start.slice(0, 10), ranges.year.end.slice(0, 10))
    .first<{ v: number }>();

  // ── Collections by date range ──────────────────────────────────────

  const ytdCollections = await env.DB.prepare(
    `SELECT COALESCE(SUM(${COLLECTED_EXPR}), 0) AS v
     FROM invoices
     WHERE issued_date >= ? AND issued_date < ?`,
  )
    .bind(ranges.year.start.slice(0, 10), ranges.year.end.slice(0, 10))
    .first<{ v: number }>();

  const monthlyCollections = await env.DB.prepare(
    `SELECT COALESCE(SUM(${COLLECTED_EXPR}), 0) AS v
     FROM invoices
     WHERE issued_date >= ? AND issued_date < ?`,
  )
    .bind(ranges.month.start.slice(0, 10), ranges.month.end.slice(0, 10))
    .first<{ v: number }>();

  const weeklyCollections = await env.DB.prepare(
    `SELECT COALESCE(SUM(${COLLECTED_EXPR}), 0) AS v
     FROM invoices
     WHERE issued_date >= ? AND issued_date < ?`,
  )
    .bind(ranges.week.start.slice(0, 10), ranges.week.end.slice(0, 10))
    .first<{ v: number }>();

  // ── Monthly cost (for monthly profit) ──────────────────────────────

  const monthlyLineItemCost = await env.DB.prepare(
    `SELECT COALESCE(SUM(li.quantity * li.unit_cost), 0) AS v
     FROM line_items li
     JOIN jobs j ON j.id = li.job_id
     JOIN invoices inv ON inv.job_id = j.id
     WHERE ${PAID_EXPR.replace(/status/g, "inv.status")}
       AND inv.issued_date >= ? AND inv.issued_date < ?`,
  )
    .bind(ranges.month.start.slice(0, 10), ranges.month.end.slice(0, 10))
    .first<{ v: number }>();

  const monthlyExpenseCost = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS v
     FROM expenses
     WHERE incurred_at >= ? AND incurred_at < ?`,
  )
    .bind(ranges.month.start.slice(0, 10), ranges.month.end.slice(0, 10))
    .first<{ v: number }>();

  // ── Unpaid + Payments Scheduled ────────────────────────────────────

  // Outstanding balance expression — never go negative (over-payments
  // exist in Jobber data for a handful of edge cases).
  const balanceExpr = `CASE
    WHEN COALESCE(total,0) > COALESCE(payments_total,0)
    THEN COALESCE(total,0) - COALESCE(payments_total,0)
    ELSE 0 END`;

  // Unpaid = any invoice not fully paid (past due, pending, etc.).
  const unpaid = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(${balanceExpr}), 0) AS v,
       COUNT(*) AS n
     FROM invoices
     WHERE UPPER(COALESCE(status,'')) <> 'PAID'
       AND COALESCE(total, 0) > COALESCE(payments_total, 0)`,
  ).first<{ v: number; n: number }>();

  // Payments Scheduled = unpaid invoices whose due_date is in the future
  // (approximates "coming up / scheduled" in the old dashboard).
  const today = new Date().toISOString().slice(0, 10);
  const scheduled = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(${balanceExpr}), 0) AS v,
       COUNT(*) AS n
     FROM invoices
     WHERE UPPER(COALESCE(status,'')) <> 'PAID'
       AND due_date IS NOT NULL
       AND due_date >= ?`,
  )
    .bind(today)
    .first<{ v: number; n: number }>();

  // ── Pipeline $ (open quotes) ───────────────────────────────────────

  const pipelinePlaceholders = PIPELINE_QUOTE_STATUSES.map(() => "?").join(",");
  const pipeline = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(COALESCE(subtotal, 0)), 0) AS v,
       COUNT(*) AS n
     FROM quotes
     WHERE LOWER(COALESCE(status,'')) IN (${pipelinePlaceholders})`,
  )
    .bind(...PIPELINE_QUOTE_STATUSES)
    .first<{ v: number; n: number }>();

  // ── Derived + formatting ───────────────────────────────────────────

  const ytdCollectionsV = ytdCollections?.v ?? 0;
  const ytdRevenueGrossV = ytdRevenueGross?.v ?? 0;
  const ytdCostV = (ytdLineItemCost?.v ?? 0) + (ytdExpenseCost?.v ?? 0);
  const ytdProfit = ytdRevenueGrossV - ytdCostV;
  const ytdProfitMarginPct =
    ytdRevenueGrossV > 0 ? (ytdProfit / ytdRevenueGrossV) * 100 : 0;

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
    jobs_in_progress: jobsInProgress?.n ?? 0,
    weekly_collections: round2(weeklyCollections?.v ?? 0),
    unpaid_invoices_total: round2(unpaid?.v ?? 0),
    unpaid_invoices_count: unpaid?.n ?? 0,
    payments_scheduled_total: round2(scheduled?.v ?? 0),
    payments_scheduled_count: scheduled?.n ?? 0,
    monthly_collections: round2(monthlyCollectionsV),
    monthly_profit: round2(monthlyProfit),
    ytd_revenue_gross: round2(ytdRevenueGrossV),
    ytd_revenue_collections: round2(ytdCollectionsV),
    ytd_profit: round2(ytdProfit),
    ytd_profit_margin_pct: round1(ytdProfitMarginPct),
    ytd_jobs: ytdJobs?.n ?? 0,
    pipeline_dollars: round2(pipeline?.v ?? 0),
    pipeline_count: pipeline?.n ?? 0,
    last_sync: lastSyncRow ?? null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

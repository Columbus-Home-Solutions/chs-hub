/**
 * Computation helpers for the Wealthy Contractor (WC) workbook sync.
 *
 * All numbers are CASH BASIS:
 *   - Income  = payments collected in period (payments.collected_at)
 *   - Profit  = income − expenses incurred in period
 *                      − line-item costs attributed to the paid invoices
 *                        (weighted by payment_amount / invoice.total so that
 *                        partial payments only pull their pro-rata share of
 *                        the job's cost)
 *   - Sales   = invoices issued in period (invoices.issued_date)
 *
 * Exposed as two functions:
 *   - computeMonthly(env, year) → one row per month 1..12
 *   - computeWeekly(env, year)  → one row per Sun→Sat week in that year
 */

import type { Env } from "../../env.js";

export interface MonthlyRow {
  month: number; // 1..12
  ym: string; // "YYYY-MM"
  income: number;
  expenses: number;
  line_item_cost: number;
  profit: number; // income − expenses − line_item_cost
}

export interface WeeklyRow {
  week_start: string; // ISO date (Sunday)
  week_end: string; // ISO date (Saturday, inclusive)
  new_sales: number; // invoices issued that week
  collections: number; // payments received that week
  estimates: number; // quotes issued that week
  closed: number; // quotes approved (or converted to job) that week
  accounts_receivable: number; // running AR at week_end (unpaid invoices, end-of-week)
}

// ────────────────────────────────────────────────────────────────────────
// Monthly rollup
// ────────────────────────────────────────────────────────────────────────

export async function computeMonthly(
  env: Env,
  year: number,
): Promise<MonthlyRow[]> {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year + 1}-01-01`;

  const incomeRows = await env.DB.prepare(
    `SELECT strftime('%Y-%m', collected_at) AS ym,
            ROUND(SUM(amount), 2) AS income
     FROM payments
     WHERE collected_at >= ? AND collected_at < ?
     GROUP BY ym`,
  )
    .bind(yearStart, yearEnd)
    .all<{ ym: string; income: number }>();

  // Line-item cost attributed to paid invoices, weighted by the fraction
  // of the invoice that was paid in each month. Handles partial payments
  // gracefully (e.g. 50% deposit in Feb, 50% final in Apr → cost is split
  // 50/50 between Feb and Apr).
  const costRows = await env.DB.prepare(
    `WITH job_costs AS (
       SELECT li.job_id,
              COALESCE(SUM(li.quantity * li.unit_cost), 0) AS cost
       FROM line_items li
       GROUP BY li.job_id
     )
     SELECT strftime('%Y-%m', p.collected_at) AS ym,
            ROUND(SUM(
              CASE WHEN COALESCE(inv.total, 0) > 0
                   THEN (p.amount / inv.total) * COALESCE(jc.cost, 0)
                   ELSE 0
              END
            ), 2) AS cost
     FROM payments p
     JOIN invoices inv ON inv.id = p.invoice_id
     LEFT JOIN job_costs jc ON jc.job_id = inv.job_id
     WHERE p.collected_at >= ? AND p.collected_at < ?
     GROUP BY ym`,
  )
    .bind(yearStart, yearEnd)
    .all<{ ym: string; cost: number }>();

  const expenseRows = await env.DB.prepare(
    `SELECT strftime('%Y-%m', incurred_at) AS ym,
            ROUND(SUM(amount), 2) AS expenses
     FROM expenses
     WHERE incurred_at >= ? AND incurred_at < ?
     GROUP BY ym`,
  )
    .bind(yearStart, yearEnd)
    .all<{ ym: string; expenses: number }>();

  const incomeByYm = new Map<string, number>(
    (incomeRows.results ?? []).map((r) => [r.ym, r.income ?? 0]),
  );
  const costByYm = new Map<string, number>(
    (costRows.results ?? []).map((r) => [r.ym, r.cost ?? 0]),
  );
  const expenseByYm = new Map<string, number>(
    (expenseRows.results ?? []).map((r) => [r.ym, r.expenses ?? 0]),
  );

  const rows: MonthlyRow[] = [];
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${String(m).padStart(2, "0")}`;
    const income = incomeByYm.get(ym) ?? 0;
    const expenses = expenseByYm.get(ym) ?? 0;
    const cost = costByYm.get(ym) ?? 0;
    rows.push({
      month: m,
      ym,
      income,
      expenses,
      line_item_cost: cost,
      profit: round2(income - expenses - cost),
    });
  }
  return rows;
}

// ────────────────────────────────────────────────────────────────────────
// Weekly rollup (Sun → Sat)
// ────────────────────────────────────────────────────────────────────────

export async function computeWeekly(
  env: Env,
  year: number,
): Promise<WeeklyRow[]> {
  const weeks = enumerateSundayWeeks(year);

  const newSales = await aggregateByWeek(
    env,
    `SELECT issued_date AS d, total AS v
     FROM invoices
     WHERE issued_date >= ? AND issued_date < ?
       AND UPPER(COALESCE(status, '')) != 'BAD_DEBT'`,
    year,
  );

  const collections = await aggregateByWeek(
    env,
    `SELECT substr(collected_at, 1, 10) AS d, amount AS v
     FROM payments
     WHERE collected_at >= ? AND collected_at < ?`,
    year,
  );

  // Estimates = quotes issued that week. Quote has no issued_date column in
  // Jobber — we use created_at as the proxy (quote was sent to customer).
  const estimates = await aggregateByWeek(
    env,
    `SELECT substr(created_at, 1, 10) AS d, 1 AS v
     FROM quotes
     WHERE created_at >= ? AND created_at < ?`,
    year,
  );

  // Closed = quotes whose status transitioned to 'approved' or 'converted'
  // in that week. Jobber records the timestamp of the most recent status
  // change in quotes.transitioned_at.
  const closed = await aggregateByWeek(
    env,
    `SELECT substr(transitioned_at, 1, 10) AS d, 1 AS v
     FROM quotes
     WHERE transitioned_at >= ? AND transitioned_at < ?
       AND LOWER(COALESCE(status, '')) IN ('approved', 'converted')`,
    year,
  );

  // Accounts Receivable at end of week = sum of unpaid balances on invoices
  // issued on or before that week_end and not yet fully paid by that point.
  // Approximation: we don't have a payment-by-payment ledger per-week, so
  // we use the current AR of invoices issued ≤ week_end. Close enough for
  // the weekly tracking purpose.
  const arByWeek = await computeWeeklyAR(env, weeks);

  return weeks.map((w) => ({
    week_start: w.start,
    week_end: w.end,
    new_sales: round2(newSales.get(w.start) ?? 0),
    collections: round2(collections.get(w.start) ?? 0),
    estimates: Math.round(estimates.get(w.start) ?? 0),
    closed: Math.round(closed.get(w.start) ?? 0),
    accounts_receivable: round2(arByWeek.get(w.start) ?? 0),
  }));
}

// ─── helpers ──────────────────────────────────────────────────────────

interface Week {
  start: string; // ISO Sunday
  end: string; // ISO Saturday (inclusive)
}

function enumerateSundayWeeks(year: number): Week[] {
  // First Sunday ≤ Jan 1 of year.
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const dayOfWeek = jan1.getUTCDay(); // 0 = Sun
  const firstSunday = new Date(jan1);
  firstSunday.setUTCDate(jan1.getUTCDate() - dayOfWeek);

  const weeks: Week[] = [];
  const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
  let cursor = new Date(firstSunday);
  while (cursor < yearEnd) {
    const start = cursor.toISOString().slice(0, 10);
    const endDate = new Date(cursor);
    endDate.setUTCDate(cursor.getUTCDate() + 6);
    const end = endDate.toISOString().slice(0, 10);
    weeks.push({ start, end });
    cursor = new Date(cursor);
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return weeks;
}

async function aggregateByWeek(
  env: Env,
  sql: string,
  year: number,
): Promise<Map<string, number>> {
  const lo = `${year - 1}-12-01`; // grab a little extra to cover edge weeks
  const hi = `${year + 1}-02-01`;
  const res = await env.DB.prepare(sql).bind(lo, hi).all<{
    d: string;
    v: number;
  }>();
  const out = new Map<string, number>();
  for (const row of res.results ?? []) {
    if (!row.d) continue;
    const sunday = sundayOf(row.d);
    out.set(sunday, (out.get(sunday) ?? 0) + (row.v ?? 0));
  }
  return out;
}

function sundayOf(dateIso: string): string {
  const d = new Date(dateIso + (dateIso.length === 10 ? "T00:00:00Z" : ""));
  const day = d.getUTCDay();
  const sun = new Date(d);
  sun.setUTCDate(d.getUTCDate() - day);
  return sun.toISOString().slice(0, 10);
}

async function computeWeeklyAR(
  env: Env,
  weeks: Week[],
): Promise<Map<string, number>> {
  // Snapshot AR = outstanding balance of invoices issued ≤ week_end.
  // We pull all invoice (issued_date, total, payments_total, status) rows
  // once, then filter in JS per week. Fast enough at ~hundreds of rows.
  const rows = await env.DB.prepare(
    `SELECT issued_date, COALESCE(total, 0) AS total,
            COALESCE(payments_total, 0) AS paid, status
     FROM invoices
     WHERE issued_date IS NOT NULL
       AND UPPER(COALESCE(status, '')) NOT IN ('PAID', 'BAD_DEBT')`,
  ).all<{
    issued_date: string;
    total: number;
    paid: number;
    status: string;
  }>();

  const out = new Map<string, number>();
  for (const w of weeks) {
    let ar = 0;
    for (const r of rows.results ?? []) {
      if (!r.issued_date) continue;
      if (r.issued_date <= w.end) {
        const balance = r.total - r.paid;
        if (balance > 0) ar += balance;
      }
    }
    out.set(w.start, ar);
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

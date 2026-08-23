/**
 * Financial Reports — CPA Export and related endpoints.
 *
 *   GET /api/reports/cpa-export?year=YYYY
 *     Role: O
 *     Returns a multi-section CSV covering income, expenses, subcontractor
 *     payments (1099 candidates), mileage, and job profitability for the
 *     requested year. Pure CSV — no PDF, no zip.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { claudeMessages, extractJson } from "../lib/claude.js";
import { NON_TEST_CLIENT, notTestClientExists } from "../lib/non-test-client.js";

function csvErr(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function esc(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function row(...cols: (string | number | null | undefined)[]): string {
  return cols.map(esc).join(",");
}

function fmt(n: number | null | undefined): string {
  return (n ?? 0).toFixed(2);
}

// IRS Schedule C category mapping — spec §4.
const IRS_CAT: Record<string, string> = {
  materials: "Materials & Supplies",
  labor: "Contract Labor",
  equipment: "Equipment Rental",
  subcontractor: "Contract Labor",
  fuel: "Car & Truck Expenses",
  office: "Office Expense",
  permits: "Licenses & Fees",
  insurance: "Insurance",
  utilities: "Utilities",
  other: "Other Expenses",
};

function irsCategory(expenseType: string | null): string {
  if (!expenseType) return "Other Expenses";
  const k = expenseType.toLowerCase().trim();
  return IRS_CAT[k] ?? "Other Expenses";
}

function monthName(m: number): string {
  return [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ][m - 1] ?? String(m);
}

// ── Section builders ──────────────────────────────────────────────────────────

async function buildIncomeSection(env: Env, year: string): Promise<string[]> {
  const lines: string[] = ["--- INCOME SUMMARY ---"];
  lines.push(row("Month", "Total Invoiced", "Total Collected"));

  const invoiceRows = (
    await env.DB.prepare(
      `SELECT strftime('%m', COALESCE(issued_date, created_at)) AS mo,
              SUM(COALESCE(amount, total_due, 0)) AS invoiced
       FROM invoices
       WHERE strftime('%Y', COALESCE(issued_date, created_at)) = ?
         AND ${notTestClientExists("client_id")}
       GROUP BY mo
       ORDER BY mo ASC`,
    )
      .bind(year)
      .all<{ mo: string; invoiced: number }>()
  ).results ?? [];

  const paymentRows = (
    await env.DB.prepare(
      `SELECT strftime('%m', COALESCE(received_date, collected_at, created_at)) AS mo,
              SUM(COALESCE(amount, 0)) AS collected
       FROM payments
       WHERE strftime('%Y', COALESCE(received_date, collected_at, created_at)) = ?
         AND ${notTestClientExists("client_id")}
       GROUP BY mo
       ORDER BY mo ASC`,
    )
      .bind(year)
      .all<{ mo: string; collected: number }>()
  ).results ?? [];

  const invMap = new Map(invoiceRows.map((r) => [r.mo, r.invoiced]));
  const payMap = new Map(paymentRows.map((r) => [r.mo, r.collected]));

  let totalInv = 0;
  let totalColl = 0;

  for (let m = 1; m <= 12; m++) {
    const mo = String(m).padStart(2, "0");
    const inv = invMap.get(mo) ?? 0;
    const coll = payMap.get(mo) ?? 0;
    if (inv === 0 && coll === 0) continue;
    totalInv += inv;
    totalColl += coll;
    lines.push(row(`${monthName(m)} ${year}`, fmt(inv), fmt(coll)));
  }

  lines.push(row("TOTAL", fmt(totalInv), fmt(totalColl)));
  return lines;
}

interface ExpenseRow {
  id: string;
  job_id: string | null;
  job_number: number | null;
  expense_type: string | null;
  description: string | null;
  vendor: string | null;
  date_val: string | null;
  amount: number | null;
}

async function buildExpenseSection(env: Env, year: string): Promise<string[]> {
  const lines: string[] = ["--- EXPENSE SUMMARY BY IRS CATEGORY ---"];
  lines.push(row("IRS Category", "Description", "Vendor", "Date", "Amount", "Job"));

  const expenses = (
    await env.DB.prepare(
      `SELECT e.id, e.job_id,
              j.job_number,
              e.expense_type,
              e.description,
              e.vendor,
              COALESCE(e.incurred_date, e.incurred_at, e.created_at) AS date_val,
              e.amount
       FROM expenses e
       LEFT JOIN jobs j ON j.id = e.job_id
       WHERE strftime('%Y', COALESCE(e.incurred_date, e.incurred_at, e.created_at)) = ?
         AND (e.is_active IS NULL OR e.is_active != 0)
         AND ${notTestClientExists("j.client_id")}
       ORDER BY e.expense_type ASC, date_val ASC`,
    )
      .bind(year)
      .all<ExpenseRow>()
  ).results ?? [];

  const byCategory = new Map<string, ExpenseRow[]>();
  for (const e of expenses) {
    const cat = irsCategory(e.expense_type);
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(e);
  }

  let grandTotal = 0;

  for (const [cat, rows] of byCategory) {
    let catTotal = 0;
    for (const e of rows) {
      const amt = e.amount ?? 0;
      catTotal += amt;
      grandTotal += amt;
      const jobRef = e.job_number ? `JOB-${String(e.job_number).padStart(3, "0")}` : "";
      lines.push(row(cat, e.description, e.vendor, e.date_val?.slice(0, 10), fmt(amt), jobRef));
    }
    lines.push(row(`CATEGORY TOTAL (${cat})`, "", "", "", fmt(catTotal), ""));
    lines.push("");
  }

  lines.push(row("GRAND TOTAL", "", "", "", fmt(grandTotal), ""));
  return lines;
}

interface SubExpenseRow {
  sub_id: string | null;
  company: string | null;
  tax_id: string | null;
  total_paid: number;
}

async function buildSubcontractorSection(env: Env, year: string): Promise<string[]> {
  const lines: string[] = ["--- SUBCONTRACTOR PAYMENTS (1099 CANDIDATES) ---"];
  lines.push(row("Subcontractor", "Tax ID", "Total Paid This Year", "1099 Required"));

  const subRows = (
    await env.DB.prepare(
      `SELECT e.sub_id,
              COALESCE(s.company_name, s.company, s.primary_contact, 'Unknown') AS company,
              s.tax_id,
              SUM(COALESCE(e.amount, 0)) AS total_paid
       FROM expenses e
       LEFT JOIN subcontractors s ON s.id = e.sub_id
       WHERE e.sub_id IS NOT NULL
         AND strftime('%Y', COALESCE(e.incurred_date, e.incurred_at, e.created_at)) = ?
         AND (e.is_active IS NULL OR e.is_active != 0)
         AND ${notTestClientExists("(SELECT client_id FROM jobs WHERE id = e.job_id)")}
       GROUP BY e.sub_id
       ORDER BY total_paid DESC`,
    )
      .bind(year)
      .all<SubExpenseRow>()
  ).results ?? [];

  // Also include expenses flagged is_1099_reportable = 1 without a sub_id link.
  const flaggedRows = (
    await env.DB.prepare(
      `SELECT e.description AS company,
              SUM(COALESCE(e.amount, 0)) AS total_paid
       FROM expenses e
       WHERE e.is_1099_reportable = 1
         AND (e.sub_id IS NULL)
         AND strftime('%Y', COALESCE(e.incurred_date, e.incurred_at, e.created_at)) = ?
         AND (e.is_active IS NULL OR e.is_active != 0)
         AND ${notTestClientExists("(SELECT client_id FROM jobs WHERE id = e.job_id)")}
       GROUP BY e.description
       ORDER BY total_paid DESC`,
    )
      .bind(year)
      .all<{ company: string | null; total_paid: number }>()
  ).results ?? [];

  for (const r of subRows) {
    const required = r.total_paid >= 600 ? "YES" : "NO";
    lines.push(row(r.company, r.tax_id ?? "", fmt(r.total_paid), required));
  }
  for (const r of flaggedRows) {
    const required = r.total_paid >= 600 ? "YES" : "NO";
    lines.push(row(r.company, "", fmt(r.total_paid), required));
  }

  if (subRows.length === 0 && flaggedRows.length === 0) {
    lines.push(row("No subcontractor payments found", "", "", ""));
  }

  return lines;
}

interface MileageRow {
  trip_date: string | null;
  start_location: string | null;
  end_location: string | null;
  trip_purpose: string | null;
  distance_miles: number | null;
  irs_rate: number | null;
  deduction_amount: number | null;
}

async function buildMileageSection(env: Env, year: string): Promise<string[]> {
  // Get IRS rate from system_settings (fallback to 0.67 if absent).
  let defaultRate = 0.67;
  try {
    const setting = await env.DB.prepare(
      "SELECT value FROM system_settings WHERE key = 'mileage_rate_per_mile'",
    ).first<{ value: string }>();
    if (setting?.value) {
      const parsed = parseFloat(setting.value);
      if (!isNaN(parsed)) defaultRate = parsed;
    }
  } catch {
    console.warn("[cpa-export] mileage_rate_per_mile not found in system_settings, defaulting to 0.67");
  }

  const lines: string[] = [`--- MILEAGE LOG (IRS rate: $${defaultRate.toFixed(2)}/mile) ---`];
  lines.push(row("Date", "From", "To", "Purpose", "Miles", `Deduction (@ $${defaultRate.toFixed(2)}/mile)`));

  const mileageRows = (
    await env.DB.prepare(
      `SELECT trip_date, start_location, end_location, trip_purpose,
              distance_miles, irs_rate, deduction_amount
       FROM mileage
       WHERE strftime('%Y', trip_date) = ?
       ORDER BY trip_date ASC`,
    )
      .bind(year)
      .all<MileageRow>()
  ).results ?? [];

  let totalMiles = 0;
  let totalDeduction = 0;

  for (const r of mileageRows) {
    const miles = r.distance_miles ?? 0;
    // Use stored irs_rate/deduction_amount if available, else compute from default.
    const rate = r.irs_rate ?? defaultRate;
    const deduction = r.deduction_amount ?? miles * rate;
    totalMiles += miles;
    totalDeduction += deduction;
    lines.push(
      row(
        r.trip_date?.slice(0, 10),
        r.start_location,
        r.end_location,
        r.trip_purpose,
        miles.toFixed(1),
        `$${deduction.toFixed(2)}`,
      ),
    );
  }

  lines.push(row("TOTAL MILES", "", "", "", totalMiles.toFixed(1), `$${totalDeduction.toFixed(2)}`));
  return lines;
}

interface JobProfitRow {
  id: string;
  job_number: number | null;
  title: string | null;
  job_type: string | null;
  contract_total: number | null;
  total_expenses: number | null;
}

async function buildProfitabilitySection(env: Env, year: string): Promise<string[]> {
  const lines: string[] = ["--- JOB PROFITABILITY SUMMARY ---"];
  lines.push(row("Job #", "Title", "Type", "Contract Total", "Total Expenses", "Gross Profit", "Margin %"));

  const jobRows = (
    await env.DB.prepare(
      `SELECT j.id, j.job_number, j.title, j.job_type,
              COALESCE(j.contract_total, j.total, 0) AS contract_total,
              COALESCE(SUM(e.amount), 0) AS total_expenses
       FROM jobs j
       LEFT JOIN expenses e ON e.job_id = j.id
         AND (e.is_active IS NULL OR e.is_active != 0)
       WHERE strftime('%Y', j.created_at) = ?
         AND ${notTestClientExists("j.client_id")}
       GROUP BY j.id
       HAVING j.id IN (
         SELECT DISTINCT job_id FROM payments
         WHERE strftime('%Y', COALESCE(received_date, collected_at, created_at)) = ?
       )
       ORDER BY j.job_number ASC`,
    )
      .bind(year, year)
      .all<JobProfitRow>()
  ).results ?? [];

  for (const j of jobRows) {
    const contract = j.contract_total ?? 0;
    const expenses = j.total_expenses ?? 0;
    const profit = contract - expenses;
    const margin = contract > 0 ? ((profit / contract) * 100).toFixed(1) + "%" : "N/A";
    const jobNum = j.job_number ? `JOB-${String(j.job_number).padStart(3, "0")}` : j.id.slice(0, 8);
    lines.push(row(jobNum, j.title, j.job_type, fmt(contract), fmt(expenses), fmt(profit), margin));
  }

  if (jobRows.length === 0) {
    lines.push(row("No jobs with payments found for this year", "", "", "", "", "", ""));
  }

  return lines;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function handleCpaExport(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, ["owner"]);
  if (guarded instanceof Response) return guarded;

  const url = new URL(request.url);
  const yearParam = url.searchParams.get("year");
  const year = yearParam
    ? String(parseInt(yearParam, 10))
    : String(new Date().getFullYear());

  const sections = await Promise.all([
    buildIncomeSection(env, year),
    buildExpenseSection(env, year),
    buildSubcontractorSection(env, year),
    buildMileageSection(env, year),
    buildProfitabilitySection(env, year),
  ]);

  const csvLines: string[] = [
    `CHS CPA Export — Tax Year ${year}`,
    `Generated: ${new Date().toISOString()}`,
    "",
  ];

  for (const section of sections) {
    csvLines.push(...section);
    csvLines.push("", "");
  }

  const csv = csvLines.join("\r\n");

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="chs-cpa-export-${year}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

// ── Financial dashboard reports (owner-only JSON) ───────────────────────────

const CLIENT_NAME_SQL =
  "COALESCE(NULLIF(TRIM(c.first_name || ' ' || c.last_name), ''), c.name) AS client_name";

function reportJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function reportErr(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type AgingBucket = "current" | "days_1_30" | "days_31_60" | "days_61_90" | "days_90_plus";

function agingBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "days_1_30";
  if (daysOverdue <= 60) return "days_31_60";
  if (daysOverdue <= 90) return "days_61_90";
  return "days_90_plus";
}

export async function handleAgedReceivables(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, ["owner"]);
  if (guarded instanceof Response) return guarded;

  const rows = (
    await env.DB.prepare(
      `SELECT i.id, i.invoice_number, i.total_due, i.paid_amount, i.due_date, i.status,
              ${CLIENT_NAME_SQL},
              j.job_number, j.title AS job_title,
              CAST(julianday('now') - julianday(i.due_date) AS INTEGER) AS days_overdue
       FROM invoices i
       JOIN jobs j ON i.job_id = j.id
       JOIN clients c ON j.client_id = c.id
       WHERE i.status IN ('sent', 'viewed', 'partial', 'past_due')
         AND (${NON_TEST_CLIENT})
       ORDER BY days_overdue DESC`,
    ).all<{
      id: string;
      invoice_number: number | null;
      total_due: number;
      paid_amount: number | null;
      due_date: string;
      status: string;
      client_name: string;
      job_number: number | null;
      job_title: string | null;
      days_overdue: number;
    }>()
  ).results ?? [];

  const summary = {
    current: { count: 0, total: 0 },
    days_1_30: { count: 0, total: 0 },
    days_31_60: { count: 0, total: 0 },
    days_61_90: { count: 0, total: 0 },
    days_90_plus: { count: 0, total: 0 },
    grand_total: 0,
  };

  const invoices = rows.map((r) => {
    const balance = (r.total_due ?? 0) - (r.paid_amount ?? 0);
    const bucket = agingBucket(r.days_overdue ?? 0);
    summary[bucket].count += 1;
    summary[bucket].total += balance;
    summary.grand_total += balance;
    return {
      id: r.id,
      invoice_number: r.invoice_number,
      invoice_display: r.invoice_number ? `INV-${String(r.invoice_number).padStart(4, "0")}` : r.id.slice(0, 8),
      balance_due: balance,
      due_date: r.due_date,
      status: r.status,
      client_name: r.client_name,
      job_number: r.job_number,
      job_title: r.job_title,
      days_overdue: r.days_overdue,
      aging_bucket: bucket,
    };
  });

  return reportJson({ summary, invoices });
}

export async function handleProjectedIncome(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, ["owner"]);
  if (guarded instanceof Response) return guarded;

  const today = new Date();
  const weekEnd = new Date(today);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const todayStr = today.toISOString().slice(0, 10);
  const weekEndStr = weekEnd.toISOString().slice(0, 10);
  const monthEndStr = monthEnd.toISOString().slice(0, 10);

  const rows = (
    await env.DB.prepare(
      `SELECT i.id, i.invoice_number, i.total_due, i.paid_amount, i.due_date, i.status,
              ${CLIENT_NAME_SQL},
              j.job_number, j.title AS job_title
       FROM invoices i
       JOIN jobs j ON i.job_id = j.id
       JOIN clients c ON j.client_id = c.id
       WHERE i.status IN ('draft', 'sent', 'viewed', 'partial')
         AND (${NON_TEST_CLIENT})
       ORDER BY i.due_date ASC`,
    ).all<{
      id: string;
      invoice_number: number | null;
      total_due: number;
      paid_amount: number | null;
      due_date: string | null;
      status: string;
      client_name: string;
      job_number: number | null;
      job_title: string | null;
    }>()
  ).results ?? [];

  let totalProjected = 0;
  let dueThisWeek = 0;
  let dueThisMonth = 0;
  let overdue = 0;

  const invoices = rows.map((r) => {
    const balance = (r.total_due ?? 0) - (r.paid_amount ?? 0);
    totalProjected += balance;
    const due = r.due_date ?? "";
    if (due && due < todayStr) overdue += balance;
    else if (due && due >= todayStr && due <= weekEndStr) dueThisWeek += balance;
    if (due && due >= todayStr && due <= monthEndStr) dueThisMonth += balance;
    return {
      id: r.id,
      invoice_number: r.invoice_number,
      invoice_display: r.invoice_number ? `INV-${String(r.invoice_number).padStart(4, "0")}` : r.id.slice(0, 8),
      balance_due: balance,
      due_date: r.due_date,
      status: r.status,
      client_name: r.client_name,
      job_number: r.job_number,
      job_title: r.job_title,
    };
  });

  return reportJson({
    summary: { total_projected: totalProjected, due_this_week: dueThisWeek, due_this_month: dueThisMonth, overdue },
    invoices,
  });
}

export async function handleClientReengagement(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, ["owner"]);
  if (guarded instanceof Response) return guarded;

  const rows = (
    await env.DB.prepare(
      `SELECT c.id,
              ${CLIENT_NAME_SQL},
              c.email, c.phone,
              MAX(j.actual_end_date) AS last_job_completed,
              COUNT(CASE WHEN j.status = 'complete' THEN j.id END) AS total_jobs,
              COALESCE(SUM(CASE WHEN j.status = 'complete' THEN j.contract_total ELSE 0 END), 0) AS total_revenue
       FROM clients c
       LEFT JOIN jobs j ON j.client_id = c.id AND j.status = 'complete'
       WHERE ${NON_TEST_CLIENT}
       GROUP BY c.id
       HAVING last_job_completed < date('now', '-12 months') OR last_job_completed IS NULL
       ORDER BY last_job_completed DESC`,
    ).all<{
      id: string;
      client_name: string;
      email: string | null;
      phone: string | null;
      last_job_completed: string | null;
      total_jobs: number;
      total_revenue: number;
    }>()
  ).results ?? [];

  let neverConverted = 0;
  let inactive12 = 0;
  for (const r of rows) {
    if (!r.last_job_completed) neverConverted += 1;
    else inactive12 += 1;
  }

  return reportJson({
    summary: { total_clients: rows.length, never_converted: neverConverted, inactive_12_months: inactive12 },
    clients: rows.map((r) => ({
      id: r.id,
      name: r.client_name,
      email: r.email,
      phone: r.phone,
      last_job_completed: r.last_job_completed,
      total_jobs: r.total_jobs,
      total_revenue: r.total_revenue,
    })),
  });
}

export async function handleJobRevenue(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, ["owner"]);
  if (guarded instanceof Response) return guarded;

  const url = new URL(request.url);
  const yearParam = url.searchParams.get("year");
  const year = yearParam ? String(parseInt(yearParam, 10)) : String(new Date().getFullYear());
  if (Number.isNaN(Number(year)) || Number(year) < 2020) {
    return reportErr(400, "Invalid year");
  }

  const rows = (
    await env.DB.prepare(
      `SELECT j.id, j.job_number, j.title,
              ${CLIENT_NAME_SQL},
              j.contract_total, j.status, j.actual_end_date AS completed_date,
              COALESCE(SUM(p.amount), 0) AS total_collected,
              COALESCE(exp.total_expenses, 0) AS total_expenses
       FROM jobs j
       JOIN clients c ON j.client_id = c.id
       LEFT JOIN invoices i ON i.job_id = j.id
       LEFT JOIN payments p ON p.invoice_id = i.id
       LEFT JOIN (
         SELECT job_id, SUM(amount) AS total_expenses
         FROM expenses
         WHERE is_active IS NULL OR is_active != 0
         GROUP BY job_id
       ) exp ON exp.job_id = j.id
       WHERE j.status != 'closed'
         AND strftime('%Y', j.created_at) = ?
         AND (${NON_TEST_CLIENT})
       GROUP BY j.id
       ORDER BY j.actual_end_date DESC`,
    )
      .bind(year)
      .all<{
        id: string;
        job_number: number | null;
        title: string | null;
        client_name: string;
        contract_total: number | null;
        status: string;
        completed_date: string | null;
        total_collected: number;
        total_expenses: number;
      }>()
  ).results ?? [];

  let totalRevenue = 0;
  let totalCollected = 0;
  let totalExpenses = 0;

  const jobs = rows.map((r) => {
    const contract = r.contract_total ?? 0;
    const collected = r.total_collected ?? 0;
    const expenses = r.total_expenses ?? 0;
    const grossProfit = collected - expenses;
    totalRevenue += contract;
    totalCollected += collected;
    totalExpenses += expenses;
    return {
      id: r.id,
      job_number: r.job_number,
      job_display: r.job_number ? `JOB-${String(r.job_number).padStart(3, "0")}` : r.id.slice(0, 8),
      title: r.title,
      client_name: r.client_name,
      contract_value: contract,
      status: r.status,
      completed_date: r.completed_date,
      total_collected: collected,
      total_expenses: expenses,
      gross_profit: grossProfit,
    };
  });

  return reportJson({
    summary: {
      total_revenue: totalRevenue,
      total_collected: totalCollected,
      total_expenses: totalExpenses,
      gross_profit: totalCollected - totalExpenses,
      job_count: jobs.length,
    },
    jobs,
  });
}

// ─── Report 5 — Estimated vs. Actual by Line Item ────────────────────────────
//
// Joins estimate_sub_items → expenses via expenses.estimate_line_item_id to show
// where CHS is consistently over- or under-bidding. Empty at launch (expected —
// data accumulates as receipts are confirmed through the Sprint 37 flow).

interface VarianceRow {
  description: string;
  category: string | null;
  job_count: number;
  avg_estimated: number;
  avg_actual: number | null;
  variance_amount: number | null;
  variance_pct: number | null;
}

export async function handleLineItemVariance(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, ["owner"]);
  if (guarded instanceof Response) return guarded;

  // Group by description for cross-job comparison. SQLite free-text grouping
  // works when estimate builders use consistent names (e.g. "Cabinet install").
  // When descriptions diverge, group by category instead — both variants are
  // surfaced by including category in the output.
  const rows = (
    await env.DB.prepare(
      `SELECT
         esi.description,
         esi.category,
         COUNT(DISTINCT e_job.id) AS job_count,
         AVG(esi.total_cost) AS avg_estimated,
         AVG(actual.total_actual) AS avg_actual,
         AVG(actual.total_actual) - AVG(esi.total_cost) AS variance_amount,
         ROUND(
           (AVG(actual.total_actual) - AVG(esi.total_cost)) /
           NULLIF(AVG(esi.total_cost), 0) * 100,
           1
         ) AS variance_pct
       FROM estimate_sub_items esi
       JOIN estimate_line_items eli ON eli.id = esi.parent_line_item_id
       JOIN estimates e_job ON e_job.id = eli.estimate_id
       LEFT JOIN (
         SELECT estimate_line_item_id, SUM(amount) AS total_actual
         FROM expenses
         WHERE estimate_line_item_id IS NOT NULL
           AND (is_active IS NULL OR is_active != 0)
         GROUP BY estimate_line_item_id
       ) actual ON actual.estimate_line_item_id = esi.id
       WHERE actual.total_actual IS NOT NULL
         AND ${notTestClientExists("e_job.client_id")}
       GROUP BY esi.description
       HAVING job_count >= 1
       ORDER BY ABS(variance_amount) DESC`,
    ).all<VarianceRow>()
  ).results ?? [];

  const items = rows.map((r) => ({
    description: r.description,
    category: r.category,
    job_count: r.job_count,
    avg_estimated: r.avg_estimated ?? 0,
    avg_actual: r.avg_actual ?? 0,
    variance_amount: r.variance_amount ?? 0,
    variance_pct: r.variance_pct ?? null,
  }));

  return reportJson({
    summary: {
      total_line_items: items.length,
      has_data: items.length > 0,
    },
    items,
  });
}

export async function handleFinancialReports(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (url.pathname === "/api/reports/aged-receivables" && request.method === "GET") {
    return handleAgedReceivables(request, env);
  }
  if (url.pathname === "/api/reports/projected-income" && request.method === "GET") {
    return handleProjectedIncome(request, env);
  }
  if (url.pathname === "/api/reports/client-reengagement" && request.method === "GET") {
    return handleClientReengagement(request, env);
  }
  if (url.pathname === "/api/reports/job-revenue" && request.method === "GET") {
    return handleJobRevenue(request, env);
  }
  if (url.pathname === "/api/reports/line-item-variance" && request.method === "GET") {
    return handleLineItemVariance(request, env);
  }
  return null;
}

// ─── GET /api/financial/pricing-intelligence ─────────────────────────────────

function jsonResp(body: unknown, init: ResponseInit = {}): Response {
  const h = new Headers(init.headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers: h });
}

const CACHE_KEY = "pricing_intelligence_cache";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface PiCacheRow {
  value: string;
  updated_at: string;
}

export async function handlePricingIntelligence(request: Request, env: Env, url: URL): Promise<Response> {
  const guarded = await guard(request, env, ["owner"]);
  if (guarded instanceof Response) return guarded;

  const forceRefresh = url.searchParams.get("refresh") === "true";

  // Check cache (system_settings key) — skip if ?refresh=true.
  if (!forceRefresh) {
    const cached = await env.DB.prepare(
      "SELECT value, updated_at FROM system_settings WHERE key = ?",
    ).bind(CACHE_KEY).first<PiCacheRow>();
    if (cached) {
      const age = Date.now() - new Date(cached.updated_at).getTime();
      if (age < CACHE_TTL_MS) {
        try {
          const parsed = JSON.parse(cached.value) as Record<string, unknown>;
          return jsonResp({ ...parsed, from_cache: true });
        } catch {
          // Corrupt cache — fall through to rebuild.
        }
      }
    }
  }

  // Query aggregate closed-job data.
  const rawRows = await env.DB.prepare(
    `SELECT
       j.id, j.title, j.job_type, j.billing_model, j.contract_total,
       j.actual_end_date, j.created_at,
       COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.job_id = j.id), 0) AS total_paid,
       COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.job_id = j.id), 0) AS total_expenses,
       COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.job_id = j.id AND e.expense_type = 'material'), 0) AS material_cost,
       COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.job_id = j.id AND e.expense_type = 'subcontractor'), 0) AS sub_cost,
       COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.job_id = j.id AND e.expense_type = 'labor'), 0) AS labor_cost,
       COALESCE((SELECT SUM(t.hours * t.hourly_rate) FROM time_entries t WHERE t.job_id = j.id), 0) AS time_entry_labor_cost
     FROM jobs j
     WHERE j.status = 'closed'
       AND j.contract_total IS NOT NULL
       AND j.contract_total > 0
       AND ${notTestClientExists("j.client_id")}
     ORDER BY j.actual_end_date DESC
     LIMIT 100`,
  ).all<{
    id: string;
    title: string | null;
    job_type: string | null;
    billing_model: string | null;
    contract_total: number;
    actual_end_date: string | null;
    created_at: string | null;
    total_paid: number;
    total_expenses: number;
    material_cost: number;
    sub_cost: number;
    labor_cost: number;
    time_entry_labor_cost: number;
  }>();

  const rawJobs = rawRows.results ?? [];

  // Minimum data guard — fewer than 5 closed jobs.
  if (rawJobs.length < 5) {
    return jsonResp({ insufficient_data: true, closed_job_count: rawJobs.length });
  }

  // Compute per-job margin.
  const jobs = rawJobs.map((row) => {
    const revenue = row.total_paid;
    const expenses = row.total_expenses + row.time_entry_labor_cost;
    const profit = revenue - expenses;
    const margin = revenue > 0 ? (profit / revenue) * 100 : null;
    return { ...row, expenses, profit, margin };
  });

  // Aggregate by job_type (groups with >= 2 jobs only).
  const byType: Record<string, { count: number; totalRevenue: number; totalMargin: number; totalContract: number; totalExpenses: number }> = {};
  for (const j of jobs) {
    const t = j.job_type ?? "other";
    if (!byType[t]) byType[t] = { count: 0, totalRevenue: 0, totalMargin: 0, totalContract: 0, totalExpenses: 0 };
    byType[t].count++;
    byType[t].totalRevenue += j.total_paid;
    byType[t].totalMargin += j.margin ?? 0;
    byType[t].totalContract += j.contract_total;
    byType[t].totalExpenses += j.expenses;
  }
  const typeGroups = Object.entries(byType)
    .filter(([, g]) => g.count >= 2)
    .map(([job_type, g]) => ({
      job_type,
      count: g.count,
      avg_margin: Math.round((g.totalMargin / g.count) * 10) / 10,
      avg_contract: Math.round(g.totalContract / g.count),
      avg_expenses: Math.round(g.totalExpenses / g.count),
      total_revenue: Math.round(g.totalRevenue),
    }))
    .sort((a, b) => b.avg_margin - a.avg_margin);

  // Top/bottom 5 by margin.
  const sorted = [...jobs].filter((j) => j.margin !== null).sort((a, b) => (b.margin ?? 0) - (a.margin ?? 0));
  const top5 = sorted.slice(0, 5).map((j) => ({
    id: j.id, title: j.title, job_type: j.job_type,
    contract_total: j.contract_total, margin: Math.round((j.margin ?? 0) * 10) / 10,
  }));
  const bottom5 = sorted.slice(-5).reverse().map((j) => ({
    id: j.id, title: j.title, job_type: j.job_type,
    contract_total: j.contract_total, margin: Math.round((j.margin ?? 0) * 10) / 10,
  }));

  const dates = rawJobs.map((j) => j.actual_end_date ?? j.created_at ?? "").filter(Boolean).sort();
  const earliest = dates[0] ?? "—";
  const latest = dates[dates.length - 1] ?? "—";

  const userPrompt = `CHS Hub — Pricing Intelligence Analysis
Total closed jobs analyzed: ${jobs.length}
Date range: ${earliest} to ${latest}

By job type (sorted by avg margin):
${typeGroups.map((g) => `  - ${g.job_type}: ${g.count} jobs, avg contract $${g.avg_contract}, avg margin ${g.avg_margin}%, avg expenses $${g.avg_expenses}`).join("\n")}

Top 5 most profitable jobs:
${top5.map((j) => `  - ${j.title} (${j.job_type}): contract $${j.contract_total}, margin ${j.margin}%`).join("\n")}

Bottom 5 least profitable jobs:
${bottom5.map((j) => `  - ${j.title} (${j.job_type}): contract $${j.contract_total}, margin ${j.margin}%`).join("\n")}

Return JSON:
{
  "headline": "1-sentence summary of overall business health",
  "overall_avg_margin": number,
  "by_job_type": [
    {
      "job_type": string,
      "job_count": number,
      "avg_margin": number,
      "avg_contract": number,
      "health": "strong" | "fair" | "weak",
      "note": string
    }
  ],
  "recommendations": [
    {
      "priority": "high" | "medium",
      "title": string,
      "rationale": string,
      "suggested_adjustment": string | null
    }
  ],
  "watch_items": [string]
}

health: strong >= 30%, fair 15-30%, weak < 15%.
Keep recommendations specific and actionable. Use the actual numbers.`;

  const aiResult = await claudeMessages(env, {
    system:
      "You are a construction business analyst. Analyze job profitability data and produce actionable pricing recommendations. Return ONLY valid JSON.",
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 2048,
  });

  if (!aiResult.ok || !aiResult.text) {
    return jsonResp({ error: "ai_unavailable", message: "AI analysis failed. Try refreshing." }, { status: 500 });
  }

  const parsed = extractJson<Record<string, unknown>>(aiResult.text);
  if (!parsed) {
    return jsonResp({ error: "ai_parse_error", message: "Could not parse AI response. Try refreshing." }, { status: 500 });
  }

  const generatedAt = new Date().toISOString();
  const responseData = {
    ...parsed,
    generated_at: generatedAt,
    job_count: jobs.length,
    raw_jobs: jobs.map((j) => ({
      id: j.id,
      title: j.title,
      job_type: j.job_type,
      contract_total: j.contract_total,
      total_expenses: Math.round(j.expenses * 100) / 100,
      margin: j.margin !== null ? Math.round(j.margin * 10) / 10 : null,
    })),
    from_cache: false,
  };

  // Store in system_settings cache.
  const nowIso = new Date().toISOString();
  const cacheValue = JSON.stringify(responseData);
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, value_type, category, label, updated_at)
       VALUES (?, ?, 'json', 'financial', 'Pricing Intelligence Cache', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(CACHE_KEY, cacheValue, nowIso).run();

  return jsonResp(responseData);
}

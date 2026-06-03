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

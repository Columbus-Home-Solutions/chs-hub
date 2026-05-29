/**
 * Jobs View endpoints.
 *
 *   GET /api/jobs            — list with filters + per-job rollups
 *   GET /api/jobs/:id        — drill-down: line items, invoices, payments,
 *                              expenses, and the full profit waterfall
 *
 * The list endpoint is heavily joined because the Jobs View is meant to
 * replace the user's old "Job Tracker" Google Sheet — every column that
 * was in that sheet needs to be available here without a second round-trip.
 */

import type { Env } from "../env.js";

/** Normalized to lower-case in SQL. Used by `/api/jobs?status=open` and Files “All” to match active jobs only. */
export const OPEN_JOB_STATUSES = [
  "late",
  "action_required",
  "requires_invoicing",
  "upcoming",
  "on_the_way",
  "active",
  "in_progress",
];

export interface JobRow {
  id: string;
  job_number: number | null;
  title: string | null;
  status: string | null;
  client_id: string | null;
  client_name: string | null;
  source: string | null;
  created_at: string | null;
  start_at: string | null;
  synced_at: string | null;
  completed_at: string | null;
  total: number; // job.total from Jobber
  invoiced: number; // SUM(invoices.total) excluding BAD_DEBT
  paid: number; // SUM(payments.amount)
  outstanding: number; // invoiced − paid (not negative)
  line_item_cost: number; // SUM(li.qty × li.unit_cost)
  expense_cost: number; // SUM(expenses.amount) for this job
  profit: number; // invoiced − line_item_cost − expense_cost
  margin_pct: number; // profit / invoiced × 100
  line_item_count: number;
  needs_costing: 0 | 1; // 1 if any line item is missing unit_cost
  needs_costing_priced: number; // $ value at risk from missing costs
  photo_count: number; // count of /api/photos rows attached to this job
}

export async function handleJobsList(env: Env, url: URL): Promise<{
  as_of: string;
  total: number;
  jobs: JobRow[];
}> {
  const status = url.searchParams.get("status"); // "open" | "archived" | "closed" | specific status | null
  const sinceStr = url.searchParams.get("since"); // ISO date (created_at >=)
  const untilStr = url.searchParams.get("until"); // ISO date (created_at <)
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();

  // Build the big rollup query once; filter in JS for flexibility.
  // SQLite LEFT JOINs + subqueries give us every computed column in one round.
  const rows = await env.DB.prepare(
    `SELECT
       j.id,
       j.job_number,
       j.title,
       j.status,
       j.client_id,
       c.name AS client_name,
       j.source,
       j.created_at,
       j.start_at,
       j.synced_at,
       j.completed_at,
       COALESCE(j.total, 0) AS total,
       COALESCE((
         SELECT SUM(COALESCE(inv.total, 0))
         FROM invoices inv
         WHERE inv.job_id = j.id
           AND UPPER(COALESCE(inv.status, '')) != 'BAD_DEBT'
       ), 0) AS invoiced,
       COALESCE((
         SELECT SUM(COALESCE(p.amount, 0))
         FROM payments p
         WHERE p.job_id = j.id
       ), 0) AS paid,
       COALESCE((
         SELECT SUM(COALESCE(li.quantity, 0) * COALESCE(li.unit_cost, 0))
         FROM line_items li
         WHERE li.job_id = j.id
       ), 0) AS line_item_cost,
       COALESCE((
         SELECT SUM(COALESCE(e.amount, 0))
         FROM expenses e
         WHERE e.job_id = j.id
       ), 0) AS expense_cost,
       (
         SELECT COUNT(*) FROM line_items li WHERE li.job_id = j.id
       ) AS line_item_count,
       (
         SELECT COUNT(*) FROM line_items li
         WHERE li.job_id = j.id
           AND COALESCE(li.unit_cost, 0) = 0
       ) AS needs_costing_count,
       COALESCE((
         SELECT SUM(COALESCE(li.quantity, 0) * COALESCE(li.unit_price, 0))
         FROM line_items li
         WHERE li.job_id = j.id
           AND COALESCE(li.unit_cost, 0) = 0
       ), 0) AS needs_costing_priced,
       (
         SELECT COUNT(*) FROM photos ph WHERE ph.job_id = j.id
       ) AS photo_count
     FROM jobs j
     LEFT JOIN clients c ON c.id = j.client_id`,
  ).all<{
    id: string;
    job_number: number | null;
    title: string | null;
    status: string | null;
    client_id: string | null;
    client_name: string | null;
    source: string | null;
    created_at: string | null;
    start_at: string | null;
    synced_at: string | null;
    completed_at: string | null;
    total: number;
    invoiced: number;
    paid: number;
    line_item_cost: number;
    expense_cost: number;
    line_item_count: number;
    needs_costing_count: number;
    needs_costing_priced: number;
    photo_count: number;
  }>();

  let jobs: JobRow[] = (rows.results ?? []).map((r) => {
    const outstanding = Math.max(0, r.invoiced - r.paid);
    const profit = r.invoiced - r.line_item_cost - r.expense_cost;
    const margin = r.invoiced > 0 ? (profit / r.invoiced) * 100 : 0;
    return {
      id: r.id,
      job_number: r.job_number,
      title: r.title,
      status: r.status,
      client_id: r.client_id,
      client_name: r.client_name,
      source: r.source,
      created_at: r.created_at,
      start_at: r.start_at,
      synced_at: r.synced_at,
      completed_at: r.completed_at,
      total: round2(r.total),
      invoiced: round2(r.invoiced),
      paid: round2(r.paid),
      outstanding: round2(outstanding),
      line_item_cost: round2(r.line_item_cost),
      expense_cost: round2(r.expense_cost),
      profit: round2(profit),
      margin_pct: round1(margin),
      line_item_count: r.line_item_count,
      needs_costing: r.needs_costing_count > 0 ? 1 : 0,
      needs_costing_priced: round2(r.needs_costing_priced),
      photo_count: r.photo_count,
    };
  });

  // ── Filters (applied in-memory; 84 jobs × ~20 fields is trivial) ────
  if (status === "open") {
    jobs = jobs.filter((j) =>
      OPEN_JOB_STATUSES.includes(String(j.status ?? "").toLowerCase()),
    );
  } else if (status === "archived") {
    jobs = jobs.filter((j) => String(j.status ?? "").toLowerCase() === "archived");
  } else if (status === "closed") {
    // Not in the active / pipeline set — e.g. completed, cancelled, closed (Hub Files tree “Archived”).
    jobs = jobs.filter((j) => {
      const s = String(j.status ?? "").toLowerCase();
      return s.length > 0 && !OPEN_JOB_STATUSES.includes(s);
    });
  } else if (status) {
    jobs = jobs.filter((j) => String(j.status ?? "").toLowerCase() === status.toLowerCase());
  }

  if (sinceStr) {
    jobs = jobs.filter((j) => (j.created_at ?? "") >= sinceStr);
  }
  if (untilStr) {
    jobs = jobs.filter((j) => (j.created_at ?? "") < untilStr);
  }
  if (q) {
    jobs = jobs.filter((j) => {
      const hay = [
        j.title ?? "",
        j.client_name ?? "",
        j.job_number ? `#${j.job_number}` : "",
        j.status ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  // Default sort: newest first.
  jobs.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));

  return {
    as_of: new Date().toISOString(),
    total: jobs.length,
    jobs,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Drill-down: GET /api/jobs/:id
// ────────────────────────────────────────────────────────────────────────

export async function handleJobDetail(
  env: Env,
  jobId: string,
): Promise<unknown> {
  const job = await env.DB.prepare(
    `SELECT
       j.id, j.job_number, j.title, j.status, j.source,
       j.total, j.created_at, j.start_at, j.completed_at,
       j.client_id, c.name AS client_name,
       c.phone AS client_phone, c.email AS client_email,
       c.address_street, c.address_city, c.address_state, c.address_postal
     FROM jobs j
     LEFT JOIN clients c ON c.id = j.client_id
     WHERE j.id = ?`,
  )
    .bind(jobId)
    .first<Record<string, unknown>>();

  if (!job) {
    throw Object.assign(new Error(`job ${jobId} not found`), { code: 404 });
  }

  const lineItems = await env.DB.prepare(
    `SELECT id, name, quantity, unit_price, unit_cost,
            COALESCE(quantity, 0) * COALESCE(unit_price, 0) AS priced,
            COALESCE(quantity, 0) * COALESCE(unit_cost, 0) AS cost
     FROM line_items
     WHERE job_id = ?
     ORDER BY id`,
  )
    .bind(jobId)
    .all<Record<string, unknown>>();

  const invoices = await env.DB.prepare(
    `SELECT id, status, total, payments_total, issued_date, due_date
     FROM invoices
     WHERE job_id = ?
     ORDER BY issued_date DESC`,
  )
    .bind(jobId)
    .all<Record<string, unknown>>();

  const payments = await env.DB.prepare(
    `SELECT id, invoice_id, amount, collected_at
     FROM payments
     WHERE job_id = ?
     ORDER BY collected_at DESC`,
  )
    .bind(jobId)
    .all<Record<string, unknown>>();

  const expenses = await env.DB.prepare(
    `SELECT id, description, amount, incurred_at,
            vendor, receipt_r2_key, entered_via,
            pushed_to_jobber_at, jobber_id
     FROM expenses
     WHERE job_id = ?
     ORDER BY incurred_at DESC`,
  )
    .bind(jobId)
    .all<Record<string, unknown>>();

  // Profit waterfall: invoiced − line item cost − expenses
  const liCost = (lineItems.results ?? []).reduce(
    (s: number, li: Record<string, unknown>) => s + Number(li.cost ?? 0),
    0,
  );
  const expCost = (expenses.results ?? []).reduce(
    (s: number, e: Record<string, unknown>) => s + Number(e.amount ?? 0),
    0,
  );
  const invoiced = (invoices.results ?? [])
    .filter((inv: Record<string, unknown>) => String(inv.status ?? "").toUpperCase() !== "BAD_DEBT")
    .reduce((s: number, inv: Record<string, unknown>) => s + Number(inv.total ?? 0), 0);
  const paid = (payments.results ?? []).reduce(
    (s: number, p: Record<string, unknown>) => s + Number(p.amount ?? 0),
    0,
  );
  const profit = invoiced - liCost - expCost;

  return {
    as_of: new Date().toISOString(),
    job,
    line_items: lineItems.results ?? [],
    invoices: invoices.results ?? [],
    payments: payments.results ?? [],
    expenses: expenses.results ?? [],
    waterfall: {
      invoiced: round2(invoiced),
      paid: round2(paid),
      outstanding: round2(Math.max(0, invoiced - paid)),
      line_item_cost: round2(liCost),
      expense_cost: round2(expCost),
      profit: round2(profit),
      margin_pct: invoiced > 0 ? round1((profit / invoiced) * 100) : 0,
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

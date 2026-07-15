/**
 * Job costing — budget vs. actual roll-up (Sprint 10).
 *
 * BUDGET baseline comes from the job's source estimate:
 *   estimate_sub_items.total_cost  (internal cost lines: material / labor /
 *   subcontractor / permit / equipment / other) rolled up to their parent
 *   estimate_line_items (the client-facing trades).
 *
 * ACTUAL comes from three sources, aligned to the same parents:
 *   1. expenses aligned via expenses.estimate_line_item_id
 *   2. time-entry labor_cost (the source of truth for labor — see below)
 *   3. subcontractor expenses (expense_type='subcontractor') — these are just
 *      expenses and roll up like any other aligned expense.
 *
 * ALIGNMENT GRANULARITY (Open Question 1):
 *   expenses.estimate_line_item_id is a single FK column. We let it hold EITHER
 *   a sub_item id (most specific) OR a parent line_item id (parent-only
 *   alignment). At roll-up we resolve it:
 *     - id ∈ estimate_sub_items  → attribute to that sub-item AND its parent
 *     - id ∈ estimate_line_items → attribute to that parent (no sub granularity)
 *     - otherwise / NULL         → Unallocated bucket
 *
 * LABOR SOURCE (Open Question 2):
 *   Time entries are the SOURCE OF TRUTH for labor. Their labor_cost is summed
 *   at the JOB level (time entries carry no line-item alignment) and surfaced as
 *   a dedicated "Labor (time tracking)" actuals figure — never folded into a
 *   line item that might also carry a `labor` expense, so labor is never double
 *   counted. A manually-logged expense_type='labor' is still allowed (e.g. a
 *   cash day-labor payment that wasn't clocked) and aligns/rolls up like any
 *   other expense; the UI hints that time tracking is preferred.
 *
 * This module is intentionally a reusable HELPER: Sprint 11 cost-plus
 * reconciliation needs the exact same "actuals in a date range" computation, so
 * {@link computeJobActuals} accepts an optional date window and returns raw maps
 * the cycle engine can reuse without going through the HTTP costing endpoint.
 */

import type { Env } from "../env.js";

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** One estimate parent line item allocated to a billing cycle at a percentage. */
export interface ScopeAllocation {
  line_item_id: string;
  percentage: number;
}

export function parseScopeAllocations(raw: string | null | undefined): ScopeAllocation[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: ScopeAllocation[] = [];
    for (const x of arr) {
      if (typeof x !== "object" || x === null) continue;
      const lineItemId = (x as { line_item_id?: unknown }).line_item_id;
      const pct = Number((x as { percentage?: unknown }).percentage);
      if (typeof lineItemId !== "string" || !Number.isFinite(pct)) continue;
      out.push({ line_item_id: lineItemId, percentage: pct });
    }
    return out;
  } catch {
    return [];
  }
}

/** Sum percentages per line item across cycles (optionally excluding one cycle). */
export function cumulativeScopeAllocations(
  cycles: { id: string; scope_allocations: string | null | undefined }[],
  excludeCycleId?: string,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of cycles) {
    if (excludeCycleId && c.id === excludeCycleId) continue;
    for (const a of parseScopeAllocations(c.scope_allocations)) {
      map.set(a.line_item_id, round2((map.get(a.line_item_id) ?? 0) + a.percentage));
    }
  }
  return map;
}

export interface CategoryProjection {
  materials: number;
  labor: number;
  subs: number;
}

/**
 * Roll up estimate sub-item budgets into Materials / Labor / Subs, scaled by
 * each parent line item's cycle percentage. Reuses the same sub-item budgets
 * computed in {@link buildJobCosting}.
 *
 * Bucket rules:
 *   material → materials
 *   labor → labor
 *   subcontractor → subs
 *   permit, equipment, other → materials (simplest default bucket)
 */
export function projectedCostsFromScope(
  lines: Pick<CostingLine, "line_item_id" | "sub_items">[],
  allocations: ScopeAllocation[],
): CategoryProjection {
  const pctByLine = new Map(
    allocations.map((a) => [a.line_item_id, Math.max(0, a.percentage) / 100]),
  );
  let materials = 0;
  let labor = 0;
  let subs = 0;
  for (const line of lines) {
    const factor = pctByLine.get(line.line_item_id);
    if (!factor) continue;
    for (const sub of line.sub_items) {
      const scaled = round2(sub.budget * factor);
      const cat = (sub.category ?? "").toLowerCase();
      if (cat === "labor") labor = round2(labor + scaled);
      else if (cat === "subcontractor") subs = round2(subs + scaled);
      else materials = round2(materials + scaled);
    }
  }
  return { materials, labor, subs };
}

export interface CostingActuals {
  /** parent line_item id → actual $ from aligned (non-void) expenses */
  byParent: Map<string, number>;
  /** sub_item id → actual $ from expenses aligned at sub-item granularity */
  bySubItem: Map<string, number>;
  /** expenses with no resolvable line-item alignment */
  unallocated: number;
  /** Σ time_entries.labor_cost (closed entries only) — job-level labor */
  laborFromTime: number;
  /** Σ non-void expense amounts (all types) */
  totalExpenses: number;
  /** Σ non-void subcontractor expense amounts */
  subExpenses: number;
}

export interface ActualsWindow {
  /** inclusive lower bound on expense.incurred_date / time clock_in (YYYY-MM-DD) */
  from?: string | null;
  /** inclusive upper bound (YYYY-MM-DD) */
  to?: string | null;
}

interface ExpenseActualRow {
  amount: number | null;
  expense_type: string | null;
  align: string | null;
}
interface TimeRow {
  labor_cost: number | null;
}

/**
 * Resolve a job to its source estimate id (jobs are only ever created via
 * quote→job conversion, so this is the budget baseline).
 */
export async function resolveEstimateId(env: Env, jobId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT estimate_id FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ estimate_id: string | null }>();
  return row?.estimate_id ?? null;
}

/**
 * Compute raw job actuals. Reusable by the costing endpoint AND (Sprint 11) the
 * cost-plus cycle reconciliation, which passes a date window.
 */
export async function computeJobActuals(
  env: Env,
  jobId: string,
  window: ActualsWindow = {},
): Promise<CostingActuals> {
  // Maps of valid alignment targets for this job's estimate.
  const estimateId = await resolveEstimateId(env, jobId);
  const parentIds = new Set<string>();
  const subToParent = new Map<string, string>();
  if (estimateId) {
    const lineItems = (
      await env.DB.prepare("SELECT id FROM estimate_line_items WHERE estimate_id = ?")
        .bind(estimateId)
        .all<{ id: string }>()
    ).results ?? [];
    for (const li of lineItems) parentIds.add(li.id);
    if (lineItems.length) {
      const subs = (
        await env.DB.prepare(
          `SELECT id, parent_line_item_id FROM estimate_sub_items
           WHERE parent_line_item_id IN (${lineItems.map(() => "?").join(",")})`,
        )
          .bind(...lineItems.map((l) => l.id))
          .all<{ id: string; parent_line_item_id: string }>()
      ).results ?? [];
      for (const s of subs) subToParent.set(s.id, s.parent_line_item_id);
    }
  }

  // Expenses (non-void only — voided rows are preserved but excluded, rule #13).
  const where: string[] = ["job_id = ?", "COALESCE(is_active, 1) = 1"];
  const binds: unknown[] = [jobId];
  if (window.from) {
    where.push("COALESCE(incurred_date, incurred_at) >= ?");
    binds.push(window.from);
  }
  if (window.to) {
    where.push("COALESCE(incurred_date, incurred_at) <= ?");
    binds.push(window.to);
  }
  const expenses = (
    await env.DB.prepare(
      `SELECT amount, expense_type, estimate_line_item_id AS align
       FROM expenses WHERE ${where.join(" AND ")}`,
    )
      .bind(...binds)
      .all<ExpenseActualRow>()
  ).results ?? [];

  const byParent = new Map<string, number>();
  const bySubItem = new Map<string, number>();
  let unallocated = 0;
  let totalExpenses = 0;
  let subExpenses = 0;

  const add = (m: Map<string, number>, k: string, v: number) =>
    m.set(k, round2((m.get(k) ?? 0) + v));

  for (const e of expenses) {
    const amt = Number(e.amount) || 0;
    totalExpenses = round2(totalExpenses + amt);
    if (e.expense_type === "subcontractor") subExpenses = round2(subExpenses + amt);

    const align = e.align;
    if (align && subToParent.has(align)) {
      add(bySubItem, align, amt);
      add(byParent, subToParent.get(align)!, amt);
    } else if (align && parentIds.has(align)) {
      add(byParent, align, amt);
    } else {
      unallocated = round2(unallocated + amt);
    }
  }

  // Time-entry labor (closed entries carry labor_cost). Window on clock_in.
  const twhere: string[] = ["job_id = ?", "clock_out IS NOT NULL"];
  const tbinds: unknown[] = [jobId];
  if (window.from) {
    twhere.push("clock_in >= ?");
    tbinds.push(window.from);
  }
  if (window.to) {
    twhere.push("clock_in <= ?");
    tbinds.push(`${window.to}T23:59:59Z`);
  }
  const times = (
    await env.DB.prepare(
      `SELECT labor_cost FROM time_entries WHERE ${twhere.join(" AND ")}`,
    )
      .bind(...tbinds)
      .all<TimeRow>()
  ).results ?? [];
  let laborFromTime = 0;
  for (const t of times) laborFromTime = round2(laborFromTime + (Number(t.labor_cost) || 0));

  return { byParent, bySubItem, unallocated, laborFromTime, totalExpenses, subExpenses };
}

export type VarianceStatus = "under" | "within" | "over";

/** Color/status logic: over budget = red; within ~10% of budget = yellow; else green. */
export function varianceStatus(budget: number, actual: number): VarianceStatus {
  if (actual > budget) return "over";
  if (budget > 0 && actual >= budget * 0.9) return "within";
  return "under";
}

interface LineItemRow {
  id: string;
  product_service: string | null;
  description: string | null;
  sort_order: number;
}
interface SubItemRow {
  id: string;
  parent_line_item_id: string;
  description: string | null;
  category: string;
  quantity: number | null;
  unit: string | null;
  unit_cost: number | null;
  total_cost: number | null;
  sort_order: number;
}

export interface CostingSubLine {
  id: string;
  description: string | null;
  category: string;
  budget: number;
  actual: number;
  variance: number;
  status: VarianceStatus;
}
export interface CostingLine {
  line_item_id: string;
  name: string;
  budget: number;
  actual: number;
  variance: number;
  status: VarianceStatus;
  sub_items: CostingSubLine[];
}
export interface JobCosting {
  job_id: string;
  estimate_id: string | null;
  has_budget: boolean;
  lines: CostingLine[];
  labor_from_time: number;
  unallocated: number;
  totals: {
    budget: number;
    actual: number;
    variance: number;
    status: VarianceStatus;
  };
}

/**
 * Build the full budget-vs-actual structure for the costing endpoint + the
 * Financial tab table.
 */
export async function buildJobCosting(env: Env, jobId: string): Promise<JobCosting> {
  const estimateId = await resolveEstimateId(env, jobId);
  const actuals = await computeJobActuals(env, jobId);

  let lineItems: LineItemRow[] = [];
  let subItems: SubItemRow[] = [];
  if (estimateId) {
    lineItems =
      (
        await env.DB.prepare(
          "SELECT id, product_service, description, sort_order FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order ASC",
        )
          .bind(estimateId)
          .all<LineItemRow>()
      ).results ?? [];
    if (lineItems.length) {
      subItems =
        (
          await env.DB.prepare(
            `SELECT id, parent_line_item_id, description, category, quantity, unit, unit_cost, total_cost, sort_order
             FROM estimate_sub_items WHERE parent_line_item_id IN (${lineItems.map(() => "?").join(",")})
             ORDER BY sort_order ASC`,
          )
            .bind(...lineItems.map((l) => l.id))
            .all<SubItemRow>()
        ).results ?? [];
    }
  }

  const lines: CostingLine[] = lineItems.map((li) => {
    const subs = subItems.filter((s) => s.parent_line_item_id === li.id);
    const subLines: CostingSubLine[] = subs.map((s) => {
      const budget = round2(
        s.total_cost != null ? s.total_cost : (s.quantity ?? 0) * (s.unit_cost ?? 0),
      );
      const actual = round2(actuals.bySubItem.get(s.id) ?? 0);
      return {
        id: s.id,
        description: s.description,
        category: s.category,
        budget,
        actual,
        variance: round2(budget - actual),
        status: varianceStatus(budget, actual),
      };
    });
    const budget = round2(subLines.reduce((a, s) => a + s.budget, 0));
    const actual = round2(actuals.byParent.get(li.id) ?? 0);
    return {
      line_item_id: li.id,
      name: li.product_service ?? li.description ?? "Line item",
      budget,
      actual,
      variance: round2(budget - actual),
      status: varianceStatus(budget, actual),
      sub_items: subLines,
    };
  });

  const budgetTotal = round2(lines.reduce((a, l) => a + l.budget, 0));
  // Total actual = every non-void expense (aligned + unallocated) + labor from
  // time entries. (byParent + unallocated already sums all expenses.)
  const actualTotal = round2(actuals.totalExpenses + actuals.laborFromTime);

  return {
    job_id: jobId,
    estimate_id: estimateId,
    has_budget: lines.length > 0,
    lines,
    labor_from_time: actuals.laborFromTime,
    unallocated: actuals.unallocated,
    totals: {
      budget: budgetTotal,
      actual: actualTotal,
      variance: round2(budgetTotal - actualTotal),
      status: varianceStatus(budgetTotal, actualTotal),
    },
  };
}

/** YTD operating costs for dashboard profit KPI (matches per-job costing sources). */
export interface YtdOperatingCosts {
  /** Non-void job expenses (materials, subs, fuel, manual labor, etc.). */
  expenses: number;
  /** Closed time-entry labor_cost (separate from expense rows — see computeJobActuals). */
  labor_from_time: number;
  /** Stripe processing fees on collected payments. */
  stripe_fees: number;
  /** expenses + labor_from_time + stripe_fees */
  total_cogs: number;
}

export async function computeYtdOperatingCosts(
  env: Env,
  yearStartDate: string,
): Promise<YtdOperatingCosts> {
  const [expRow, laborRow, feeRow] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS v FROM expenses
       WHERE COALESCE(incurred_date, incurred_at) >= ?
         AND COALESCE(is_active, 1) = 1`,
    )
      .bind(yearStartDate)
      .first<{ v: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(labor_cost), 0) AS v FROM time_entries
       WHERE clock_out IS NOT NULL
         AND substr(COALESCE(clock_in, ''), 1, 10) >= ?`,
    )
      .bind(yearStartDate)
      .first<{ v: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(stripe_fee), 0) AS v FROM payments
       WHERE stripe_fee > 0 AND received_date >= ?`,
    )
      .bind(yearStartDate)
      .first<{ v: number }>(),
  ]);

  const expenses = round2(expRow?.v ?? 0);
  const labor_from_time = round2(laborRow?.v ?? 0);
  const stripe_fees = round2(feeRow?.v ?? 0);
  return {
    expenses,
    labor_from_time,
    stripe_fees,
    total_cogs: round2(expenses + labor_from_time + stripe_fees),
  };
}

/** Job COGS only (expenses + labor) — used for accrual/earned margin vs. invoiced revenue. */
export function jobCogsOnly(costs: YtdOperatingCosts): number {
  return round2(costs.expenses + costs.labor_from_time);
}

/** Invoiced revenue YTD (accrual): sent/viewed/partial/past_due/paid, excluding draft & void. */
export async function computeYtdEarnedRevenue(env: Env, yearStartDate: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(COALESCE(total_due, amount, 0)), 0) AS v
     FROM invoices
     WHERE status NOT IN ('draft', 'void')
       AND COALESCE(issued_date, sent_date, created_at) >= ?`,
  )
    .bind(yearStartDate)
    .first<{ v: number }>();
  return round2(row?.v ?? 0);
}

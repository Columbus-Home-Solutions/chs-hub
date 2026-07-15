/**
 * Cost-Plus billing engine (Sprint 11) — the money logic for the bi-weekly
 * billing cycle, kept as a pure, unit-testable library so the route handlers in
 * src/routes/billing-cycles.ts stay thin. This is the correctness-critical part
 * of the system (CHS-Build-Order-Plan: "the most complex single feature").
 *
 * Source of truth for the math is Module-Spec-Financial-Management §5.3 (the
 * worked example) + the CHS-Cost-Plus-Agreement-Template binding terms:
 *
 *   subtotal     = materials + labor + subs        (NO markup on materials/subs)
 *   pm_fee       = subtotal × pm_fee_rate          (default 0.10, per-cycle snapshot)
 *   contractor_fee = subtotal × contractor_fee_rate (default 0.20)
 *   total        = subtotal + pm_fee + contractor_fee
 *
 *   invoice amount (normal cycle)   = projected_total − credit_from_prior
 *   invoice amount (final, upfront) = 50% × projected_total − credit_from_prior
 *
 *   delta          = projected_total − actual_total   (FEE-INCLUSIVE totals)
 *   credit_to_next = delta                            (signed: + under, − over)
 *
 * FEE / CREDIT ORDERING (Open Question 4): fees are computed on the SUBTOTAL;
 * the prior credit is applied to the INVOICE AMOUNT, after fees — a credit is
 * never itself fee-bearing. We express this on the invoice as:
 *   amount          = the gross cycle total (or 50% of it)         [always > 0]
 *   credits_applied = the signed prior credit / reconciliation delta
 *   total_due       = amount + tax + late_fee − credits_applied    (Sprint 9)
 * so a positive credit reduces total_due and a negative credit (a carried
 * overage) increases it — matching the contract's "overage added to the next
 * cycle invoice" without a parallel total_due formula. (Open Question 1: the
 * overage rides the next cycle's signed credit_from_prior; reconciliation_invoice_id
 * is reserved for the FINAL cycle's remaining-50% bill, where there is no next
 * cycle to absorb the delta.)
 *
 * ACTUALS (rule #5 / Open Question 2) come from the Sprint 10 reusable helper
 * computeJobActuals(env, jobId, { from, to }) — NEVER re-derived here. We attribute
 * each actual strictly by date to the cycle whose [period_start, period_end]
 * window contains it; cycles cannot overlap (rule #3) so nothing double-counts,
 * and we surface costs that fall in a gap between cycles as "unattributed".
 */

import type { Env } from "../env.js";
import {
  computeJobActuals,
  fetchPeriodExpenseDetails,
  fetchPeriodTimeEntryDetails,
  type PeriodExpenseDetail,
  type PeriodTimeEntryDetail,
} from "./job-costing.js";
import { getNumericSetting } from "./rates.js";

export function round2(n: number): number {
  return Math.round(((n ?? 0) + Number.EPSILON) * 100) / 100;
}

export interface FeeRates {
  pm_fee_rate: number;
  contractor_fee_rate: number;
}

export interface CategoryCosts {
  materials: number;
  labor: number;
  subs: number;
}

export interface CostBreakdown extends CategoryCosts, FeeRates {
  subtotal: number;
  pm_fee: number;
  contractor_fee: number;
  total: number;
}

/** The fraction of a final cycle billed upfront; the rest is billed at completion. */
export const FINAL_CYCLE_UPFRONT_SPLIT = 0.5;

/**
 * Read the effective fee rates for a NEW cycle. Defaults come from
 * system_settings (pm_fee_rate / contractor_fee_rate, rule #4); a caller may pass
 * explicit per-job overrides. The result is snapshotted onto the billing_cycles
 * row so a later settings change never retroactively alters a closed cycle.
 */
export async function resolveFeeRates(
  env: Env,
  override?: Partial<FeeRates>,
): Promise<FeeRates> {
  const pm =
    override?.pm_fee_rate != null && Number.isFinite(override.pm_fee_rate)
      ? Number(override.pm_fee_rate)
      : await getNumericSetting(env, "pm_fee_rate");
  const contractor =
    override?.contractor_fee_rate != null && Number.isFinite(override.contractor_fee_rate)
      ? Number(override.contractor_fee_rate)
      : await getNumericSetting(env, "contractor_fee_rate");
  return { pm_fee_rate: pm, contractor_fee_rate: contractor };
}

/**
 * Mini-budget / actuals fee calc. Fees apply to the subtotal (materials + labor
 * + subs); total = subtotal + both fees. Used for BOTH the projected mini-budget
 * and the actual reconciliation (same formula, different inputs).
 */
export function computeBreakdown(costs: CategoryCosts, rates: FeeRates): CostBreakdown {
  const materials = round2(costs.materials);
  const labor = round2(costs.labor);
  const subs = round2(costs.subs);
  const subtotal = round2(materials + labor + subs);
  const pm_fee = round2(subtotal * rates.pm_fee_rate);
  const contractor_fee = round2(subtotal * rates.contractor_fee_rate);
  const total = round2(subtotal + pm_fee + contractor_fee);
  return {
    materials,
    labor,
    subs,
    subtotal,
    pm_fee,
    contractor_fee,
    total,
    pm_fee_rate: rates.pm_fee_rate,
    contractor_fee_rate: rates.contractor_fee_rate,
  };
}

/**
 * The gross invoice base + the signed credit that go on the cycle invoice. The
 * Sprint 9 invoice stores `amount` (gross, always > 0) and `credits_applied`
 * (signed) so total_due = amount − credits_applied lands on the net the client
 * owes — matching §5.3's "cycle total − prior credit = invoice amount".
 *
 *   normal cycle  : base = projected_total
 *   final, upfront : base = 50% × projected_total
 *
 * `creditFromPrior` is signed: positive = surplus that reduces the bill,
 * negative = a carried overage that increases it.
 */
export interface InvoiceMath {
  /** gross base for invoices.amount (always > 0 for a valid cycle) */
  amount: number;
  /** signed value for invoices.credits_applied */
  credits_applied: number;
  /** the net the client actually owes (amount − credits_applied) */
  net: number;
}

export function upfrontInvoiceMath(
  projectedTotal: number,
  creditFromPrior: number,
  isFinalCycle: boolean,
): InvoiceMath {
  const base = round2(
    isFinalCycle ? projectedTotal * FINAL_CYCLE_UPFRONT_SPLIT : projectedTotal,
  );
  const credit = round2(creditFromPrior);
  return { amount: base, credits_applied: credit, net: round2(base - credit) };
}

/**
 * The final cycle's remaining-50% bill, netting the final reconciliation. The
 * client has already paid the 50% upfront (net of any prior credit). Billing the
 * remaining 50% less the reconciliation delta makes total billed across the two
 * final invoices equal the actual_total (cost-plus = pay actual cost + fees):
 *
 *   upfront + final = 0.5·P + (0.5·P − delta) = P − delta = P − (P − A) = A
 *
 * where delta = credit_to_next (positive credit reduces the final bill, negative
 * overage adds to it — §5.3 steps 5–6).
 */
export function finalRemainingInvoiceMath(
  projectedTotal: number,
  creditToNext: number,
): InvoiceMath {
  const base = round2(projectedTotal * FINAL_CYCLE_UPFRONT_SPLIT);
  const credit = round2(creditToNext);
  return { amount: base, credits_applied: credit, net: round2(base - credit) };
}

export interface Reconciliation {
  actual: CostBreakdown;
  /** projected_total − actual_total; positive = under budget = credit. */
  delta: number;
  /** = delta (signed). Becomes the next cycle's credit_from_prior. */
  credit_to_next: number;
  /** human label for the report / UI. */
  outcome: "under_budget" | "over_budget" | "on_budget";
}

/**
 * Reconcile a cycle: given projected_total + the period actuals (already pulled
 * from computeJobActuals) + the cycle's snapshotted fee rates, recompute the
 * actual fees/total and the signed delta. Fee rates are the cycle's stored rates
 * (NOT re-read from settings) so a mid-cycle settings change can't move a
 * closed cycle.
 */
export function reconcile(
  projectedTotal: number,
  actualCosts: CategoryCosts,
  rates: FeeRates,
): Reconciliation {
  const actual = computeBreakdown(actualCosts, rates);
  const delta = round2(projectedTotal - actual.total);
  const outcome = delta > 0.005 ? "under_budget" : delta < -0.005 ? "over_budget" : "on_budget";
  return { actual, delta, credit_to_next: delta, outcome };
}

/**
 * Pull the period actuals for a cycle from the Sprint 10 helper and map them to
 * cost-plus categories. We reuse the helper's aggregates verbatim — no parallel
 * re-derivation (rule #5):
 *
 *   subs      = subExpenses        (expense_type='subcontractor')
 *   labor     = laborFromTime      (time entries — the canonical labor source)
 *   materials = totalExpenses − subExpenses   (every other non-void expense)
 *
 * So actual_subtotal = materials + labor + subs = totalExpenses + laborFromTime,
 * which is EXACTLY the Sprint 10 job-costing "actual" total — the money is
 * consistent across the two surfaces. (Edge: a manually-logged expense_type='labor'
 * rolls into materials here rather than labor, since the helper folds labor into
 * time tracking; the SUBTOTAL and TOTAL — what the reconciliation bills on — are
 * unaffected. Voided expenses are already excluded by the helper.)
 */
export async function periodActuals(
  env: Env,
  jobId: string,
  periodStart: string,
  periodEnd: string,
): Promise<CategoryCosts> {
  const a = await computeJobActuals(env, jobId, { from: periodStart, to: periodEnd });
  const subs = round2(a.subExpenses);
  const labor = round2(a.laborFromTime);
  const materials = round2(a.totalExpenses - a.subExpenses);
  return { materials, labor, subs };
}

/**
 * Actuals that fall OUTSIDE every cycle window for a job (Open Question 2: gaps
 * between cycles, or costs logged before the first / after the last cycle). We
 * compute the whole-job actual_total and subtract the sum of each cycle's
 * windowed actual_total; the remainder is "unattributed" and is surfaced (never
 * silently dropped) so the user can widen a cycle window. Because cycles can't
 * overlap, no cost is ever counted in two windows.
 */
export interface UnattributedActuals {
  amount: number;
  has_unattributed: boolean;
}

export async function unattributedActuals(
  env: Env,
  jobId: string,
  windows: { period_start: string; period_end: string }[],
): Promise<UnattributedActuals> {
  const whole = await computeJobActuals(env, jobId);
  const wholeTotal = round2(whole.totalExpenses + whole.laborFromTime);
  let attributed = 0;
  for (const w of windows) {
    const a = await computeJobActuals(env, jobId, { from: w.period_start, to: w.period_end });
    attributed = round2(attributed + a.totalExpenses + a.laborFromTime);
  }
  const amount = round2(wholeTotal - attributed);
  return { amount, has_unattributed: amount > 0.005 };
}

// ─── Reconciliation report (pure data builder; rendered owner-facing this ──────
// sprint, consumed by the Sprint 12 client-portal Budget & Costs tab) ──────────

export interface ReconReportCategory {
  category: "materials" | "labor" | "subs" | "pm_fee" | "contractor_fee" | "subtotal" | "total";
  label: string;
  projected: number;
  actual: number;
  variance: number; // projected − actual (positive = under)
}

export interface ReconReportExpenseLine {
  id: string;
  date: string | null;
  vendor: string | null;
  description: string | null;
  expense_type: string | null;
  amount: number;
}

/** Expense line in the itemized reconciliation backup (materials or subs bucket). */
export interface ReconItemizedExpense {
  id: string;
  kind: "expense";
  date: string | null;
  vendor: string | null;
  description: string | null;
  expense_type: string | null;
  amount: number;
  sub_name: string | null;
  /** Owner-facing relative URL; null when no receipt is attached. */
  receipt_url: string | null;
}

/** Time-entry line in the labor bucket. */
export interface ReconItemizedTimeEntry {
  id: string;
  kind: "time_entry";
  date: string | null;
  worker: string;
  role: string;
  hours: number | null;
  hourly_rate: number | null;
  amount: number;
}

export interface ReconItemized {
  materials: ReconItemizedExpense[];
  labor: ReconItemizedTimeEntry[];
  subs: ReconItemizedExpense[];
}

export interface ReconciliationReport {
  cycle_id: string;
  cycle_number: number;
  period_start: string;
  period_end: string;
  is_final_cycle: boolean;
  pm_fee_rate: number;
  contractor_fee_rate: number;
  categories: ReconReportCategory[];
  expenses: ReconReportExpenseLine[];
  itemized: ReconItemized;
  labor_from_time: number;
  credit_from_prior: number;
  delta: number;
  credit_to_next: number;
  outcome: Reconciliation["outcome"];
  /** plain-language credit/overage explanation for the client. */
  explanation: string;
}

const CATEGORY_LABELS: Record<ReconReportCategory["category"], string> = {
  materials: "Materials",
  labor: "Labor",
  subs: "Subcontractors",
  subtotal: "Subtotal",
  pm_fee: "PM Fee",
  contractor_fee: "Contractor Fee",
  total: "Cycle Total",
};

function cat(
  category: ReconReportCategory["category"],
  projected: number,
  actual: number,
): ReconReportCategory {
  return {
    category,
    label: CATEGORY_LABELS[category],
    projected: round2(projected),
    actual: round2(actual),
    variance: round2(projected - actual),
  };
}

export interface CycleForReport {
  id: string;
  cycle_number: number;
  period_start: string;
  period_end: string;
  is_final_cycle: number | null;
  pm_fee_rate: number;
  contractor_fee_rate: number;
  projected_materials: number | null;
  projected_labor: number | null;
  projected_subs: number | null;
  projected_subtotal: number | null;
  projected_pm_fee: number | null;
  projected_contractor_fee: number | null;
  projected_total: number | null;
  actual_materials: number | null;
  actual_labor: number | null;
  actual_subs: number | null;
  actual_subtotal: number | null;
  actual_pm_fee: number | null;
  actual_contractor_fee: number | null;
  actual_total: number | null;
  delta: number | null;
  credit_from_prior: number | null;
  credit_to_next: number | null;
}

function usd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n ?? 0);
}

function explain(delta: number, isFinal: boolean): { outcome: Reconciliation["outcome"]; text: string } {
  if (delta > 0.005) {
    return {
      outcome: "under_budget",
      text: isFinal
        ? `This cycle came in ${usd(delta)} under budget. The surplus is applied to the final invoice.`
        : `This cycle came in ${usd(delta)} under budget. The surplus is credited toward your next cycle's invoice.`,
    };
  }
  if (delta < -0.005) {
    const over = Math.abs(delta);
    return {
      outcome: "over_budget",
      text: isFinal
        ? `This cycle ran ${usd(over)} over budget. The overage is added to the final invoice.`
        : `This cycle ran ${usd(over)} over budget. The overage is added to your next cycle's invoice.`,
    };
  }
  return { outcome: "on_budget", text: "This cycle's actual costs matched the budget." };
}

function toItemizedExpense(e: PeriodExpenseDetail): ReconItemizedExpense {
  const receiptUrl = e.receipt_r2_key
    ? `/api/expenses/${e.id}/receipt`
    : e.receipt_photo_id
      ? `/api/photos/${e.receipt_photo_id}`
      : null;
  return {
    id: e.id,
    kind: "expense",
    date: e.date,
    vendor: e.vendor,
    description: e.description,
    expense_type: e.expense_type,
    amount: e.amount,
    sub_name: e.sub_name,
    receipt_url: receiptUrl,
  };
}

function toItemizedTimeEntry(t: PeriodTimeEntryDetail): ReconItemizedTimeEntry {
  return {
    id: t.id,
    kind: "time_entry",
    date: t.date,
    worker: t.worker,
    role: t.role,
    hours: t.hours,
    hourly_rate: t.hourly_rate,
    amount: t.labor_cost,
  };
}

/**
 * Build the reconciliation report payload from a (reconciled) cycle row + the
 * period's expense line-items. Pure shaping over already-stored actuals, so it's
 * stable whether called right after reconcile or later for a closed cycle. This
 * is the shape the Sprint 12 portal Budget & Costs tab will consume — see the
 * SPRINT-12 SEAM in src/routes/billing-cycles.ts.
 */
export async function buildReconciliationReport(
  env: Env,
  cycle: CycleForReport,
): Promise<ReconciliationReport> {
  const jobRow = await env.DB.prepare("SELECT job_id FROM billing_cycles WHERE id = ?")
    .bind(cycle.id)
    .first<{ job_id: string }>();
  const jobId = jobRow?.job_id;
  const window = { from: cycle.period_start, to: cycle.period_end };

  const [expenseDetails, timeDetails] = jobId
    ? await Promise.all([
        fetchPeriodExpenseDetails(env, jobId, window),
        fetchPeriodTimeEntryDetails(env, jobId, window),
      ])
    : [[], []];

  const materials: ReconItemizedExpense[] = [];
  const subs: ReconItemizedExpense[] = [];
  const flatExpenses: ReconReportExpenseLine[] = [];

  for (const e of expenseDetails) {
    flatExpenses.push({
      id: e.id,
      date: e.date,
      vendor: e.vendor,
      description: e.description,
      expense_type: e.expense_type,
      amount: e.amount,
    });
    const line = toItemizedExpense(e);
    if (e.expense_type === "subcontractor") subs.push(line);
    else materials.push(line);
  }

  const labor = timeDetails.map(toItemizedTimeEntry);

  const delta = round2(cycle.delta ?? 0);
  const { outcome, text } = explain(delta, (cycle.is_final_cycle ?? 0) === 1);

  return {
    cycle_id: cycle.id,
    cycle_number: cycle.cycle_number,
    period_start: cycle.period_start,
    period_end: cycle.period_end,
    is_final_cycle: (cycle.is_final_cycle ?? 0) === 1,
    pm_fee_rate: cycle.pm_fee_rate,
    contractor_fee_rate: cycle.contractor_fee_rate,
    categories: [
      cat("materials", cycle.projected_materials ?? 0, cycle.actual_materials ?? 0),
      cat("labor", cycle.projected_labor ?? 0, cycle.actual_labor ?? 0),
      cat("subs", cycle.projected_subs ?? 0, cycle.actual_subs ?? 0),
      cat("subtotal", cycle.projected_subtotal ?? 0, cycle.actual_subtotal ?? 0),
      cat("pm_fee", cycle.projected_pm_fee ?? 0, cycle.actual_pm_fee ?? 0),
      cat("contractor_fee", cycle.projected_contractor_fee ?? 0, cycle.actual_contractor_fee ?? 0),
      cat("total", cycle.projected_total ?? 0, cycle.actual_total ?? 0),
    ],
    expenses: flatExpenses,
    itemized: { materials, labor, subs },
    labor_from_time: round2(cycle.actual_labor ?? 0),
    credit_from_prior: round2(cycle.credit_from_prior ?? 0),
    delta,
    credit_to_next: round2(cycle.credit_to_next ?? delta),
    outcome,
    explanation: text,
  };
}

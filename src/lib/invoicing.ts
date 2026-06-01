/**
 * Invoicing engine (Sprint 9) — the shared money helpers used by the invoice +
 * payment routes, the Stripe webhook, and the two financial crons. Kept in
 * src/lib/ alongside quote-to-job.ts / notification-engine.ts (the built reality
 * — there is no src/services layer).
 *
 * Design rules this file enforces (Sprint 9 business rules + Sprint 6 carry-overs):
 *   - invoice_number is allocated INSIDE the INSERT (COALESCE(MAX)+1 in an
 *     INSERT…SELECT) against the UNIQUE index idx_invoices_invoice_number, so a
 *     collision fails cleanly at the DB rather than silently double-numbering.
 *   - total_due = amount + tax_amount + late_fee_amount - credits_applied.
 *   - convenience_fee is REVENUE (tracked separately); stripe_fee is the COST;
 *     net_amount = amount - stripe_fee. The convenience fee never inflates
 *     contract value / New Sales (we never feed it to triggerDealWon).
 *   - Late fees: $50/day. Anchor = due_date (the client-facing date). The 7-day
 *     grace lives in due_date itself (default = sent_date + 7), so accrual at
 *     $50/day from the first full day past due_date == "day 8 after sent" when
 *     due_date is the default. Confirm against the Service Agreement before any
 *     live fee collection (Open Question 2 — see the sprint report).
 *   - Payment recording is idempotent: the Stripe PaymentIntent id is unique on
 *     payments (partial UNIQUE index) and the webhook checks-before-insert.
 */

import type { Env } from "../env.js";
import { triggerNotification } from "./notification-engine.js";

export const LATE_FEE_PER_DAY = 50;
export const DEFAULT_DUE_DAYS = 7;
export const CONVENIENCE_FEE_RATE = 0.035;

export type InvoiceType =
  | "deposit"
  | "milestone"
  | "trade_completion"
  | "cost_plus_cycle"
  | "final"
  | "change_order"
  | "manual";

export const INVOICE_TYPES: InvoiceType[] = [
  "deposit",
  "milestone",
  "trade_completion",
  "cost_plus_cycle",
  "final",
  "change_order",
  "manual",
];

// Statuses excluded from "owed" math everywhere (void preserved for audit; paid
// settled). The →closed gate, suggestions, and remaining-balance use this.
export const SETTLED_OR_DEAD = new Set(["void", "paid"]);

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** total_due = amount + tax + late_fee - credits (spec §4 / business rule). */
export function computeTotalDue(
  amount: number,
  taxAmount: number,
  lateFee: number,
  credits: number,
): number {
  return round2((amount ?? 0) + (taxAmount ?? 0) + (lateFee ?? 0) - (credits ?? 0));
}

/** The 3.5% convenience fee (revenue) on an electronic payment of `base`. */
export function convenienceFee(base: number, rate = CONVENIENCE_FEE_RATE): number {
  return round2(base * rate);
}

/** Date `days` after a YYYY-MM-DD (or ISO) date, as YYYY-MM-DD. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date((isoDate.length === 10 ? isoDate + "T00:00:00Z" : isoDate));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days the invoice is past its due_date (0 if not past due / no due). */
export function daysPastDue(dueDate: string | null, asOf: Date = new Date()): number {
  if (!dueDate) return 0;
  const due = new Date(`${dueDate.slice(0, 10)}T23:59:59Z`).getTime();
  if (!Number.isFinite(due)) return 0;
  const diff = asOf.getTime() - due;
  if (diff <= 0) return 0;
  return Math.floor(diff / 86_400_000) + 1; // first full day past due = 1
}

/** Accrued late fee = $50 × days past due (anchored on due_date). */
export function accruedLateFee(dueDate: string | null, asOf: Date = new Date()): number {
  return round2(daysPastDue(dueDate, asOf) * LATE_FEE_PER_DAY);
}

/** Build the public payment-page URL for a per-invoice payment_token. */
export function paymentLink(env: Env, token: string): string {
  const origin = (env.APP_PUBLIC_ORIGIN ?? "https://client.homesolutionsar.com").replace(/\/$/, "");
  return `${origin}/pay/${token}`;
}

export function invoiceLabel(n: number | null | undefined): string {
  return `INV-${String(n ?? 0).padStart(3, "0")}`;
}

// ─── invoice row + shaping ────────────────────────────────────────────────────

export interface InvoiceRow {
  id: string;
  invoice_number: number | null;
  job_id: string | null;
  client_id: string | null;
  billing_model: string | null;
  invoice_type: string | null;
  title: string | null;
  description: string | null;
  amount: number | null;
  tax_amount: number | null;
  late_fee_amount: number | null;
  credits_applied: number | null;
  total_due: number | null;
  status: string | null;
  sent_date: string | null;
  viewed_date: string | null;
  due_date: string | null;
  paid_date: string | null;
  paid_amount: number | null;
  payment_method: string | null;
  stripe_payment_id: string | null;
  portal_link: string | null;
  payment_token: string | null;
  cost_plus_cycle_id: string | null;
  milestone_number: number | null;
  trade_line_item_id: string | null;
  notes: string | null;
  created_at: string | null;
  created_by: string | null;
}

export const INVOICE_COLUMNS = `id, invoice_number, job_id, client_id, billing_model, invoice_type,
  title, description, amount, tax_amount, late_fee_amount, credits_applied, total_due,
  status, sent_date, viewed_date, due_date, paid_date, paid_amount, payment_method,
  stripe_payment_id, portal_link, payment_token, cost_plus_cycle_id, milestone_number,
  trade_line_item_id, notes, created_at, created_by`;

export function shapeInvoice(r: InvoiceRow) {
  return {
    id: r.id,
    invoice_number: r.invoice_number,
    invoice_display: invoiceLabel(r.invoice_number),
    job_id: r.job_id,
    client_id: r.client_id,
    billing_model: r.billing_model,
    invoice_type: r.invoice_type,
    title: r.title,
    description: r.description,
    amount: r.amount,
    tax_amount: r.tax_amount ?? 0,
    late_fee_amount: r.late_fee_amount ?? 0,
    credits_applied: r.credits_applied ?? 0,
    total_due: r.total_due,
    status: r.status,
    sent_date: r.sent_date,
    viewed_date: r.viewed_date,
    due_date: r.due_date,
    paid_date: r.paid_date,
    paid_amount: r.paid_amount,
    payment_method: r.payment_method,
    stripe_payment_id: r.stripe_payment_id,
    payment_token: r.payment_token,
    milestone_number: r.milestone_number,
    trade_line_item_id: r.trade_line_item_id,
    cost_plus_cycle_id: r.cost_plus_cycle_id,
    notes: r.notes,
    created_at: r.created_at,
    created_by: r.created_by,
  };
}

export async function loadInvoice(env: Env, id: string): Promise<InvoiceRow | null> {
  return env.DB.prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id = ?`)
    .bind(id)
    .first<InvoiceRow>();
}

export async function loadInvoiceByToken(env: Env, token: string): Promise<InvoiceRow | null> {
  return env.DB.prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE payment_token = ?`)
    .bind(token)
    .first<InvoiceRow>();
}

// ─── status recompute after a payment ─────────────────────────────────────────

export interface StatusResult {
  status: string;
  paidTotal: number;
  totalDue: number;
}

/**
 * Recompute an invoice's status from the sum of its payments. Never touches a
 * void invoice. paid_total >= total_due → paid; 0 < paid_total < total_due →
 * partial; else leaves a sent/viewed/past_due invoice as-is. Stamps paid_date /
 * paid_amount / payment_method from the payments. Returns the new status.
 */
export async function recomputeInvoiceStatus(env: Env, invoiceId: string): Promise<StatusResult | null> {
  const inv = await loadInvoice(env, invoiceId);
  if (!inv) return null;
  if (inv.status === "void") {
    return { status: "void", paidTotal: 0, totalDue: round2(inv.total_due ?? 0) };
  }

  const agg = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS paid, MAX(received_date) AS last_date,
            COUNT(*) AS n
       FROM payments WHERE invoice_id = ?`,
  )
    .bind(invoiceId)
    .first<{ paid: number; last_date: string | null; n: number }>();
  const paidTotal = round2(agg?.paid ?? 0);
  const totalDue = round2(inv.total_due ?? (inv.amount ?? 0));

  // Last payment method (for the invoice summary).
  let method: string | null = inv.payment_method;
  if ((agg?.n ?? 0) > 0) {
    const last = await env.DB.prepare(
      "SELECT payment_method FROM payments WHERE invoice_id = ? ORDER BY COALESCE(received_date, created_at) DESC, created_at DESC LIMIT 1",
    )
      .bind(invoiceId)
      .first<{ payment_method: string | null }>();
    method = last?.payment_method ?? method;
  }

  let status: string;
  if (paidTotal >= totalDue && totalDue > 0) status = "paid";
  else if (paidTotal > 0) status = "partial";
  else status = inv.status && inv.status !== "draft" ? inv.status : (inv.sent_date ? "sent" : "draft");

  const nowIso = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE invoices
        SET status = ?, paid_amount = ?, payment_method = ?,
            paid_date = CASE WHEN ? = 'paid' THEN COALESCE(paid_date, ?) ELSE paid_date END,
            payments_total = ?
      WHERE id = ?`,
  )
    .bind(status, paidTotal, method, status, nowIso, paidTotal, invoiceId)
    .run();

  return { status, paidTotal, totalDue };
}

// ─── generation suggestions (Invoice Builder pre-fill) ────────────────────────

export interface MilestoneSuggestion {
  billing_schedule_id: string;
  invoice_type: "milestone";
  milestone_number: number;
  title: string;
  amount: number;
  percentage: number | null;
}
export interface TradeSuggestion {
  billing_schedule_id: string;
  invoice_type: "trade_completion";
  trade_line_item_id: string;
  title: string;
  amount: number;
  task_group: string;
}
export interface FinalSuggestion {
  invoice_type: "final";
  title: string;
  amount: number; // remaining contract balance
}
export interface ChangeOrderSuggestion {
  change_order_id: string;
  invoice_type: "change_order";
  change_order_number: number;
  title: string;
  amount: number;
}

export interface InvoiceSuggestions {
  milestones: MilestoneSuggestion[];
  trades: TradeSuggestion[];
  final: FinalSuggestion | null;
  /** Sprint 13: approved fixed/trade COs (amount>0) not yet billed. Owner-confirmed. */
  change_orders: ChangeOrderSuggestion[];
}

interface BillingScheduleRow {
  id: string;
  billing_model: string;
  sequence: number;
  label: string;
  trigger_type: string;
  trigger_ref: string | null;
  percentage: number | null;
  amount: number | null;
  status: string;
}

/**
 * Compute what invoices the builder should SUGGEST for a job (never auto-fires):
 *   - fixed_price: the next unbilled milestone draw(s) from billing_schedule
 *     (Draw 2, Draw 3 …). The deposit draw (status='paid') is skipped.
 *   - trade_by_trade: trade_completion schedule rows whose matching task GROUP
 *     is fully complete and not yet invoiced.
 *   - final: the remaining contract balance (amount - sum of non-void invoices),
 *     surfaced once there's a positive remainder.
 */
export async function computeSuggestions(
  env: Env,
  jobId: string,
  billingModel: string | null,
  contractTotal: number,
): Promise<InvoiceSuggestions> {
  const out: InvoiceSuggestions = { milestones: [], trades: [], final: null, change_orders: [] };

  const schedule = (
    await env.DB.prepare(
      "SELECT id, billing_model, sequence, label, trigger_type, trigger_ref, percentage, amount, status FROM billing_schedule WHERE job_id = ? ORDER BY sequence ASC",
    )
      .bind(jobId)
      .all<BillingScheduleRow>()
  ).results ?? [];

  // Existing non-void invoices: which milestones / trades are already invoiced.
  const invoices = (
    await env.DB.prepare(
      "SELECT invoice_type, milestone_number, trade_line_item_id, amount, status, notes FROM invoices WHERE job_id = ? AND status != 'void'",
    )
      .bind(jobId)
      .all<{ invoice_type: string | null; milestone_number: number | null; trade_line_item_id: string | null; amount: number | null; status: string | null; notes: string | null }>()
  ).results ?? [];
  const invoicedMilestones = new Set(
    invoices.filter((i) => i.milestone_number != null).map((i) => Number(i.milestone_number)),
  );
  const invoicedTrades = new Set(
    invoices.filter((i) => i.trade_line_item_id).map((i) => String(i.trade_line_item_id)),
  );
  const invoicedTotal = round2(
    invoices.reduce((s, i) => s + (i.amount ?? 0), 0),
  );

  if (billingModel === "fixed_price") {
    for (const row of schedule) {
      if (row.trigger_type !== "milestone") continue;
      if (row.status === "paid") continue; // deposit / already-collected draw
      const milestoneNum = Number(row.trigger_ref ?? row.sequence + 1);
      if (invoicedMilestones.has(milestoneNum)) continue;
      out.milestones.push({
        billing_schedule_id: row.id,
        invoice_type: "milestone",
        milestone_number: milestoneNum,
        title: row.label,
        amount: round2(row.amount ?? 0),
        percentage: row.percentage,
      });
    }
  }

  if (billingModel === "trade_by_trade") {
    // Task-group completion: a group is "complete" when it has tasks and none
    // are still open (pending/in_progress).
    const groups = (
      await env.DB.prepare(
        `SELECT task_group,
                SUM(CASE WHEN status NOT IN ('complete','skipped') THEN 1 ELSE 0 END) AS open,
                COUNT(*) AS total
           FROM tasks WHERE job_id = ? GROUP BY task_group`,
      )
        .bind(jobId)
        .all<{ task_group: string; open: number; total: number }>()
    ).results ?? [];
    const completeGroups = new Set(
      groups.filter((g) => g.total > 0 && g.open === 0).map((g) => g.task_group),
    );

    for (const row of schedule) {
      if (row.trigger_type !== "trade_completion") continue;
      if (row.status === "paid") continue;
      if (invoicedTrades.has(row.id)) continue;
      // trigger_ref / label is the task-group name the conversion linked.
      const group = row.trigger_ref || row.label;
      if (!completeGroups.has(group)) continue;
      out.trades.push({
        billing_schedule_id: row.id,
        invoice_type: "trade_completion",
        trade_line_item_id: row.id, // billing_schedule row is the trade reference
        title: `${row.label} — Complete`,
        amount: round2(row.amount ?? 0),
        task_group: group,
      });
    }
  }

  // Sprint 13: approved change orders on fixed/trade jobs surface a suggested
  // (owner-confirmed, never auto-sent) change_order invoice. Cost-plus COs are a
  // projection revision only — their cost bills through the bi-weekly cycle, so
  // NO invoice is ever suggested for them (double-billing guard, rule #4). A
  // negative (credit) CO reduces contract_total and produces no invoice.
  if (billingModel === "fixed_price" || billingModel === "trade_by_trade") {
    // A CO is "already billed" when a non-void change_order invoice references it
    // via the notes token `co:<coId>` (set by the builder prefill). No FK needed.
    const billedCoIds = new Set(
      invoices
        .filter((i) => i.invoice_type === "change_order")
        .map((i) => /co:([0-9a-f-]+)/i.exec(i.notes ?? "")?.[1])
        .filter((v): v is string => !!v),
    );
    const approvedCos = (
      await env.DB.prepare(
        `SELECT id, change_order_number, title, amount FROM change_orders
          WHERE job_id = ? AND status = 'approved' AND applied_at IS NOT NULL AND amount > 0
          ORDER BY change_order_number ASC`,
      )
        .bind(jobId)
        .all<{ id: string; change_order_number: number; title: string | null; amount: number | null }>()
    ).results ?? [];
    for (const co of approvedCos) {
      if (billedCoIds.has(co.id)) continue;
      out.change_orders.push({
        change_order_id: co.id,
        invoice_type: "change_order",
        change_order_number: co.change_order_number,
        title: `Change Order ${co.change_order_number}: ${co.title ?? "Approved change"}`,
        amount: round2(co.amount ?? 0),
      });
    }
  }

  const remaining = round2(contractTotal - invoicedTotal);
  if (remaining > 0.01 && (billingModel === "trade_by_trade" || billingModel === "fixed_price")) {
    // Only surface a "final / remaining balance" suggestion once there is no
    // pending milestone/trade left to bill (so it captures the true remainder).
    if (out.milestones.length === 0 && out.trades.length === 0) {
      out.final = {
        invoice_type: "final",
        title: "Final Invoice — Remaining Balance",
        amount: remaining,
      };
    }
  }

  return out;
}

// ─── cron: late-fee accrual ───────────────────────────────────────────────────

export interface LateFeeStats {
  scanned: number;
  updated: number;
  marked_past_due: number;
}

/**
 * Late Fee Calculator (cron `0 0 * * *`): for every overdue, non-void, unpaid
 * invoice, accrue $50/day from due_date and recompute total_due. Invoices that
 * are unpaid (sent/viewed/past_due) get flipped to past_due; partials keep their
 * partial status but still accrue. Enqueue nothing here — the due-check cron
 * owns the past-due notice.
 */
export async function runLateFeeCalculator(env: Env): Promise<LateFeeStats> {
  const stats: LateFeeStats = { scanned: 0, updated: 0, marked_past_due: 0 };
  const today = new Date().toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT ${INVOICE_COLUMNS} FROM invoices
      WHERE status IN ('sent','viewed','partial','past_due')
        AND due_date IS NOT NULL AND substr(due_date, 1, 10) < ?`,
  )
    .bind(today)
    .all<InvoiceRow>();

  for (const inv of results ?? []) {
    stats.scanned++;
    const fee = accruedLateFee(inv.due_date);
    const newTotalDue = computeTotalDue(inv.amount ?? 0, inv.tax_amount ?? 0, fee, inv.credits_applied ?? 0);
    const becomesPastDue = inv.status === "sent" || inv.status === "viewed";
    const nextStatus = becomesPastDue ? "past_due" : inv.status ?? "past_due";
    // Skip the write if nothing changed (idempotent daily re-run).
    if (round2(inv.late_fee_amount ?? 0) === fee && nextStatus === inv.status) continue;
    await env.DB.prepare(
      "UPDATE invoices SET late_fee_amount = ?, total_due = ?, status = ? WHERE id = ?",
    )
      .bind(fee, newTotalDue, nextStatus, inv.id)
      .run();
    stats.updated++;
    if (becomesPastDue) stats.marked_past_due++;
  }
  return stats;
}

// ─── cron: invoice due check (reminders + past-due notices) ───────────────────

export interface DueCheckStats {
  scanned: number;
  reminders: number;
  past_due: number;
}

function usd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}
function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? iso + "T00:00:00Z" : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * Invoice Due Check (daily cron): enqueue-only — the every-15-min engine drains.
 *   - reminder ~2 days before due_date for sent/viewed invoices (once per
 *     invoice via instanceKey 'due_reminder').
 *   - past-due notice daily after the grace period for overdue unpaid invoices
 *     (once per day via instanceKey = today's date), including the running late
 *     fee. Stays SIMULATED (dispatch mode unchanged).
 */
export async function runInvoiceDueCheck(env: Env): Promise<DueCheckStats> {
  const stats: DueCheckStats = { scanned: 0, reminders: 0, past_due: 0 };
  const today = new Date().toISOString().slice(0, 10);
  const reminderDay = addDays(today, 2); // due in ~2 days

  const { results } = await env.DB.prepare(
    `SELECT ${INVOICE_COLUMNS} FROM invoices
      WHERE status IN ('sent','viewed','partial','past_due')
        AND due_date IS NOT NULL`,
  ).all<InvoiceRow>();

  for (const inv of results ?? []) {
    stats.scanned++;
    const due = inv.due_date!.slice(0, 10);
    const link = inv.payment_token ? paymentLink(env, inv.payment_token) : (inv.portal_link ?? "");
    const baseMerge = {
      invoice_number: inv.invoice_number != null ? String(inv.invoice_number) : "",
      invoice_amount: usd(inv.total_due ?? inv.amount ?? 0),
      due_date: fmtDate(inv.due_date),
      payment_link: link,
    };

    if (due === reminderDay && (inv.status === "sent" || inv.status === "viewed")) {
      const res = await triggerNotification(env, "invoice_due_reminder", {
        clientId: inv.client_id,
        jobId: inv.job_id,
        instanceKey: "due_reminder",
        merge: baseMerge,
      });
      stats.reminders += res.enqueued;
    }

    if (due < today) {
      const res = await triggerNotification(env, "invoice_past_due", {
        clientId: inv.client_id,
        jobId: inv.job_id,
        instanceKey: today, // one past-due notice per day
        merge: baseMerge,
      });
      stats.past_due += res.enqueued;
    }
  }
  return stats;
}

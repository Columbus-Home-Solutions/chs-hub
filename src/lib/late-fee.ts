/**
 * One-time 5% late fee. Nothing is charged until the owner presses Add.
 * The nightly run only proposes (or, while the switch is off, only counts).
 */

import type { Env } from "../env.js";
import { addDays, centralDate } from "../../shared/labor-week.js";
import { guard } from "../middleware/guard.js";
import { createOwnerInApp, markOwnerInAppRead, triggerNotification } from "./notification-engine.js";
import {
  computeTotalDue,
  invoiceLabel,
  isBillingHeld,
  isJobberHistoryInvoice,
  paymentLink,
  round2,
} from "./invoicing.js";

export const LATE_FEE_RATE = 0.05;
export const GRACE_DAYS_AFTER_DUE = 7;
export const SETTING_KEY = "late_fee_proposals_enabled";

export interface LateFeeCandidate {
  id: string;
  invoice_number: number | null;
  status: string | null;
  amount: number | null;
  tax_amount: number | null;
  credits_applied: number | null;
  late_fee_amount: number | null;
  total_due: number | null;
  due_date: string | null;
  billing_model: string | null;
  invoice_type: string | null;
  job_id: string | null;
  /** jobs.status. Home uses this so a held job does not promise a customer text. */
  job_status: string | null;
  client_id: string | null;
  client_name: string | null;
  payment_token: string | null;
  late_fee_state: string | null;
  late_fee_hold: number | null;
  late_fee_hold_reason: string | null;
  late_fee_snooze_until: string | null;
  late_fee_proposed_amount: number | null;
  late_fee_waived_amount: number | null;
  invoice_data_source: string | null;
  job_data_source: string | null;
  job_billing_model: string | null;
  billing_hold: number | null;
  collected: number | null;
}

export interface LateFeeExtra {
  late_fee_state: string;
  late_fee_proposed_amount: number | null;
  late_fee_waived_amount: number | null;
  late_fee_hold: number;
  late_fee_hold_reason: string | null;
  late_fee_snooze_until: string | null;
  late_fee_grace_end: string | null;
}

export type LateFeePlanItem =
  | { kind: "propose"; row: LateFeeCandidate; amount: number; balance: number }
  | { kind: "cancel"; row: LateFeeCandidate }
  | { kind: "count"; row: LateFeeCandidate; amount: number; balance: number };

function ymd(value: string | null | undefined): string {
  return (value ?? "").slice(0, 10);
}

export function graceEndDate(dueDate: string | null): string | null {
  const due = ymd(dueDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return null;
  return addDays(due, GRACE_DAYS_AFTER_DUE);
}

/** Eligible the day after due_date + 7. On the grace-end date itself, not yet. */
export function isPastGrace(dueDate: string | null, today: string): boolean {
  const end = graceEndDate(dueDate);
  return end != null && today > end;
}

export function isSnoozed(until: string | null | undefined, today: string): boolean {
  const day = ymd(until);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && today <= day;
}

export function isCostPlus(row: {
  billing_model?: string | null;
  invoice_type?: string | null;
  job_billing_model?: string | null;
}): boolean {
  return (
    row.billing_model === "cost_plus" ||
    row.job_billing_model === "cost_plus" ||
    row.invoice_type === "cost_plus_cycle"
  );
}

/** Principal still unpaid. Excludes a stored late fee and any convenience fee. */
export function unpaidPrincipal(row: {
  amount?: number | null;
  tax_amount?: number | null;
  credits_applied?: number | null;
  collected?: number | null;
}): number {
  const principal = round2((row.amount ?? 0) + (row.tax_amount ?? 0) - (row.credits_applied ?? 0));
  return round2(Math.max(0, principal - (row.collected ?? 0)));
}

export function openBalance(row: {
  total_due?: number | null;
  amount?: number | null;
  collected?: number | null;
}): number {
  const total = round2(row.total_due ?? row.amount ?? 0);
  return round2(Math.max(0, total - (row.collected ?? 0)));
}

export function lateFeeAmount(base: number): number {
  return round2(Math.max(0, base) * LATE_FEE_RATE);
}

function stateOf(row: LateFeeCandidate): string {
  return row.late_fee_state ?? "none";
}

function feeAlreadyOnRecord(row: LateFeeCandidate): boolean {
  const state = stateOf(row);
  if (state === "applied" || state === "waived") return true;
  return round2(row.late_fee_amount ?? 0) > 0;
}

export function exclusionReason(row: LateFeeCandidate, today: string): string | null {
  if (row.status === "void" || row.status === "paid") return "closed";
  if (
    isJobberHistoryInvoice({
      invoiceId: row.id,
      invoiceDataSource: row.invoice_data_source,
      jobDataSource: row.job_data_source,
    })
  ) {
    return "jobber";
  }
  if (isBillingHeld(row.billing_hold)) return "billing_hold";
  if (isCostPlus(row)) return "cost_plus";
  if (Number(row.late_fee_hold ?? 0) === 1) return "hold";
  if (isSnoozed(row.late_fee_snooze_until, today)) return "snooze";
  if (feeAlreadyOnRecord(row)) return "decided";
  if (!isPastGrace(row.due_date, today)) return "grace";
  const base = unpaidPrincipal(row);
  if (base <= 0 || openBalance(row) <= 0) return "paid";
  return null;
}

const ADD_REFUSAL: Record<string, { error: string; details: string }> = {
  closed: { error: "closed", details: "This invoice is already paid or void." },
  jobber: { error: "jobber", details: "Old Jobber invoices don't get a late fee." },
  billing_hold: { error: "billing_hold", details: "This invoice is on a billing hold." },
  cost_plus: { error: "cost_plus", details: "Cost-plus jobs do not get a late fee." },
  hold: { error: "hold", details: "This invoice is on hold." },
  snooze: { error: "snooze", details: "This late fee is snoozed." },
  decided: { error: "already_decided", details: "This invoice already has a late fee decision." },
  grace: { error: "grace", details: "This invoice isn't 7 days past due yet" },
  paid: { error: "nothing_due", details: "There is no unpaid balance to assess." },
};

/** Add uses the nightly exclusion rules. The proposals switch is not one of them. */
export function addRefusal(
  row: LateFeeCandidate,
  today: string,
): { error: string; details: string } | null {
  const reason = exclusionReason(row, today);
  if (!reason) return null;
  return ADD_REFUSAL[reason] ?? { error: reason, details: "This invoice isn't eligible for a late fee." };
}

export function planLateFees(
  rows: LateFeeCandidate[],
  today: string,
  enabled: boolean,
): LateFeePlanItem[] {
  const plan: LateFeePlanItem[] = [];
  for (const row of rows) {
    if (stateOf(row) === "proposed" && (row.status === "paid" || row.status === "void" || openBalance(row) <= 0)) {
      plan.push({ kind: "cancel", row });
      continue;
    }
    if (exclusionReason(row, today)) continue;
    if (stateOf(row) === "proposed") continue;
    const amount = lateFeeAmount(unpaidPrincipal(row));
    if (amount <= 0) continue;
    plan.push(
      enabled
        ? { kind: "propose", row, amount, balance: openBalance(row) }
        : { kind: "count", row, amount, balance: openBalance(row) },
    );
  }
  return plan;
}

function usd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function candidateSql(extra = ""): string {
  return `
  SELECT i.id, i.invoice_number, i.status, i.amount, i.tax_amount, i.credits_applied,
         i.late_fee_amount, i.total_due, i.due_date, i.billing_model, i.invoice_type,
         i.job_id, j.status AS job_status, i.client_id, i.payment_token,
         i.late_fee_state, i.late_fee_hold, i.late_fee_hold_reason, i.late_fee_snooze_until,
         i.late_fee_proposed_amount, i.late_fee_waived_amount,
         i.data_source AS invoice_data_source, j.data_source AS job_data_source,
         j.billing_model AS job_billing_model, i.billing_hold,
         COALESCE(paid.paid, 0) AS collected,
         TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS client_name
    FROM invoices i
    LEFT JOIN jobs j ON j.id = i.job_id
    LEFT JOIN clients c ON c.id = i.client_id
    LEFT JOIN (
      SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id
    ) paid ON paid.invoice_id = i.id
   WHERE (i.status IN ('sent','viewed','partial','past_due','paid','void')
      OR COALESCE(i.late_fee_state, 'none') = 'proposed')
     ${extra}`;
}

async function proposalsEnabled(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = ?")
    .bind(SETTING_KEY)
    .first<{ value: string | null }>();
  const value = (row?.value ?? "false").toLowerCase();
  return value === "1" || value === "true";
}

export async function loadCandidates(env: Env): Promise<LateFeeCandidate[]> {
  const { results } = await env.DB.prepare(candidateSql()).all<LateFeeCandidate>();
  return results ?? [];
}

async function writeDecision(
  env: Env,
  invoiceId: string,
  action: string,
  amount: number | null,
  actor: string | null,
  reason: string | null,
  snoozeUntil: string | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO late_fee_decisions
       (id, invoice_id, action, amount, reason, snooze_until, actor_email, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(crypto.randomUUID(), invoiceId, action, amount, reason, snoozeUntil, actor)
    .run();
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at)
     VALUES (?, ?, ?, 'invoice', ?, ?, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      actor ?? "system",
      `late_fee_${action}`,
      invoiceId,
      JSON.stringify({ amount, reason, snooze_until: snoozeUntil }),
    )
    .run();
}

async function quietProposalBell(env: Env, invoiceId: string): Promise<void> {
  try {
    await markOwnerInAppRead(env, `late-fee-proposal-${invoiceId}-`);
  } catch (err) {
    console.error(`[late-fee] bell read: ${(err as Error).message}`);
  }
}

function proposalMessage(row: LateFeeCandidate, amount: number, balance: number): string {
  const who = (row.client_name ?? "").trim() || "A customer";
  return `${who} · ${invoiceLabel(row.invoice_number)} · balance ${usd(balance)} · proposed late fee ${usd(amount)} (5%, one time).`;
}

export async function runLateFeeProposals(env: Env, now = new Date()): Promise<{
  enabled: boolean;
  proposed: number;
  cancelled: number;
  would_propose: number;
}> {
  const today = centralDate(now);
  const enabled = await proposalsEnabled(env);
  const plan = planLateFees(await loadCandidates(env), today, enabled);
  let proposed = 0;
  let cancelled = 0;
  let would = 0;
  for (const item of plan) {
    if (item.kind === "cancel") {
      await env.DB.prepare(
        `UPDATE invoices
            SET late_fee_state = 'none', late_fee_proposed_amount = NULL, late_fee_proposed_at = NULL
          WHERE id = ? AND late_fee_state = 'proposed'`,
      )
        .bind(item.row.id)
        .run();
      await writeDecision(env, item.row.id, "cancelled", null, null, "paid before approval", null);
      cancelled++;
      continue;
    }
    if (item.kind === "count") {
      would++;
      continue;
    }
    await env.DB.prepare(
      `UPDATE invoices
          SET late_fee_state = 'proposed', late_fee_proposed_amount = ?, late_fee_proposed_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(item.amount, item.row.id)
      .run();
    await writeDecision(env, item.row.id, "proposed", item.amount, null, null, null);
    await createOwnerInApp(env, {
      message: proposalMessage(item.row, item.amount, item.balance),
      linkPath: "/app/",
      dedupe: `late-fee-proposal-${item.row.id}-${today}`,
      clientId: item.row.client_id,
      triggerEvent: "late_fee_proposed",
    });
    proposed++;
  }
  if (!enabled) {
    const listed = plan
      .filter((item) => item.kind === "count")
      .map((item) => `${invoiceLabel(item.row.invoice_number)} ${usd(item.amount)}`)
      .join(", ");
    console.log(`[late-fee] proposals off; would propose ${would}${listed ? `: ${listed}` : ""}`);
  }
  return { enabled, proposed, cancelled, would_propose: would };
}

export interface DryRunRow {
  invoice_id: string;
  invoice_number: number | null;
  invoice_display: string;
  client_name: string;
  balance: number;
  proposed_amount: number;
  due_date: string | null;
}

export async function dryRunLateFees(env: Env, now = new Date()): Promise<{
  enabled: boolean;
  count: number;
  invoices: DryRunRow[];
}> {
  const today = centralDate(now);
  const enabled = await proposalsEnabled(env);
  const plan = planLateFees(await loadCandidates(env), today, false);
  const invoices = plan
    .filter((item) => item.kind === "count")
    .map((item) => ({
      invoice_id: item.row.id,
      invoice_number: item.row.invoice_number,
      invoice_display: invoiceLabel(item.row.invoice_number),
      client_name: (item.row.client_name ?? "").trim(),
      balance: item.balance,
      proposed_amount: item.amount,
      due_date: item.row.due_date,
    }));
  return { enabled, count: invoices.length, invoices };
}

async function loadOne(env: Env, id: string): Promise<LateFeeCandidate | null> {
  return env.DB.prepare(candidateSql("AND i.id = ?")).bind(id).first<LateFeeCandidate>();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function notifyFeeAdded(env: Env, row: LateFeeCandidate, fee: number, totalDue: number): Promise<void> {
  const link = row.payment_token ? paymentLink(env, row.payment_token) : "";
  await triggerNotification(env, "invoice_late_fee_added", {
    clientId: row.client_id,
    jobId: row.job_id,
    instanceKey: row.id,
    merge: {
      invoice_number: row.invoice_number != null ? String(row.invoice_number) : "",
      invoice_amount: usd(totalDue),
      late_fee_amount: usd(fee),
      payment_link: link,
    },
  });
}

export async function handleLateFeePreview(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, ["owner"]);
  if (guarded instanceof Response) return guarded;
  return json(await dryRunLateFees(env));
}

export async function handleLateFeeAction(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, ["owner"]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;
  let body: { action?: string; days?: number; reason?: string };
  try {
    body = (await request.json()) as { action?: string; days?: number; reason?: string };
  } catch {
    return json({ error: "bad_request", details: "Expected JSON." }, 400);
  }
  const action = body.action ?? "";
  const row = await loadOne(env, id);
  if (!row) return json({ error: "not_found", details: "Invoice not found." }, 404);
  const today = centralDate();

  if (action === "add") {
    const refusal = addRefusal(row, today);
    if (refusal) return json(refusal, 409);
    const base = unpaidPrincipal(row);
    const fee = lateFeeAmount(base);
    if (fee <= 0) return json({ error: "nothing_due", details: "There is no unpaid balance to assess." }, 409);
    const totalDue = computeTotalDue(row.amount ?? 0, row.tax_amount ?? 0, fee, row.credits_applied ?? 0);
    await env.DB.prepare(
      `UPDATE invoices
          SET late_fee_amount = ?, total_due = ?, late_fee_state = 'applied',
              late_fee_proposed_amount = ?, late_fee_decided_at = datetime('now'), late_fee_decided_by = ?
        WHERE id = ?`,
    )
      .bind(fee, totalDue, fee, user.email, id)
      .run();
    await writeDecision(env, id, "added", fee, user.email, null, null);
    await notifyFeeAdded(env, row, fee, totalDue);
    await quietProposalBell(env, id);
    return json({ ok: true, action: "added", late_fee_amount: fee, total_due: totalDue });
  }

  if (action === "waive") {
    if (stateOf(row) === "waived") {
      await quietProposalBell(env, id);
      return json({ ok: true, action: "waived", already: true });
    }
    const waived = round2(row.late_fee_amount ?? 0);
    const totalDue = computeTotalDue(row.amount ?? 0, row.tax_amount ?? 0, 0, row.credits_applied ?? 0);
    await env.DB.prepare(
      `UPDATE invoices
          SET late_fee_amount = 0, total_due = ?, late_fee_state = 'waived',
              late_fee_waived_amount = ?, late_fee_hold = 0,
              late_fee_decided_at = datetime('now'), late_fee_decided_by = ?
        WHERE id = ?`,
    )
      .bind(totalDue, waived, user.email, id)
      .run();
    await writeDecision(env, id, "waived", waived, user.email, body.reason ?? null, null);
    await quietProposalBell(env, id);
    return json({ ok: true, action: "waived", waived_amount: waived, total_due: totalDue });
  }

  if (action === "snooze") {
    const days = body.days;
    if (days !== 3 && days !== 7) {
      return json({ error: "bad_request", details: "Snooze is 3 or 7 days." }, 400);
    }
    if (stateOf(row) === "applied" || stateOf(row) === "waived") {
      return json({ error: "already_decided", details: "This invoice already has a late fee decision." }, 409);
    }
    const until = addDays(today, days);
    await env.DB.prepare(
      `UPDATE invoices
          SET late_fee_state = 'none', late_fee_proposed_amount = NULL,
              late_fee_snooze_until = ?, late_fee_decided_at = datetime('now'), late_fee_decided_by = ?
        WHERE id = ?`,
    )
      .bind(until, user.email, id)
      .run();
    await writeDecision(env, id, "snoozed", null, user.email, null, until);
    await quietProposalBell(env, id);
    return json({ ok: true, action: "snoozed", snooze_until: until });
  }

  if (action === "hold") {
    const reason = (body.reason ?? "").trim();
    if (!reason) return json({ error: "reason_required", details: "A hold needs a reason." }, 400);
    await env.DB.prepare(
      `UPDATE invoices
          SET late_fee_hold = 1, late_fee_hold_reason = ?,
              late_fee_state = CASE WHEN late_fee_state = 'proposed' THEN 'none' ELSE late_fee_state END,
              late_fee_proposed_amount = CASE WHEN late_fee_state = 'proposed' THEN NULL ELSE late_fee_proposed_amount END,
              late_fee_decided_at = datetime('now'), late_fee_decided_by = ?
        WHERE id = ?`,
    )
      .bind(reason, user.email, id)
      .run();
    await writeDecision(env, id, "held", null, user.email, reason, null);
    await quietProposalBell(env, id);
    return json({ ok: true, action: "held" });
  }

  if (action === "release") {
    await env.DB.prepare(
      `UPDATE invoices
          SET late_fee_hold = 0, late_fee_hold_reason = NULL,
              late_fee_decided_at = datetime('now'), late_fee_decided_by = ?
        WHERE id = ?`,
    )
      .bind(user.email, id)
      .run();
    await writeDecision(env, id, "released", null, user.email, null, null);
    return json({ ok: true, action: "released" });
  }

  return json({ error: "bad_request", details: "Unknown late fee action." }, 400);
}

export async function lateFeeExtras(env: Env, ids: string[]): Promise<Map<string, LateFeeExtra>> {
  const map = new Map<string, LateFeeExtra>();
  if (ids.length === 0) return map;
  try {
    const placeholders = ids.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT id, late_fee_state, late_fee_proposed_amount, late_fee_waived_amount,
              late_fee_hold, late_fee_hold_reason, late_fee_snooze_until, due_date
         FROM invoices WHERE id IN (${placeholders})`,
    )
      .bind(...ids)
      .all<{
        id: string;
        late_fee_state: string | null;
        late_fee_proposed_amount: number | null;
        late_fee_waived_amount: number | null;
        late_fee_hold: number | null;
        late_fee_hold_reason: string | null;
        late_fee_snooze_until: string | null;
        due_date: string | null;
      }>();
    for (const row of results ?? []) {
      map.set(row.id, {
        late_fee_state: row.late_fee_state ?? "none",
        late_fee_proposed_amount: row.late_fee_proposed_amount,
        late_fee_waived_amount: row.late_fee_waived_amount,
        late_fee_hold: Number(row.late_fee_hold ?? 0),
        late_fee_hold_reason: row.late_fee_hold_reason,
        late_fee_snooze_until: row.late_fee_snooze_until,
        late_fee_grace_end: graceEndDate(row.due_date),
      });
    }
  } catch {
    // Columns are absent until migration 0138. Invoice reads keep working.
  }
  return map;
}

export async function lateFeeState(env: Env, id: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare("SELECT late_fee_state FROM invoices WHERE id = ?")
      .bind(id)
      .first<{ late_fee_state: string | null }>();
    return row?.late_fee_state ?? null;
  } catch {
    return null;
  }
}

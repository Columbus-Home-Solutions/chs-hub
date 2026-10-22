/**
 * Owner decisions that need a button press, shown on Home.
 * The row stays until the underlying record is decided. Dismiss does not decide it.
 */

import type { Env } from "../env.js";
import { centralDate } from "../../shared/labor-week.js";
import { invoiceLabel } from "./invoicing.js";
import {
  exclusionReason,
  lateFeeAmount,
  loadCandidates,
  openBalance,
  unpaidPrincipal,
  type LateFeeCandidate,
} from "./late-fee.js";

export const HOME_DECISION_PATH = "/app/";

export interface DecisionAction {
  id: string;
  label: string;
  path: string;
  body: Record<string, unknown>;
  /** Shown, and the save waits, until the owner presses the button again. */
  confirm?: string;
  needsReason?: boolean;
}

export interface OwnerDecisionItem {
  id: string;
  priority: "high";
  type: "google_calendar_change" | "late_fee_proposed";
  title: string;
  meta: Record<string, unknown>;
  link: string;
  createdAt: string;
  actions: DecisionAction[];
}

export interface CalendarDecisionRow {
  id: string;
  source_type: string;
  change_kind: string;
  summary_label: string | null;
  when_label: string | null;
  updated_at?: string | null;
}

function usd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function possessive(name: string, thing: string): string {
  const who = name.trim();
  if (!who) return `A CHS ${thing}`;
  return `${who}'s ${thing}`;
}

/** "Karen Perry's estimate was moved on Google to Tue 12:00 PM." */
export function calendarDecisionTitle(row: CalendarDecisionRow): string {
  const label = (row.summary_label ?? "").trim();
  const estimate = label.match(/^Estimate for (.+)$/);
  const job = label.match(/^Job for (.+)$/);
  const thing = estimate ? "estimate" : job ? "job" : "item";
  const name = estimate?.[1] || job?.[1] || "";
  const subject = name ? possessive(name, thing) : label || "A CHS item";
  if (row.change_kind === "deleted") return `${subject} was removed on Google.`;
  const when = (row.when_label ?? "").replace(/\s+Central$/, "").trim();
  return when ? `${subject} was moved on Google to ${when}.` : `${subject} was moved on Google.`;
}

export function calendarDecisionActions(row: CalendarDecisionRow): DecisionAction[] {
  const path = `/api/google-calendar/changes/${row.id}`;
  if (row.change_kind === "deleted") {
    return [
      { id: "cancel", label: "Cancel in CHS", path, body: { action: "cancel" } },
      { id: "ignore", label: "Ignore (recreate on Google)", path, body: { action: "ignore" } },
    ];
  }
  const silent =
    row.source_type === "schedule_entry" ? "Apply without texting" : "Apply without texting the customer";
  return [
    { id: "apply", label: "Apply", path, body: { action: "apply" } },
    { id: "apply_silent", label: silent, path, body: { action: "apply_silent" } },
    { id: "ignore", label: "Ignore (keep CHS time)", path, body: { action: "ignore" } },
  ];
}

export function calendarDecisionItems(rows: CalendarDecisionRow[]): OwnerDecisionItem[] {
  return rows
    .filter((row) => row.change_kind === "moved" || row.change_kind === "deleted")
    .map((row) => ({
      id: `gcal_${row.id}`,
      priority: "high" as const,
      type: "google_calendar_change" as const,
      title: calendarDecisionTitle(row),
      meta: {
        pendingId: row.id,
        sourceType: row.source_type,
        changeKind: row.change_kind,
      },
      link: "/",
      createdAt: row.updated_at || new Date().toISOString(),
      actions: calendarDecisionActions(row),
    }));
}

export function lateFeeAddConfirm(
  invoiceDisplay: string,
  amountLabel: string,
  jobStatus?: string | null,
): string {
  const lead = `Add a ${amountLabel} late fee to invoice ${invoiceDisplay}.`;
  if (jobStatus === "on_hold") {
    return `${lead} The job is on hold, so the customer will not be texted.`;
  }
  return `${lead} This sends the customer one text.`;
}

export function lateFeeDecisionTitle(row: LateFeeCandidate, amount: number, balance: number): string {
  const who = (row.client_name ?? "").trim() || "A customer";
  return `Add a one-time 5% late fee of ${usd(amount)} to invoice ${invoiceLabel(row.invoice_number)} for ${who}. Balance ${usd(balance)}.`;
}

/**
 * Only invoices the nightly job has marked proposed. While the switch is off
 * that job only counts, so a would-propose invoice does not appear here.
 */
export function lateFeeDecisionRows(
  rows: LateFeeCandidate[],
  today: string,
): { row: LateFeeCandidate; amount: number; balance: number }[] {
  const out: { row: LateFeeCandidate; amount: number; balance: number }[] = [];
  for (const row of rows) {
    if ((row.late_fee_state ?? "none") !== "proposed") continue;
    if (row.status === "paid" || row.status === "void" || openBalance(row) <= 0) continue;
    if (exclusionReason(row, today)) continue;
    const amount = roundAmount(row.late_fee_proposed_amount ?? lateFeeAmount(unpaidPrincipal(row)));
    if (amount <= 0) continue;
    out.push({ row, amount, balance: openBalance(row) });
  }
  return out;
}

function roundAmount(n: number): number {
  return Math.round(n * 100) / 100;
}

export function lateFeeDecisionItems(
  rows: LateFeeCandidate[],
  today: string,
): OwnerDecisionItem[] {
  return lateFeeDecisionRows(rows, today).map(({ row, amount, balance }) => {
    const display = invoiceLabel(row.invoice_number);
    const amountLabel = usd(amount);
    const path = `/api/invoices/${row.id}/late-fee`;
    return {
      id: `late_fee_${row.id}`,
      priority: "high" as const,
      type: "late_fee_proposed" as const,
      title: lateFeeDecisionTitle(row, amount, balance),
      meta: {
        invoiceId: row.id,
        jobId: row.job_id,
        invoiceNumber: display,
        amount,
        balance,
      },
      link: "/",
      createdAt: row.due_date || today,
      actions: [
        {
          id: "add",
          label: "Add fee",
          path,
          body: { action: "add" },
          confirm: lateFeeAddConfirm(display, amountLabel, row.job_status),
        },
        { id: "waive", label: "Waive", path, body: { action: "waive" } },
        { id: "snooze_3", label: "Snooze 3 days", path, body: { action: "snooze", days: 3 } },
        { id: "snooze_7", label: "Snooze 7 days", path, body: { action: "snooze", days: 7 } },
        { id: "hold", label: "Hold", path, body: { action: "hold" }, needsReason: true },
      ],
    };
  });
}

async function quietMissing(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/no such (table|column)/i.test(msg)) throw err;
  }
}

export async function loadOwnerDecisionItems(env: Env, now = new Date()): Promise<OwnerDecisionItem[]> {
  const calendar: CalendarDecisionRow[] = [];
  await quietMissing(async () => {
    const { results } = await env.DB.prepare(
      `SELECT id, source_type, change_kind, summary_label, when_label, updated_at
         FROM google_calendar_pending_changes
        WHERE status = 'pending'
        ORDER BY updated_at ASC
        LIMIT 20`,
    ).all<CalendarDecisionRow>();
    calendar.push(...(results ?? []));
  });

  let fees: OwnerDecisionItem[] = [];
  await quietMissing(async () => {
    fees = lateFeeDecisionItems(await loadCandidates(env), centralDate(now));
  });

  await quietMissing(async () => {
    await env.DB.prepare(
      `UPDATE notification_logs
          SET link_path = ?
        WHERE channel = 'in_app'
          AND is_read = 0
          AND trigger_event IN ('google_calendar_change', 'late_fee_proposed')
          AND COALESCE(link_path, '') != ?`,
    )
      .bind(HOME_DECISION_PATH, HOME_DECISION_PATH)
      .run();
  });

  return [...calendarDecisionItems(calendar), ...fees];
}

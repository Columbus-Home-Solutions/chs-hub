/**
 * Wealthy Contractor (WC) workbook trigger hooks — Sprint 3.
 *
 * The WC sync (src/lib/wc/sync.ts → compute.ts) recomputes every KBPI count
 * directly from D1 on each 30-minute cron tick. A newly created lead or a set
 * appointment is therefore already reflected at the next cycle with no extra
 * persisted state. These hooks intentionally do NOT fire an immediate sync or
 * maintain their own queue — they mark intent and log, leaving the existing
 * "recompute from source on cron" mechanism untouched (per the Sprint 3 spec:
 * "set a flag or enqueue so the next cron picks up the counts… do not reinvent
 * the sync mechanism").
 */

import type { Env } from "../../env.js";

/** Called on POST /api/estimate-requests — a new lead entered the pipeline. */
export function triggerLeadCreated(_env: Env, requestId: string): void {
  console.log(
    `[wc] lead_created request=${requestId} — WC lead count refreshes on next cron tick`,
  );
}

/** Called when a request transitions to appointment_set (status change or appointment set). */
export function triggerAppointmentSet(_env: Env, requestId: string): void {
  console.log(
    `[wc] appointment_set request=${requestId} — WC appointment count refreshes on next cron tick`,
  );
}

/**
 * Called on POST /api/estimates/:id/send — a native estimate was sent to the
 * client. Feeds two WC data points (Module-Spec-Estimating-Quoting §9):
 *   - Quotes sent count  → KBPI weekly
 *   - Quotes sent value   → Weekly Marketing Tallies (New Sales)
 *
 * Same "log intent, cron recomputes from D1" contract as the Sprint 3 hooks —
 * we do NOT fire a sync or maintain a queue here.
 *
 * Sprint 6 (decision (d)): the KBPI "estimates"/quotes-sent column now counts
 * NATIVE CHS estimates only (estimates.sent_at) — the Jobber `quotes` read was
 * removed from compute.ts. No cutover date, no reconciliation. While the native
 * count is zero the sync skips the cell (skip-don't-clobber) so Tony's manual
 * interim entry survives.
 */
export function triggerQuoteSent(_env: Env, estimateId: string, total: number): void {
  console.log(
    `[wc] quote_sent estimate=${estimateId} value=${total} — WC quotes-sent count + dollar value refresh on next cron tick`,
  );
}

/**
 * Called by the quote-to-job conversion (POST /api/estimate-requests/:id/win,
 * and later the Stripe deposit webhook) — a deal closed. Feeds two WC data
 * points (Module-Spec-Estimating-Quoting §4.10 + §9):
 *   - Closed deal count    → KBPI / Closed %
 *   - New Sales value       → Weekly Marketing Tallies
 *
 * Same "log intent, cron recomputes from D1" contract as the other hooks.
 *
 * Sprint 6 (decision (b)): the WC closed-deal count + New Sales value are now
 * computed in compute.ts from NATIVE converted `jobs` rows (source='estimate'),
 * New Sales = contract_total (convenience-fee-excluded). This hook stays a
 * log-only intent marker; the cron recompute is the source of truth.
 */
export function triggerDealWon(_env: Env, jobId: string, value: number): void {
  console.log(
    `[wc] deal_won job=${jobId} value=${value} — WC closed-deal count + New Sales value refresh on next cron tick`,
  );
}

/**
 * Called on every job status change (PUT /api/jobs/:id/status). The closed-deal
 * count + New Sales value are recomputed from converted `jobs` rows in
 * compute.ts each cron tick (Sprint 6, decision (b)), so this is a log-only
 * intent hook — same "recompute from D1" contract as the others.
 */
export function triggerJobStatusChanged(
  _env: Env,
  jobId: string,
  from: string,
  to: string,
): void {
  console.log(
    `[wc] job_status_changed job=${jobId} ${from}→${to} — WC job metrics refresh on next cron tick`,
  );
}

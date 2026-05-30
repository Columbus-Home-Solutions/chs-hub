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
 * NOTE (KBPI cutover, carried from Sprint 3): the live WC weekly "estimates"
 * column is still computed from the Jobber `quotes` table in src/lib/wc/
 * compute.ts. Pointing it at native estimates is deferred to Sprint 5 to avoid
 * double-counting historical Jobber quotes with brand-new native estimates —
 * a clean cutover needs a date boundary, which is out of scope for this
 * local-only sprint. See the Sprint 4 report.
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
 * NOTE (KBPI cutover, carried from Sprint 4): the live WC closed-deal / New
 * Sales columns are still computed from Jobber-synced jobs in src/lib/wc/
 * compute.ts. Pointing them at native conversion jobs is deferred to the Sprint
 * 5 cutover (needs a date boundary to avoid double-counting historical Jobber
 * deals with brand-new native ones). The native job row is written now, so the
 * cutover is a query change, not a backfill.
 */
export function triggerDealWon(_env: Env, jobId: string, value: number): void {
  console.log(
    `[wc] deal_won job=${jobId} value=${value} — WC closed-deal count + New Sales value refresh on next cron tick`,
  );
}

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

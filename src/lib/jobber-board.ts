import type { Env } from "../env.js";

/**
 * Imported jobs that belong on the jobs board.
 * `complete` is the Complete column. Cancelled is not a column.
 */
export const LIVE_JOBBER_STATUSES = [
  "in_progress",
  "unscheduled",
  "scheduled",
  "punch_list",
  "deposit_paid",
  "action_required",
  "complete",
] as const;

/**
 * Returned by the jobs query so search and the Cancelled list can find them.
 * groupJobPipeline drops this status, so it never becomes a board column.
 */
export const LIST_ONLY_JOBBER_STATUSES = ["cancelled"] as const;

/** Imported jobs that must not email or text a client or sub. */
export const QUIET_JOBBER_STATUSES = ["archived", "closed", "cancelled"] as const;

export const JOBBER_QUIET_SEND_MESSAGE =
  "Send skipped. This Jobber job is archived, closed, or cancelled, so no client or sub message was sent.";

const VISIBLE_SQL = [...LIVE_JOBBER_STATUSES, ...LIST_ONLY_JOBBER_STATUSES]
  .map((s) => `'${s}'`)
  .join(", ");

/**
 * Native jobs stay visible in every status. A jobber_import job shows on the
 * board while it is live work or complete. Cancelled imports stay in this
 * same predicate so header search and the Cancelled list can find them; the
 * board grouping omits cancelled, so it is not a column.
 * Archived, late, closed, and requires_invoicing imports stay hidden.
 */
export function boardJobWhere(alias = "j"): string {
  const p = alias ? `${alias}.` : "";
  return `(${p}source IN ('estimate', 'quick_job') OR (${p}data_source = 'jobber_import' AND ${p}status IN (${VISIBLE_SQL})))`;
}

/**
 * Automatic Complete side effects (review, warranty, completion package,
 * social draft, lien waiver, WC, customer text or email) stay off for every
 * Jobber import. Manual sends are unchanged.
 */
export function skipImportedCompletionEffects(source: string | null | undefined): boolean {
  return (source ?? "").trim() === "jobber_import";
}

export function isJobberImportQuiet(row: {
  data_source?: string | null;
  status?: string | null;
} | null | undefined): boolean {
  if (!row) return false;
  return (row.data_source ?? "").trim() === "jobber_import"
    && (QUIET_JOBBER_STATUSES as readonly string[]).includes((row.status ?? "").trim());
}

/** 409 the caller already toasts. Null means the send may proceed. */
export async function jobberQuietSendBlock(env: Env, jobId: string | null | undefined): Promise<Response | null> {
  if (!jobId) return null;
  const row = await env.DB.prepare("SELECT data_source, status FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ data_source: string | null; status: string | null }>();
  if (!isJobberImportQuiet(row)) return null;
  return new Response(
    JSON.stringify({
      error: "jobber_history_quiet",
      details: JOBBER_QUIET_SEND_MESSAGE,
      skipped: true,
    }),
    { status: 409, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

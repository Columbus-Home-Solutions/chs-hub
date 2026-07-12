/**
 * Auto-assign awarded subs to job schedule entries when a bid resolves.
 *
 * Two independent trigger points (award handler + quote-to-job conversion) both
 * call into this module. Assignment is idempotent per bid_request_id.
 */

import type { Env } from "../env.js";

export interface BidRequestAssignmentContext {
  id: string;
  title: string;
  scope_description: string;
  quantities_notes?: string | null;
  needed_by_date?: string | null;
  job_id: string | null;
  estimate_id: string | null;
  estimate_sub_item_id: string | null;
  awarded_sub_id: string | null;
  status: string;
}

/** Resolve the job tied to a bid request (direct job_id or converted estimate). */
export async function resolveJobIdForBidRequest(
  env: Env,
  br: Pick<BidRequestAssignmentContext, "job_id" | "estimate_id">,
): Promise<string | null> {
  if (br.job_id) return br.job_id;
  if (!br.estimate_id) return null;

  const job = await env.DB.prepare(
    `SELECT id FROM jobs
      WHERE estimate_id = ?
        AND COALESCE(conversion_reversed, 0) = 0
      ORDER BY created_at DESC
      LIMIT 1`,
  )
    .bind(br.estimate_id)
    .first<{ id: string }>();

  return job?.id ?? null;
}

/**
 * Create (or return existing) schedule_entries row for an awarded bid on a job.
 * Does not fire sub notifications — Tony sets the real date before notifying.
 */
export async function ensureBidAwardScheduleEntry(
  env: Env,
  br: BidRequestAssignmentContext,
  subId: string,
  jobId: string,
): Promise<{ created: boolean; entryId: string | null }> {
  const existing = await env.DB.prepare(
    `SELECT id FROM schedule_entries WHERE bid_request_id = ?`,
  )
    .bind(br.id)
    .first<{ id: string }>();
  if (existing) return { created: false, entryId: existing.id };

  const job = await env.DB.prepare(`SELECT start_date FROM jobs WHERE id = ?`)
    .bind(jobId)
    .first<{ start_date: string | null }>();

  const today = new Date().toISOString().slice(0, 10);
  const scheduledDate = br.needed_by_date || job?.start_date || today;

  const noteParts = ["Auto-assigned from bid award."];
  if (br.quantities_notes) noteParts.push(br.quantities_notes);
  const scopeSnippet = br.scope_description.trim().slice(0, 300);
  if (scopeSnippet) noteParts.push(scopeSnippet);

  const entryId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO schedule_entries
       (id, job_id, scheduled_date, trade_or_work, sub_id, notes,
        notification_sent, status, bid_request_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'scheduled', ?, datetime('now'))`,
  )
    .bind(entryId, jobId, scheduledDate, br.title, subId, noteParts.join("\n\n"), br.id)
    .run();

  return { created: true, entryId };
}

/** After award: link sub to job schedule when the job already exists. */
export async function assignAwardedBidToJobIfExists(
  env: Env,
  br: BidRequestAssignmentContext,
  awardedSubId: string,
): Promise<{ assigned: boolean; entryId: string | null }> {
  const jobId = await resolveJobIdForBidRequest(env, br);
  if (!jobId) return { assigned: false, entryId: null };

  const result = await ensureBidAwardScheduleEntry(env, br, awardedSubId, jobId);
  return { assigned: result.created, entryId: result.entryId };
}

/**
 * After estimate → job conversion: backfill job_id on open bids and create
 * schedule entries for bids already awarded pre-conversion.
 */
export async function syncBidRequestsOnJobConversion(
  env: Env,
  jobId: string,
  estimateId: string,
): Promise<{ backfilled: number; assigned: number }> {
  const rows = await env.DB.prepare(
    `SELECT br.id, br.title, br.scope_description, br.quantities_notes, br.needed_by_date,
            br.job_id, br.estimate_id, br.estimate_sub_item_id, br.awarded_sub_id, br.status
       FROM bid_requests br
      WHERE br.estimate_id = ?
         OR br.estimate_sub_item_id IN (
           SELECT esi.id
             FROM estimate_sub_items esi
             JOIN estimate_line_items eli ON eli.id = esi.parent_line_item_id
            WHERE eli.estimate_id = ?
         )`,
  )
    .bind(estimateId, estimateId)
    .all<BidRequestAssignmentContext>();

  let backfilled = 0;
  let assigned = 0;

  for (const br of rows.results ?? []) {
    if (!br.job_id) {
      await env.DB.prepare(
        `UPDATE bid_requests SET job_id = ? WHERE id = ? AND job_id IS NULL`,
      )
        .bind(jobId, br.id)
        .run();
      br.job_id = jobId;
      backfilled++;
    }

    if (br.status === "awarded" && br.awarded_sub_id) {
      const result = await ensureBidAwardScheduleEntry(env, br, br.awarded_sub_id, jobId);
      if (result.created) assigned++;
    }
  }

  return { backfilled, assigned };
}

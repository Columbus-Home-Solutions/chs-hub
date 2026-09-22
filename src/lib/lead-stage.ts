/**
 * Single hook for every path that changes an estimate-request status.
 * Entering Contacted starts Day 1/2/3 once. Leaving any running sequence stops it.
 * A finished sequence does not restart.
 */

import type { Env } from "../env.js";

export async function applyLeadStageChange(
  env: Env,
  requestId: string,
  fromStatus: string | null,
  toStatus: string,
): Promise<void> {
  if (fromStatus === toStatus) return;

  if (toStatus === "contacted") {
    await env.DB.prepare(
      `UPDATE estimate_requests SET
         contacted_at = datetime('now'),
         lead_outreach_count = 0,
         lead_outreach_sequence_active = 1,
         lead_outreach_completed_at = NULL,
         updated_at = datetime('now')
       WHERE id = ?
         AND lead_outreach_completed_at IS NULL`,
    )
      .bind(requestId)
      .run();
    return;
  }

  await env.DB.prepare(
    `UPDATE estimate_requests SET
       lead_outreach_sequence_active = 0,
       lead_outreach_completed_at = COALESCE(lead_outreach_completed_at, datetime('now')),
       updated_at = datetime('now')
     WHERE id = ?
       AND COALESCE(lead_outreach_sequence_active, 0) = 1`,
  )
    .bind(requestId)
    .run();
}

/** Stop every active outreach sequence on this client's open requests. */
export async function stopOutreachForClient(env: Env, clientId: string): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE estimate_requests SET
       lead_outreach_sequence_active = 0,
       lead_outreach_completed_at = COALESCE(lead_outreach_completed_at, datetime('now')),
       updated_at = datetime('now')
     WHERE client_id = ?
       AND COALESCE(lead_outreach_sequence_active, 0) = 1`,
  )
    .bind(clientId)
    .run();
  return Number(result.meta?.changes ?? 0);
}

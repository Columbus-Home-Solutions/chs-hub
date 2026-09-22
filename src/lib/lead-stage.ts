/**
 * Single hook for every path that changes an estimate-request status.
 * Entering Contacted starts Day 1/2/3 once. Leaving any running sequence stops it.
 * A finished sequence does not restart.
 */

import type { Env } from "../env.js";

/** Statuses that may move forward into Building. Never used to move a lead backward. */
export const BUILDING_ENTRY_STATUSES = ["new_request", "appointment_set", "visit_done"] as const;

export function canAdvanceToBuilding(status: string | null | undefined): boolean {
  return (BUILDING_ENTRY_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * Move an eligible lead to Building and stamp building_at through the shared hook.
 * A lead already at building or past it is left alone.
 */
export async function advanceLeadToBuildingIfEligible(
  env: Env,
  requestId: string,
  fromStatus: string | null | undefined,
): Promise<boolean> {
  if (!canAdvanceToBuilding(fromStatus)) return false;
  const result = await env.DB.prepare(
    `UPDATE estimate_requests
        SET status = 'building', updated_at = datetime('now')
      WHERE id = ? AND status = ?`,
  )
    .bind(requestId, fromStatus)
    .run();
  if (Number(result.meta?.changes ?? 0) < 1) return false;
  await applyLeadStageChange(env, requestId, fromStatus ?? null, "building");
  return true;
}

export async function applyLeadStageChange(
  env: Env,
  requestId: string,
  fromStatus: string | null,
  toStatus: string,
): Promise<void> {
  if (fromStatus === toStatus) return;

  // Re-entry resets the clock. Leaving Building does not clear it.
  if (toStatus === "building") {
    await env.DB.prepare(
      `UPDATE estimate_requests
          SET building_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(requestId)
      .run();
  }

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

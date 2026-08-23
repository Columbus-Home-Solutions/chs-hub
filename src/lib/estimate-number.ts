/**
 * Durable estimate_number allocator — NOT MAX(estimate_number)+1.
 * Uses system_settings.next_estimate_number so stray test rows with huge
 * numbers cannot inflate the live Jobber-continuation sequence.
 */

import type { Env } from "../env.js";

export const NEXT_ESTIMATE_NUMBER_KEY = "next_estimate_number";

/**
 * Read the current counter, return it as the next estimate number, then
 * bump the stored value by 1. Seeds to 279 if the key is missing (Jobber
 * handoff: last Jobber quote was 278).
 */
export async function allocateNextEstimateNumber(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = ?",
  )
    .bind(NEXT_ESTIMATE_NUMBER_KEY)
    .first<{ value: string }>();

  let next = Number.parseInt(String(row?.value ?? "").trim(), 10);
  if (!Number.isFinite(next) || next < 1) {
    next = 279;
  }

  const following = String(next + 1);
  const now = new Date().toISOString();

  if (row) {
    await env.DB.prepare(
      `UPDATE system_settings
         SET value = ?, updated_at = ?, updated_by = NULL
       WHERE key = ?`,
    )
      .bind(following, now, NEXT_ESTIMATE_NUMBER_KEY)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO system_settings
         (key, value, value_type, category, label, description, updated_at)
       VALUES (?, ?, 'number', 'estimating', 'Next estimate number',
               'Durable counter for estimates.estimate_number (Jobber handoff).', ?)`,
    )
      .bind(NEXT_ESTIMATE_NUMBER_KEY, following, now)
      .run();
  }

  return next;
}

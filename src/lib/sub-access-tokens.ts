/**
 * Persistent sub access token helpers (Sprint 34).
 *
 * One token per subcontractor, ever.  Created lazily the first time a sub
 * needs to be notified about anything; subsequent calls return the same token.
 */

import type { Env } from "../env.js";

const SUB_LINK_ORIGIN = "https://client.homesolutionsar.com";

/**
 * Idempotent: returns the existing token for this sub or creates one if none
 * exists.  Safe to call on every punch-list send / reminder without risk of
 * minting duplicate tokens.
 */
export async function resolveSubAccessToken(env: Env, subId: string): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT token FROM sub_access_tokens WHERE sub_id = ?`,
  )
    .bind(subId)
    .first<{ token: string }>();

  if (existing?.token) return existing.token;

  const token = crypto.randomUUID();
  const id = crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare(
    `INSERT INTO sub_access_tokens (id, sub_id, token, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
  )
    .bind(id, subId, token)
    .run();

  return token;
}

/** Build the persistent sub link URL from a resolved token. */
export function subAccessLink(token: string): string {
  return `${SUB_LINK_ORIGIN}/sub/${token}`;
}

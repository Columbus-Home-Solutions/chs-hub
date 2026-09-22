/**
 * Client phone/email dedup — shared by quick-lead and Thumbtack webhook.
 * Exact SQL mirrors the Sprint 23 quick-lead path (phone last-10 digits).
 */

import type { Env } from "../env.js";

export interface DedupClientMatch {
  id: string;
  first_name: string | null;
  last_name: string | null;
}

/** Normalize to last 10 digits; empty string if not a usable NANP-length number. */
export function phoneLast10(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "").slice(-10);
  return digits.length === 10 ? digits : "";
}

export async function findClientByPhone(
  env: Env,
  phone: string | null | undefined,
): Promise<DedupClientMatch | null> {
  const phoneDigits = phoneLast10(phone);
  if (!phoneDigits) return null;
  return env.DB.prepare(
    `SELECT id, first_name, last_name FROM clients
      WHERE substr(replace(replace(replace(replace(phone,'(',''),')',''),'-',''),' ',''), -10) = ?
      LIMIT 1`,
  )
    .bind(phoneDigits)
    .first<DedupClientMatch>();
}

export async function findClientByEmail(
  env: Env,
  email: string | null | undefined,
): Promise<DedupClientMatch | null> {
  if (!email?.trim()) return null;
  return env.DB.prepare(
    "SELECT id, first_name, last_name FROM clients WHERE email = ? LIMIT 1",
  )
    .bind(email.trim())
    .first<DedupClientMatch>();
}

/**
 * Insert a minimal clients row (phone only, no name, no placeholder email).
 * Caller MUST have already run findClientByPhone and gotten null.
 */
export async function createPhoneOnlyClient(
  env: Env,
  phone: string,
  opts: { leadSource: string; createdBy: string },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO clients (id, phone, lead_source, synced_at, created_at, updated_at, created_by)
     VALUES (?, ?, ?, datetime('now'), ?, ?, ?)`,
  )
    .bind(id, phone, opts.leadSource, now, now, opts.createdBy)
    .run();
  return id;
}

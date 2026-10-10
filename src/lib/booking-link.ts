/**
 * Per-lead booking URL for outreach merge. Empty while self-scheduling is off,
 * so a saved template that contains {{booking_link}} does not send a link.
 */

import type { Env } from "../env.js";
import { BOOKABLE_STATUSES, DEFAULT_RULES, TOKEN_TTL_MS, parseRules, type SchedulingRules } from "./self-scheduling.js";

const PUBLIC_ORIGIN = "https://client.homesolutionsar.com";

function publicOrigin(env: Env): string {
  return (env.APP_PUBLIC_ORIGIN ?? PUBLIC_ORIGIN).replace(/\/$/, "");
}

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function loadSchedulingRules(env: Env): Promise<SchedulingRules> {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM system_settings WHERE category = 'scheduling'",
  ).all<{ key: string; value: string }>();
  if (!results?.length) return { ...DEFAULT_RULES };
  const values: Record<string, string> = {};
  for (const row of results) values[row.key] = row.value;
  return parseRules(values);
}

export async function bookingLinkForLead(env: Env, requestId: string, now = new Date()): Promise<string> {
  const rules = await loadSchedulingRules(env);
  if (!rules.enabled) return "";
  const row = await env.DB.prepare(
    `SELECT id, status, appointment_date, booking_token, booking_token_expires_at
       FROM estimate_requests WHERE id = ?`,
  )
    .bind(requestId)
    .first<{
      id: string;
      status: string;
      appointment_date: string | null;
      booking_token: string | null;
      booking_token_expires_at: string | null;
    }>();
  if (!row || row.appointment_date) return "";
  if (!(BOOKABLE_STATUSES as readonly string[]).includes(row.status)) return "";

  let token = row.booking_token;
  const exp = row.booking_token_expires_at ? new Date(row.booking_token_expires_at).getTime() : 0;
  if (!token || Number.isNaN(exp) || exp <= now.getTime()) {
    token = newToken();
    const expires = new Date(now.getTime() + TOKEN_TTL_MS).toISOString();
    await env.DB.prepare(
      `UPDATE estimate_requests
          SET booking_token = ?, booking_token_expires_at = ?, updated_at = ?
        WHERE id = ? AND appointment_date IS NULL`,
    )
      .bind(token, expires, now.toISOString(), requestId)
      .run();
  }
  return `${publicOrigin(env)}/book/${token}`;
}

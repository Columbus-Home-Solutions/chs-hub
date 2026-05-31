/**
 * Twilio wrapper (Sprint 7 — SMS send + inbound/status webhook verification).
 *
 * Net-new this sprint (no src/lib/twilio.ts existed before). Mirrors the
 * discipline of src/lib/stripe.ts:
 *   - Credentials read from Worker secrets, never inlined.
 *   - No SDK — raw Web Crypto + fetch (Workers runtime).
 *   - A clear, non-throwing "not configured" path so the whole notification
 *     engine stays testable in simulate-mode without live credentials.
 *
 * Signature verification (the Opus-grade part — getting this wrong means
 * accepting a forged inbound SMS): Twilio signs each webhook with
 * HMAC-SHA1(authToken, fullUrl + sortedConcatenatedPostParams), base64. We
 * reconstruct the same string and constant-time compare — the same careful
 * "compute expected, timing-safe compare, decide status on every branch"
 * shape proven on the Stripe handler (incl. the multiple-signature lesson:
 * we never collapse params into an object that could drop duplicate keys).
 */

import type { Env } from "../env.js";

export interface TwilioConfig {
  accountSid: string | null;
  authToken: string | null;
  fromNumber: string | null;
}

/** Resolve Twilio config from secrets → system_settings (test values locally). */
export async function getTwilioConfig(env: Env): Promise<TwilioConfig> {
  let accountSid = (env.TWILIO_ACCOUNT_SID ?? "").trim() || null;
  let authToken = (env.TWILIO_AUTH_TOKEN ?? "").trim() || null;
  let fromNumber = (env.TWILIO_FROM_NUMBER ?? "").trim() || null;

  if (!accountSid || !authToken || !fromNumber) {
    const { results } = await env.DB.prepare(
      `SELECT key, value FROM system_settings WHERE key IN
        ('twilio_account_sid','twilio_auth_token','twilio_from_number')`,
    ).all<{ key: string; value: string }>();
    for (const r of results ?? []) {
      const v = (r.value ?? "").trim();
      if (!v) continue;
      if (r.key === "twilio_account_sid" && !accountSid) accountSid = v;
      if (r.key === "twilio_auth_token" && !authToken) authToken = v;
      if (r.key === "twilio_from_number" && !fromNumber) fromNumber = v;
    }
  }
  return { accountSid, authToken, fromNumber };
}

export function isConfigured(cfg: TwilioConfig): boolean {
  return !!(cfg.accountSid && cfg.authToken && cfg.fromNumber);
}

export type SmsResult =
  | { ok: true; sid: string }
  | { ok: false; status: number; error: string; details: string };

/** Send an SMS via the Twilio Messages API. */
export async function sendSms(cfg: TwilioConfig, to: string, body: string): Promise<SmsResult> {
  if (!isConfigured(cfg)) {
    return {
      ok: false,
      status: 503,
      error: "twilio_not_configured",
      details: "Twilio credentials are not configured (Pre-Launch item).",
    };
  }

  const form = new URLSearchParams();
  form.set("To", to);
  form.set("From", cfg.fromNumber!);
  form.set("Body", body);

  const auth = btoa(`${cfg.accountSid}:${cfg.authToken}`);
  let res: Response;
  try {
    res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      },
    );
  } catch (e) {
    return { ok: false, status: 502, error: "twilio_unreachable", details: (e as Error).message };
  }

  const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
  if (!res.ok || !data.sid) {
    return {
      ok: false,
      status: 502,
      error: "twilio_error",
      details: data.message ?? `Twilio returned ${res.status}`,
    };
  }
  return { ok: true, sid: data.sid };
}

/**
 * Verify an inbound Twilio request signature (X-Twilio-Signature).
 *
 * Twilio's algorithm: take the full request URL exactly as Twilio called it,
 * then — for application/x-www-form-urlencoded POSTs — append every POST
 * parameter sorted alphabetically by name, concatenating name then value with
 * no delimiters. HMAC-SHA1 that string with the auth token, base64-encode, and
 * compare to the header. We compute the expected value and constant-time
 * compare; any missing input or mismatch returns false (caller rejects).
 *
 * `params` is the parsed form body. We sort keys ourselves and read values from
 * the exact entries — we never round-trip through a structure that could drop a
 * repeated key (the duplicate-signature lesson from the Stripe handler).
 */
export async function verifyTwilioSignature(
  authToken: string | null,
  fullUrl: string,
  params: Array<[string, string]>,
  signature: string | null,
): Promise<boolean> {
  if (!authToken || !signature) return false;

  const sorted = [...params].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let data = fullUrl;
  for (const [k, v] of sorted) data += k + v;

  const expected = await hmacSha1Base64(authToken, data);
  return timingSafeEqual(expected, signature);
}

async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  // base64 of the raw bytes
  let bin = "";
  const bytes = new Uint8Array(sig);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Normalize a phone number to digits-only for matching (last-10 compare). */
export function phoneDigits(v: string | null | undefined): string {
  return String(v ?? "").replace(/\D/g, "");
}

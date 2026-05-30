/**
 * Stripe wrapper (Sprint 5 — deposit payments).
 *
 * The Worker never touches card data — it only creates PaymentIntents (the
 * client confirms them with Stripe Elements) and verifies inbound webhooks.
 * Keys are read from Worker secrets first, then `system_settings` (test keys
 * locally). If no secret key is configured, createPaymentIntent fails with a
 * clear, non-throwing error so the rest of the flow (signature, check path,
 * view tracking) stays testable.
 *
 * Convenience fee (Financial spec): electronic payments add a 3.5% fee that the
 * client pays on top of the deposit. The fee is CHS revenue (covers processing)
 * and is tracked separately from Stripe's own processing fee. Check/cash = no
 * fee. The deposit + fee establishes the pattern Sprint 9 reuses for invoices.
 */

import type { Env } from "../env.js";

export interface StripeConfig {
  secretKey: string | null;
  webhookSecret: string | null;
  publishableKey: string | null;
}

/** Resolve Stripe config from secrets → system_settings. */
export async function getStripeConfig(env: Env): Promise<StripeConfig> {
  let secretKey = (env.STRIPE_SECRET_KEY ?? "").trim() || null;
  let webhookSecret = (env.STRIPE_WEBHOOK_SECRET ?? "").trim() || null;
  let publishableKey = (env.STRIPE_PUBLISHABLE_KEY ?? "").trim() || null;

  if (!secretKey || !webhookSecret || !publishableKey) {
    const { results } = await env.DB.prepare(
      `SELECT key, value FROM system_settings WHERE key IN
        ('stripe_secret_key','stripe_webhook_secret','stripe_publishable_key')`,
    ).all<{ key: string; value: string }>();
    for (const r of results ?? []) {
      const v = (r.value ?? "").trim();
      if (!v) continue;
      if (r.key === "stripe_secret_key" && !secretKey) secretKey = v;
      if (r.key === "stripe_webhook_secret" && !webhookSecret) webhookSecret = v;
      if (r.key === "stripe_publishable_key" && !publishableKey) publishableKey = v;
    }
  }
  return { secretKey, webhookSecret, publishableKey };
}

export function isConfigured(cfg: StripeConfig): boolean {
  return !!cfg.secretKey;
}

/** Convenience fee in dollars for an electronic payment. round2(deposit * rate). */
export function convenienceFee(deposit: number, rate: number): number {
  return Math.round(deposit * rate * 100) / 100;
}

export interface PaymentIntentResult {
  ok: true;
  id: string;
  client_secret: string;
  amount: number; // cents
}
export interface PaymentIntentError {
  ok: false;
  status: number;
  error: string;
  details: string;
}

/**
 * Create a Stripe PaymentIntent for `amountCents`, carrying metadata used by the
 * webhook to converge on the shared conversion path.
 */
export async function createPaymentIntent(
  cfg: StripeConfig,
  args: {
    amountCents: number;
    description: string;
    metadata: Record<string, string>;
    statementDescriptor?: string;
  },
): Promise<PaymentIntentResult | PaymentIntentError> {
  if (!cfg.secretKey) {
    return {
      ok: false,
      status: 503,
      error: "stripe_not_configured",
      details:
        "Card/ACH payments aren't available yet — a Stripe key isn't configured. You can pay the deposit by check instead.",
    };
  }

  const form = new URLSearchParams();
  form.set("amount", String(Math.round(args.amountCents)));
  form.set("currency", "usd");
  form.set("description", args.description);
  // Card + ACH (us_bank_account) are the electronic methods CHS accepts.
  form.append("payment_method_types[]", "card");
  form.append("payment_method_types[]", "us_bank_account");
  for (const [k, v] of Object.entries(args.metadata)) {
    form.set(`metadata[${k}]`, v);
  }

  let res: Response;
  try {
    res = await fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (e) {
    return {
      ok: false,
      status: 502,
      error: "stripe_unreachable",
      details: (e as Error).message,
    };
  }

  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    client_secret?: string;
    amount?: number;
    error?: { message?: string };
  };
  if (!res.ok || !body.id || !body.client_secret) {
    return {
      ok: false,
      status: 502,
      error: "stripe_error",
      details: body.error?.message ?? `Stripe returned ${res.status}`,
    };
  }
  return {
    ok: true,
    id: body.id,
    client_secret: body.client_secret,
    amount: body.amount ?? Math.round(args.amountCents),
  };
}

/**
 * Verify a Stripe webhook signature (the `Stripe-Signature` header: `t=…,v1=…`).
 * Uses HMAC-SHA256 over `${t}.${payload}` and a constant-time compare. Returns
 * the parsed event on success, or null on any failure.
 */
export async function verifyWebhook(
  payload: string,
  sigHeader: string | null,
  secret: string | null,
  toleranceSeconds = 300,
): Promise<Record<string, unknown> | null> {
  if (!sigHeader || !secret) return null;

  const parts = Object.fromEntries(
    sigHeader.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  ) as Record<string, string>;
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return null;

  // Reject stale timestamps (replay protection).
  const ts = Number(t);
  if (Number.isFinite(ts) && Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) {
    return null;
  }

  const expected = await hmacSha256Hex(secret, `${t}.${payload}`);
  if (!timingSafeEqual(expected, v1)) return null;

  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

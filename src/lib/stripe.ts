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

/** Parsed Stripe-Signature header (`t=…,v1=…[,v1=…]`). */
function parseStripeSignatureHeader(sigHeader: string): { timestamp: string; v1Signatures: string[] } | null {
  let timestamp: string | null = null;
  const v1Signatures: string[] = [];
  for (const part of sigHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const prefix = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (prefix === "t") timestamp = value;
    else if (prefix === "v1") v1Signatures.push(value);
    // Ignore v0 and any future schemes (Stripe spec).
  }
  if (!timestamp || v1Signatures.length === 0) return null;
  return { timestamp, v1Signatures };
}

export type WebhookVerifyFailure =
  | "missing_header_or_secret"
  | "malformed_header"
  | "timestamp_outside_tolerance"
  | "signature_mismatch"
  | "invalid_json";

export type WebhookVerifyResult =
  | { ok: true; event: Record<string, unknown> }
  | { ok: false; reason: WebhookVerifyFailure };

/**
 * Verify a Stripe webhook signature (the `Stripe-Signature` header: `t=…,v1=…`).
 * Uses Web Crypto HMAC-SHA256 over `${t}.${payload}` (same algorithm as stripe-node's
 * SubtleCryptoProvider — no Node `crypto`, no Stripe SDK required).
 *
 * Stripe may send **multiple `v1=` entries** (secret roll overlap, or one per active
 * secret). We must accept the event if **any** v1 matches — Object.fromEntries
 * on duplicate keys kept only the last v1 and broke verification after a roll.
 */
export async function verifyWebhook(
  payload: string,
  sigHeader: string | null,
  secret: string | null,
  toleranceSeconds = 300,
): Promise<Record<string, unknown> | null> {
  const result = await verifyWebhookDetailed(payload, sigHeader, secret, toleranceSeconds);
  return result.ok ? result.event : null;
}

export async function verifyWebhookDetailed(
  payload: string,
  sigHeader: string | null,
  secret: string | null,
  toleranceSeconds = 300,
): Promise<WebhookVerifyResult> {
  if (!sigHeader || !secret) {
    return { ok: false, reason: "missing_header_or_secret" };
  }

  const parsed = parseStripeSignatureHeader(sigHeader);
  if (!parsed) return { ok: false, reason: "malformed_header" };

  const ts = Number(parsed.timestamp);
  if (Number.isFinite(ts) && Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) {
    return { ok: false, reason: "timestamp_outside_tolerance" };
  }

  const expected = await hmacSha256Hex(secret, `${parsed.timestamp}.${payload}`);
  const matched = parsed.v1Signatures.some((sig) => timingSafeEqual(expected, sig));
  if (!matched) return { ok: false, reason: "signature_mismatch" };

  try {
    return { ok: true, event: JSON.parse(payload) as Record<string, unknown> };
  } catch {
    return { ok: false, reason: "invalid_json" };
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

// ─── Sprint 22 — SetupIntent / card-on-file / off-session charge ─────────────

export interface StripeApiError {
  ok: false;
  status: number;
  error: string;
  details: string;
}
export interface StripeApiOk<T> {
  ok: true;
  data: T;
}

type StripeResult<T> = ({ ok: true } & T) | StripeApiError;

async function stripePost(
  cfg: StripeConfig,
  path: string,
  form: URLSearchParams,
): Promise<{ ok: true; body: Record<string, unknown> } | StripeApiError> {
  if (!cfg.secretKey) {
    return { ok: false, status: 503, error: "stripe_not_configured", details: "Stripe key missing." };
  }
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (e) {
    return { ok: false, status: 502, error: "stripe_unreachable", details: (e as Error).message };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: { message?: string };
  };
  if (!res.ok) {
    return {
      ok: false,
      status: res.status >= 400 && res.status < 500 ? res.status : 502,
      error: "stripe_error",
      details: (body.error as { message?: string } | undefined)?.message ?? `Stripe returned ${res.status}`,
    };
  }
  return { ok: true, body };
}

async function stripeGet(
  cfg: StripeConfig,
  path: string,
): Promise<{ ok: true; body: Record<string, unknown> } | StripeApiError> {
  if (!cfg.secretKey) {
    return { ok: false, status: 503, error: "stripe_not_configured", details: "Stripe key missing." };
  }
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com/v1/${path}`, {
      headers: { Authorization: `Bearer ${cfg.secretKey}` },
    });
  } catch (e) {
    return { ok: false, status: 502, error: "stripe_unreachable", details: (e as Error).message };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: { message?: string };
  };
  if (!res.ok) {
    return {
      ok: false,
      status: res.status >= 400 && res.status < 500 ? res.status : 502,
      error: "stripe_error",
      details: (body.error as { message?: string } | undefined)?.message ?? `Stripe returned ${res.status}`,
    };
  }
  return { ok: true, body };
}

export async function createCustomer(
  cfg: StripeConfig,
  args: { name: string; email: string },
): Promise<StripeResult<{ id: string }>> {
  const form = new URLSearchParams();
  form.set("name", args.name);
  form.set("email", args.email);
  const res = await stripePost(cfg, "customers", form);
  if (!res.ok) return res;
  const id = res.body.id as string | undefined;
  if (!id) return { ok: false, status: 502, error: "stripe_error", details: "No customer id returned." };
  return { ok: true, id };
}

export async function createSetupIntent(
  cfg: StripeConfig,
  customerId: string,
): Promise<StripeResult<{ client_secret: string }>> {
  const form = new URLSearchParams();
  form.set("customer", customerId);
  form.set("usage", "off_session");
  form.append("payment_method_types[]", "card");
  const res = await stripePost(cfg, "setup_intents", form);
  if (!res.ok) return res;
  const clientSecret = res.body.client_secret as string | undefined;
  if (!clientSecret) {
    return { ok: false, status: 502, error: "stripe_error", details: "No client_secret returned." };
  }
  return { ok: true, client_secret: clientSecret };
}

export async function attachPaymentMethod(
  cfg: StripeConfig,
  paymentMethodId: string,
  customerId: string,
): Promise<StripeResult<{ done: true }>> {
  const form = new URLSearchParams();
  form.set("customer", customerId);
  const res = await stripePost(cfg, `payment_methods/${paymentMethodId}/attach`, form);
  if (!res.ok) return res;
  return { ok: true, done: true };
}

export async function setDefaultPaymentMethod(
  cfg: StripeConfig,
  customerId: string,
  paymentMethodId: string,
): Promise<StripeResult<{ done: true }>> {
  const form = new URLSearchParams();
  form.set("invoice_settings[default_payment_method]", paymentMethodId);
  const res = await stripePost(cfg, `customers/${customerId}`, form);
  if (!res.ok) return res;
  return { ok: true, done: true };
}

export async function getPaymentMethod(
  cfg: StripeConfig,
  paymentMethodId: string,
): Promise<StripeResult<{ card_brand: string | null; card_last4: string | null }>> {
  const res = await stripeGet(cfg, `payment_methods/${paymentMethodId}`);
  if (!res.ok) return res;
  const card = res.body.card as { brand?: string; last4?: string } | undefined;
  return { ok: true, card_brand: card?.brand ?? null, card_last4: card?.last4 ?? null };
}

export async function detachPaymentMethod(
  cfg: StripeConfig,
  paymentMethodId: string,
): Promise<StripeResult<{ done: true }>> {
  const res = await stripePost(cfg, `payment_methods/${paymentMethodId}/detach`, new URLSearchParams());
  if (!res.ok) return res;
  return { ok: true, done: true };
}

export async function createOffSessionPaymentIntent(
  cfg: StripeConfig,
  args: {
    amountCents: number;
    customerId: string;
    paymentMethodId: string;
    description: string;
    metadata: Record<string, string>;
  },
): Promise<StripeResult<{ id: string; status: string }>> {
  const form = new URLSearchParams();
  form.set("amount", String(Math.round(args.amountCents)));
  form.set("currency", "usd");
  form.set("customer", args.customerId);
  form.set("payment_method", args.paymentMethodId);
  form.set("confirm", "true");
  form.set("off_session", "true");
  form.set("description", args.description);
  for (const [k, v] of Object.entries(args.metadata)) {
    form.set(`metadata[${k}]`, v);
  }
  const res = await stripePost(cfg, "payment_intents", form);
  if (!res.ok) return res;
  const id = res.body.id as string | undefined;
  const status = res.body.status as string | undefined;
  if (!id) return { ok: false, status: 502, error: "stripe_error", details: "No PaymentIntent id returned." };
  return { ok: true, id, status: status ?? "unknown" };
}

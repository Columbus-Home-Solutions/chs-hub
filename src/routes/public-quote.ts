/**
 * Public, token-gated quote delivery + Stripe webhook (Sprint 5).
 *
 * These endpoints are UNAUTHENTICATED — there is no Cloudflare Access and no
 * session. The estimate's `portal_token` is the only credential. An invalid or
 * expired token returns 404/410, never an internal error or a data leak.
 *
 * HARD RULE: sub-items NEVER appear in any public payload. Every public read
 * selects parent line-item columns only and shapes a deliberately narrow object
 * — there is no code path here that can reach estimate_sub_items.
 *
 *   GET  /api/public/quote/:token                 client-facing payload (+view track)
 *   POST /api/public/quote/:token/sign            capture digital signature
 *   POST /api/public/quote/:token/request-changes flag the request for follow-up
 *   POST /api/public/quote/:token/pay/intent      Stripe PaymentIntent (deposit + 3.5%)
 *   POST /api/public/quote/:token/pay/check       record check intent (no fee, no convert)
 *   POST /api/webhooks/stripe                      deposit succeeded → shared conversion
 *
 * The Stripe deposit is the automatic Won trigger: on payment_intent.succeeded
 * the webhook calls the SAME convertQuoteToJob() the manual "Mark as Won" modal
 * uses (src/lib/quote-to-job.ts) — one conversion path, never two.
 */

import type { Env } from "../env.js";
import { convertQuoteToJob } from "../lib/quote-to-job.js";
import { triggerDealWon } from "../lib/wc/triggers.js";
import {
  convenienceFee as computeFee,
  createPaymentIntent,
  getStripeConfig,
  isConfigured,
  verifyWebhook,
} from "../lib/stripe.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function err(status: number, error: string, details?: string): Response {
  return json({ error, details }, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Audit a public (client/token) action — attributed to the client, not a user. */
async function logPublicAudit(
  env: Env,
  token: string,
  clientEmail: string | null,
  action: string,
  estimateId: string,
  details: unknown,
): Promise<void> {
  const actor = clientEmail ?? `portal:${token.slice(0, 8)}`;
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
  )
    .bind(crypto.randomUUID(), actor, action, "estimate", estimateId, JSON.stringify(details))
    .run();
}

interface EstimateRow {
  id: string;
  estimate_number: number | null;
  request_id: string | null;
  client_id: string | null;
  title: string | null;
  billing_model: string | null;
  status: string;
  subtotal: number | null;
  tax_amount: number | null;
  total: number | null;
  deposit_amount: number | null;
  valid_days: number | null;
  expiration_date: string | null;
  portal_token: string | null;
  include_reviews: number | null;
  review_ids: string | null;
  include_contract: number | null;
  contract_text: string | null;
  client_signature: string | null;
  signed_date: string | null;
  viewed_date: string | null;
  approved_date: string | null;
  sent_at: string | null;
}

interface QuoteContext {
  est: EstimateRow;
  client_name: string | null;
  client_email: string | null;
  client_phone: string | null;
  property_address: string | null;
  property_city: string | null;
  property_state: string | null;
  property_zip: string | null;
}

async function loadByToken(env: Env, token: string): Promise<QuoteContext | null> {
  const est = await env.DB.prepare(
    `SELECT id, estimate_number, request_id, client_id, title, billing_model, status,
            subtotal, tax_amount, total, deposit_amount, valid_days, expiration_date,
            portal_token, include_reviews, review_ids, include_contract, contract_text,
            client_signature, signed_date, viewed_date, approved_date, sent_at
     FROM estimates WHERE portal_token = ?`,
  )
    .bind(token)
    .first<EstimateRow>();
  if (!est) return null;

  const ctx = await env.DB.prepare(
    `SELECT c.name AS client_name, c.first_name AS c_first, c.last_name AS c_last,
            c.email AS client_email, c.phone AS client_phone,
            er.property_address, er.property_city, er.property_state, er.property_zip
     FROM estimates e
     LEFT JOIN clients c ON c.id = e.client_id
     LEFT JOIN estimate_requests er ON er.id = e.request_id
     WHERE e.id = ?`,
  )
    .bind(est.id)
    .first<Record<string, unknown>>();

  const clientName =
    [ctx?.c_first, ctx?.c_last].filter(Boolean).join(" ").trim() ||
    (ctx?.client_name as string) ||
    null;

  return {
    est,
    client_name: clientName,
    client_email: (ctx?.client_email as string) ?? null,
    client_phone: (ctx?.client_phone as string) ?? null,
    property_address: (ctx?.property_address as string) ?? null,
    property_city: (ctx?.property_city as string) ?? null,
    property_state: (ctx?.property_state as string) ?? null,
    property_zip: (ctx?.property_zip as string) ?? null,
  };
}

function isExpired(est: EstimateRow): boolean {
  if (!est.expiration_date) return false;
  // expiration_date is a YYYY-MM-DD date; the quote is valid through that day.
  const exp = new Date(`${est.expiration_date}T23:59:59Z`).getTime();
  return Number.isFinite(exp) && Date.now() > exp;
}

/**
 * Build the client-facing payload. PARENT LINE ITEMS ONLY — this function never
 * touches estimate_sub_items, and the SELECT below lists exact safe columns.
 */
async function publicPayload(env: Env, qc: QuoteContext, cfg: { publishableKey: string | null; configured: boolean }) {
  const e = qc.est;
  const total = round2(e.total ?? 0);

  const lineItems = (
    await env.DB.prepare(
      `SELECT id, sort_order, product_service, description, quantity, unit, unit_price, total, includes_note
       FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order ASC`,
    )
      .bind(e.id)
      .all<{
        id: string;
        sort_order: number;
        product_service: string;
        description: string;
        quantity: number | null;
        unit: string | null;
        unit_price: number | null;
        total: number | null;
        includes_note: string | null;
      }>()
  ).results ?? [];

  const schedule = (
    await env.DB.prepare(
      `SELECT id, sort_order, description, percentage, fixed_amount, amount, is_deposit, trigger
       FROM payment_schedules WHERE estimate_id = ? ORDER BY sort_order ASC`,
    )
      .bind(e.id)
      .all<{
        id: string;
        sort_order: number;
        description: string;
        percentage: number | null;
        fixed_amount: number | null;
        amount: number | null;
        is_deposit: number | null;
        trigger: string | null;
      }>()
  ).results ?? [];

  // Selected reviews (social proof). Honors the builder's include_reviews flag
  // and selected ids; falls back to the top active reviews like the preview.
  let reviews: Array<Record<string, unknown>> = [];
  if ((e.include_reviews ?? 1) === 1) {
    let ids: string[] = [];
    if (e.review_ids) {
      try {
        const parsed = JSON.parse(e.review_ids);
        if (Array.isArray(parsed)) ids = parsed.map((x) => String(x));
      } catch {
        ids = e.review_ids.split(",").map((s) => s.trim()).filter(Boolean);
      }
    }
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      const rows = (
        await env.DB.prepare(
          `SELECT id, reviewer_name, rating, review_text, review_date, source
           FROM saved_reviews WHERE id IN (${placeholders}) AND is_active = 1`,
        )
          .bind(...ids)
          .all<Record<string, unknown>>()
      ).results ?? [];
      reviews = rows;
    } else {
      const rows = (
        await env.DB.prepare(
          `SELECT id, reviewer_name, rating, review_text, review_date, source
           FROM saved_reviews WHERE is_active = 1
           ORDER BY COALESCE(sort_order, 9999) ASC, created_at DESC LIMIT 3`,
        ).all<Record<string, unknown>>()
      ).results ?? [];
      reviews = rows;
    }
  }

  return {
    token: e.portal_token,
    estimate_number: e.estimate_number,
    status: e.status,
    expired: isExpired(e),
    title: e.title,
    billing_model: e.billing_model,
    company_name: "Columbus Home Solutions",
    client_name: qc.client_name,
    client_phone: qc.client_phone,
    property_address: qc.property_address,
    property_city: qc.property_city,
    property_state: qc.property_state,
    property_zip: qc.property_zip,
    subtotal: round2(e.subtotal ?? 0),
    tax_amount: round2(e.tax_amount ?? 0),
    total,
    deposit_amount: e.deposit_amount != null ? round2(e.deposit_amount) : null,
    valid_days: e.valid_days ?? 7,
    sent_date: e.sent_at,
    viewed_date: e.viewed_date,
    expiration_date: e.expiration_date,
    signed: !!e.client_signature,
    client_signature: e.client_signature,
    signed_date: e.signed_date,
    approved_date: e.approved_date,
    include_contract: (e.include_contract ?? 1) === 1,
    contract_text: (e.include_contract ?? 1) === 1 ? e.contract_text : null,
    convenience_fee_rate: 0.035,
    stripe_enabled: cfg.configured,
    stripe_publishable_key: cfg.publishableKey,
    // PARENT line items only — sub-items are intentionally absent.
    line_items: lineItems.map((li) => ({
      id: li.id,
      product_service: li.product_service,
      description: li.description,
      quantity: li.quantity,
      unit: li.unit,
      unit_price: li.unit_price,
      total: round2((li.quantity ?? 0) * (li.unit_price ?? 0)),
      includes_note: li.includes_note,
    })),
    payment_schedule: schedule.map((p) => ({
      id: p.id,
      description: p.description,
      percentage: p.percentage,
      amount:
        p.fixed_amount != null
          ? round2(p.fixed_amount)
          : p.percentage != null
            ? round2((p.percentage / 100) * total)
            : round2(p.amount ?? 0),
      is_deposit: (p.is_deposit ?? 0) === 1,
      trigger: p.trigger,
    })),
    reviews: reviews.map((r) => ({
      id: r.id,
      reviewer_name: r.reviewer_name,
      rating: r.rating,
      review_text: r.review_text,
      review_date: r.review_date,
      source: r.source,
    })),
  };
}

// ─── GET /api/public/quote/:token ─────────────────────────────────────────────

export async function handlePublicQuoteGet(env: Env, token: string): Promise<Response> {
  const qc = await loadByToken(env, token);
  if (!qc) return err(404, "not_found", "This quote link is invalid or no longer available.");

  // First load of a sent quote flips it to viewed + stamps viewed_date.
  if (qc.est.status === "sent") {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "UPDATE estimates SET status = 'viewed', viewed_date = ?, updated_at = ? WHERE id = ?",
    )
      .bind(now, now, qc.est.id)
      .run();
    qc.est.status = "viewed";
    qc.est.viewed_date = now;
    await logPublicAudit(env, token, qc.client_email, "quote_viewed", qc.est.id, {
      estimate_number: qc.est.estimate_number,
    });
  }

  const cfg = await getStripeConfig(env);
  const payload = await publicPayload(env, qc, {
    publishableKey: cfg.publishableKey,
    configured: isConfigured(cfg),
  });
  return json({ quote: payload });
}

// ─── POST /api/public/quote/:token/sign ───────────────────────────────────────

export async function handlePublicQuoteSign(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const qc = await loadByToken(env, token);
  if (!qc) return err(404, "not_found", "This quote link is invalid or no longer available.");
  const e = qc.est;

  if (isExpired(e)) {
    return err(410, "expired", "This quote has expired and can no longer be signed.");
  }
  if (!["sent", "viewed"].includes(e.status)) {
    return err(409, "invalid_state", `This quote can't be signed from status '${e.status}'.`);
  }

  const body = await readJson(request);
  const signature = str(body?.signature);
  if (!signature) return err(400, "bad_request", "A typed signature (full name) is required.");
  const signedDate = str(body?.date) ?? new Date().toISOString().slice(0, 10);

  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE estimates SET client_signature = ?, signed_date = ?, updated_at = ? WHERE id = ?",
  )
    .bind(signature, signedDate, now, e.id)
    .run();

  await logPublicAudit(env, token, qc.client_email, "quote_signed", e.id, {
    signature,
    signed_date: signedDate,
  });

  const reloaded = await loadByToken(env, token);
  const cfg = await getStripeConfig(env);
  const payload = await publicPayload(env, reloaded!, {
    publishableKey: cfg.publishableKey,
    configured: isConfigured(cfg),
  });
  return json({ quote: payload });
}

// ─── POST /api/public/quote/:token/request-changes ────────────────────────────

export async function handlePublicQuoteRequestChanges(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const qc = await loadByToken(env, token);
  if (!qc) return err(404, "not_found", "This quote link is invalid or no longer available.");
  const e = qc.est;

  const body = await readJson(request);
  const message = str(body?.message);

  // Flip the linked request to follow_up so it surfaces for Tony to act on.
  // The client never edits the estimate — this only logs intent + flags it.
  if (e.request_id) {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE estimate_requests
       SET status = CASE WHEN status IN ('won','lost') THEN status ELSE 'follow_up' END,
           updated_at = ?
       WHERE id = ?`,
    )
      .bind(now, e.request_id)
      .run();
  }

  await logPublicAudit(env, token, qc.client_email, "quote_changes_requested", e.id, {
    request_id: e.request_id,
    message,
  });

  return json({
    ok: true,
    message:
      "Thanks — we've let the team know you'd like some changes. Tony will reach out to you shortly.",
  });
}

// ─── POST /api/public/quote/:token/pay/check ──────────────────────────────────

export async function handlePublicQuotePayCheck(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const qc = await loadByToken(env, token);
  if (!qc) return err(404, "not_found", "This quote link is invalid or no longer available.");
  const e = qc.est;

  if (isExpired(e)) {
    return err(410, "expired", "This quote has expired. Please contact us for an updated quote.");
  }
  if (!e.client_signature) {
    return err(409, "signature_required", "Please sign the service agreement before arranging payment.");
  }

  // Pull the mailing address for instructions.
  const settings = await env.DB.prepare(
    "SELECT key, value FROM system_settings WHERE key IN ('company_name','company_address')",
  ).all<{ key: string; value: string }>();
  const sm: Record<string, string> = {};
  for (const r of settings.results ?? []) sm[r.key] = r.value;

  const estLabel = `EST-${String(e.estimate_number ?? 0).padStart(3, "0")}`;

  // Check intent is recorded for follow-up. It does NOT mark the deal won —
  // Tony confirms receipt later via the Sprint 4 "Mark as Won" modal.
  await logPublicAudit(env, token, qc.client_email, "quote_check_intent", e.id, {
    deposit_amount: e.deposit_amount,
    estimate_number: e.estimate_number,
  });

  return json({
    ok: true,
    method: "check",
    deposit_amount: e.deposit_amount != null ? round2(e.deposit_amount) : null,
    convenience_fee: 0,
    reference: estLabel,
    instructions: {
      payable_to: sm.company_name ?? "Columbus Home Solutions, LLC",
      mailing_address: sm.company_address ?? "",
      memo: `Deposit — ${estLabel}`,
      note: "No convenience fee applies to check payments. Your project is scheduled once we confirm the deposit has cleared.",
    },
  });
}

// ─── POST /api/public/quote/:token/pay/intent ─────────────────────────────────

export async function handlePublicQuotePayIntent(
  _request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const qc = await loadByToken(env, token);
  if (!qc) return err(404, "not_found", "This quote link is invalid or no longer available.");
  const e = qc.est;

  if (isExpired(e)) {
    return err(410, "expired", "This quote has expired and can no longer be paid.");
  }
  if (!e.client_signature) {
    return err(409, "signature_required", "Please sign the service agreement before paying the deposit.");
  }
  const deposit = round2(e.deposit_amount ?? 0);
  if (deposit <= 0) {
    return err(400, "no_deposit", "No deposit amount is configured for this quote.");
  }

  const cfg = await getStripeConfig(env);
  const fee = computeFee(deposit, 0.035);
  const totalCharge = round2(deposit + fee);

  const intent = await createPaymentIntent(cfg, {
    amountCents: Math.round(totalCharge * 100),
    description: `Deposit — EST-${String(e.estimate_number ?? 0).padStart(3, "0")}`,
    metadata: {
      kind: "deposit",
      estimate_id: e.id,
      request_id: e.request_id ?? "",
      token,
      deposit: String(deposit),
      convenience_fee: String(fee),
    },
  });

  if (!intent.ok) {
    return err(intent.status, intent.error, intent.details);
  }

  await logPublicAudit(env, token, qc.client_email, "quote_payment_intent", e.id, {
    payment_intent_id: intent.id,
    deposit,
    convenience_fee: fee,
    total_charge: totalCharge,
  });

  return json({
    ok: true,
    client_secret: intent.client_secret,
    publishable_key: cfg.publishableKey,
    deposit_amount: deposit,
    convenience_fee: fee,
    total_charge: totalCharge,
    disclosure: `Deposit: ${usd(deposit)} + Convenience Fee (3.5%): ${usd(fee)} = Total: ${usd(totalCharge)}`,
  });
}

function usd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

// ─── POST /api/webhooks/stripe ────────────────────────────────────────────────

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const cfg = await getStripeConfig(env);
  const payload = await request.text();
  const sig = request.headers.get("stripe-signature");

  const event = await verifyWebhook(payload, sig, cfg.webhookSecret);
  if (!event) {
    return err(400, "invalid_signature", "Webhook signature verification failed.");
  }

  const type = String(event.type ?? "");
  // Only deposit PaymentIntents drive conversion. Everything else is ack'd 200.
  if (type !== "payment_intent.succeeded") {
    return json({ received: true, ignored: type });
  }

  const obj = ((event.data as Record<string, unknown>)?.object ?? {}) as Record<string, unknown>;
  const metadata = (obj.metadata ?? {}) as Record<string, string>;
  if (metadata.kind !== "deposit") {
    return json({ received: true, ignored: "non_deposit_intent" });
  }

  const requestId = metadata.request_id;
  const estimateId = metadata.estimate_id;
  const token = metadata.token ?? "";
  const deposit = Number(metadata.deposit);
  const fee = Number(metadata.convenience_fee);
  const stripePaymentId = String(obj.id ?? "");

  if (!requestId || !Number.isFinite(deposit) || deposit <= 0) {
    // Ack so Stripe stops retrying a malformed intent, but record nothing.
    return json({ received: true, ignored: "missing_metadata" });
  }

  // Best-effort: pull Stripe's processing fee if the charge expanded it.
  let stripeFee: number | null = null;
  try {
    const charges = (obj.charges as { data?: Array<Record<string, unknown>> })?.data;
    const bt = charges?.[0]?.balance_transaction as { fee?: number } | undefined;
    if (bt && typeof bt.fee === "number") stripeFee = round2(bt.fee / 100);
  } catch {
    stripeFee = null;
  }

  // CONVERGENCE: the same engine the manual "Mark as Won" modal calls. The only
  // difference is the source of the payment data. Idempotent — a retry on an
  // already-converted request returns already_won and is ack'd 200 below.
  const outcome = await convertQuoteToJob(
    env,
    requestId,
    {
      amount: deposit,
      method: "stripe",
      reference: stripePaymentId || null,
      convenienceFee: Number.isFinite(fee) ? fee : null,
      stripeFee,
      stripePaymentId: stripePaymentId || null,
    },
    null,
  );

  if (!outcome.ok) {
    if (outcome.error === "already_won") {
      return json({ received: true, idempotent: true });
    }
    // Log and ack (200) — returning non-2xx makes Stripe retry indefinitely.
    await logPublicAudit(env, token, null, "quote_deposit_failed", estimateId ?? requestId, {
      error: outcome.error,
      details: outcome.details,
    });
    return json({ received: true, conversion_error: outcome.error });
  }

  await logPublicAudit(env, token, null, "quote_deposit_paid", estimateId ?? requestId, {
    job_id: outcome.jobId,
    job_number: outcome.jobNumber,
    payment_id: outcome.paymentId,
    deposit,
    convenience_fee: Number.isFinite(fee) ? fee : null,
    stripe_payment_id: stripePaymentId,
  });

  // WC closed-deal count + New Sales value track the contract total.
  triggerDealWon(env, outcome.jobId, outcome.total);

  return json({ received: true, job_id: outcome.jobId, job_number: outcome.jobNumber });
}

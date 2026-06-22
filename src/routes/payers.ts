/**
 * Payers API — Sprint 22 (third-party billing entities).
 *
 *   GET    /api/payers                         list all payers
 *   POST   /api/payers                         create payer
 *   GET    /api/payers/:id                     detail + linked jobs
 *   PUT    /api/payers/:id                     update non-Stripe fields
 *   DELETE /api/payers/:id                     delete (blocked if jobs linked)
 *   POST   /api/payers/:id/setup-intent        Stripe SetupIntent for card on file
 *   POST   /api/payers/:id/save-payment-method attach card after Elements confirm
 *   DELETE /api/payers/:id/payment-method      remove saved card
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import {
  attachPaymentMethod,
  createCustomer,
  createSetupIntent,
  detachPaymentMethod,
  getPaymentMethod,
  getStripeConfig,
  setDefaultPaymentMethod,
} from "../lib/stripe.js";

const WRITE_ROLES = ["owner", "project_manager", "office_admin"] as const;

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

export interface PayerRow {
  id: string;
  company_name: string | null;
  contact_name: string;
  email: string;
  phone: string | null;
  billing_address: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_zip: string | null;
  stripe_customer_id: string | null;
  stripe_payment_method_id: string | null;
  card_brand: string | null;
  card_last4: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

const PAYER_COLUMNS = `id, company_name, contact_name, email, phone,
  billing_address, billing_city, billing_state, billing_zip,
  stripe_customer_id, stripe_payment_method_id, card_brand, card_last4,
  notes, created_at, updated_at, created_by`;

function shapePayer(r: PayerRow, jobCount = 0) {
  return {
    id: r.id,
    company_name: r.company_name,
    contact_name: r.contact_name,
    email: r.email,
    phone: r.phone,
    billing_address: r.billing_address,
    billing_city: r.billing_city,
    billing_state: r.billing_state,
    billing_zip: r.billing_zip,
    stripe_customer_id: r.stripe_customer_id,
    stripe_payment_method_id: r.stripe_payment_method_id,
    card_brand: r.card_brand,
    card_last4: r.card_last4,
    has_card_on_file: !!r.stripe_payment_method_id,
    notes: r.notes,
    job_count: jobCount,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
  };
}

async function jobCountForPayer(env: Env, payerId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE payer_id = ?")
    .bind(payerId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function loadPayer(env: Env, id: string): Promise<PayerRow | null> {
  return env.DB.prepare(`SELECT ${PAYER_COLUMNS} FROM payers WHERE id = ?`)
    .bind(id)
    .first<PayerRow>();
}

async function logAudit(
  env: Env,
  userEmail: string,
  action: string,
  entityId: string,
  details: unknown,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, 'payer', ?, ?, datetime('now'))",
  )
    .bind(crypto.randomUUID(), userEmail, action, entityId, JSON.stringify(details))
    .run();
}

// ─── GET /api/payers ──────────────────────────────────────────────────────────

export async function handlePayerList(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT p.*,
            (SELECT COUNT(*) FROM jobs j WHERE j.payer_id = p.id) AS job_count
       FROM payers p
       ORDER BY COALESCE(p.company_name, ''), p.contact_name`,
  ).all<PayerRow & { job_count: number }>();

  const payers = (results ?? []).map((r) => shapePayer(r, r.job_count));
  return json({ total: payers.length, payers });
}

// ─── POST /api/payers ─────────────────────────────────────────────────────────

export async function handlePayerCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const contactName = str(body.contact_name);
  const email = str(body.email);
  if (!contactName) return err(400, "bad_request", "contact_name is required.");
  if (!email) return err(400, "bad_request", "email is required.");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO payers (
       id, company_name, contact_name, email, phone,
       billing_address, billing_city, billing_state, billing_zip,
       notes, created_at, updated_at, created_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      str(body.company_name),
      contactName,
      email,
      str(body.phone),
      str(body.billing_address),
      str(body.billing_city),
      str(body.billing_state),
      str(body.billing_zip),
      str(body.notes),
      now,
      now,
      user.email,
    )
    .run();

  await logAudit(env, user.email, "payer_created", id, { contact_name: contactName, email });
  const payer = await loadPayer(env, id);
  return json({ payer: payer ? shapePayer(payer, 0) : null }, { status: 201 });
}

// ─── GET /api/payers/:id ──────────────────────────────────────────────────────

export async function handlePayerGet(env: Env, id: string): Promise<Response> {
  const payer = await loadPayer(env, id);
  if (!payer) return err(404, "not_found", "Payer not found.");

  const jobCount = await jobCountForPayer(env, id);
  const { results: jobs } = await env.DB.prepare(
    `SELECT id, title, status, created_at FROM jobs WHERE payer_id = ? ORDER BY created_at DESC`,
  )
    .bind(id)
    .all<{ id: string; title: string | null; status: string | null; created_at: string | null }>();

  return json({
    payer: shapePayer(payer, jobCount),
    jobs: jobs ?? [],
  });
}

// ─── PUT /api/payers/:id ──────────────────────────────────────────────────────

export async function handlePayerUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await loadPayer(env, id);
  if (!existing) return err(404, "not_found", "Payer not found.");

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const editable = [
    "company_name",
    "contact_name",
    "email",
    "phone",
    "billing_address",
    "billing_city",
    "billing_state",
    "billing_zip",
    "notes",
  ] as const;
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const field of editable) {
    if (field in body) {
      sets.push(`${field} = ?`);
      binds.push(str(body[field]));
    }
  }
  if (sets.length === 0) return err(400, "bad_request", "No updatable fields provided.");

  if ("contact_name" in body && !str(body.contact_name)) {
    return err(400, "bad_request", "contact_name cannot be empty.");
  }
  if ("email" in body && !str(body.email)) {
    return err(400, "bad_request", "email cannot be empty.");
  }

  sets.push("updated_at = ?");
  binds.push(new Date().toISOString());
  binds.push(id);

  await env.DB.prepare(`UPDATE payers SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  await logAudit(env, user.email, "payer_updated", id, { fields: Object.keys(body) });

  const jobCount = await jobCountForPayer(env, id);
  const payer = await loadPayer(env, id);
  return json({ payer: payer ? shapePayer(payer, jobCount) : null });
}

// ─── DELETE /api/payers/:id ───────────────────────────────────────────────────

export async function handlePayerDelete(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const existing = await loadPayer(env, id);
  if (!existing) return err(404, "not_found", "Payer not found.");

  const jobCount = await jobCountForPayer(env, id);
  if (jobCount > 0) {
    return err(
      409,
      "payer_linked",
      `This payer is linked to ${jobCount} active job(s) and cannot be deleted.`,
    );
  }

  await env.DB.prepare("DELETE FROM payers WHERE id = ?").bind(id).run();
  await logAudit(env, user.email, "payer_deleted", id, { contact_name: existing.contact_name });
  return json({ ok: true });
}

// ─── POST /api/payers/:id/setup-intent ────────────────────────────────────────

export async function handlePayerSetupIntent(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;

  const payer = await loadPayer(env, id);
  if (!payer) return err(404, "not_found", "Payer not found.");

  const cfg = await getStripeConfig(env);
  if (!cfg.secretKey) {
    return err(503, "stripe_not_configured", "Stripe is not configured.");
  }

  let customerId = payer.stripe_customer_id;
  if (!customerId) {
    const name = payer.company_name
      ? `${payer.company_name} (${payer.contact_name})`
      : payer.contact_name;
    const created = await createCustomer(cfg, { name, email: payer.email });
    if (!created.ok) return err(created.status, created.error, created.details);
    customerId = created.id;
    await env.DB.prepare(
      "UPDATE payers SET stripe_customer_id = ?, updated_at = ? WHERE id = ?",
    )
      .bind(customerId, new Date().toISOString(), id)
      .run();
  }

  const intent = await createSetupIntent(cfg, customerId);
  if (!intent.ok) return err(intent.status, intent.error, intent.details);

  return json({
    client_secret: intent.client_secret,
    stripe_customer_id: customerId,
    publishable_key: cfg.publishableKey,
  });
}

// ─── POST /api/payers/:id/save-payment-method ─────────────────────────────────

export async function handlePayerSavePaymentMethod(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const payer = await loadPayer(env, id);
  if (!payer) return err(404, "not_found", "Payer not found.");
  if (!payer.stripe_customer_id) {
    return err(400, "no_customer", "Run setup-intent first to create a Stripe customer.");
  }

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");
  const paymentMethodId = str(body.payment_method_id);
  if (!paymentMethodId) return err(400, "bad_request", "payment_method_id is required.");

  const cfg = await getStripeConfig(env);
  if (!cfg.secretKey) return err(503, "stripe_not_configured", "Stripe is not configured.");

  const attach = await attachPaymentMethod(cfg, paymentMethodId, payer.stripe_customer_id);
  if (!attach.ok) return err(attach.status, attach.error, attach.details);

  const setDefault = await setDefaultPaymentMethod(cfg, payer.stripe_customer_id, paymentMethodId);
  if (!setDefault.ok) return err(setDefault.status, setDefault.error, setDefault.details);

  const pm = await getPaymentMethod(cfg, paymentMethodId);
  if (!pm.ok) return err(pm.status, pm.error, pm.details);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE payers SET stripe_payment_method_id = ?, card_brand = ?, card_last4 = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(paymentMethodId, pm.card_brand, pm.card_last4, now, id)
    .run();

  await logAudit(env, user.email, "payer_card_saved", id, {
    card_brand: pm.card_brand,
    card_last4: pm.card_last4,
  });

  const updated = await loadPayer(env, id);
  const jobCount = await jobCountForPayer(env, id);
  return json({ payer: updated ? shapePayer(updated, jobCount) : null });
}

// ─── DELETE /api/payers/:id/payment-method ────────────────────────────────────

export async function handlePayerRemovePaymentMethod(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const payer = await loadPayer(env, id);
  if (!payer) return err(404, "not_found", "Payer not found.");
  if (!payer.stripe_payment_method_id) {
    return err(400, "no_card", "No card on file for this payer.");
  }

  const cfg = await getStripeConfig(env);
  if (cfg.secretKey) {
    await detachPaymentMethod(cfg, payer.stripe_payment_method_id);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE payers SET stripe_payment_method_id = NULL, card_brand = NULL, card_last4 = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(now, id)
    .run();

  await logAudit(env, user.email, "payer_card_removed", id, {});
  const updated = await loadPayer(env, id);
  const jobCount = await jobCountForPayer(env, id);
  return json({ payer: updated ? shapePayer(updated, jobCount) : null });
}

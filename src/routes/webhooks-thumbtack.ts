/**
 * Thumbtack lead webhook — Step 2: real clients + estimate_requests creation.
 *
 *   POST /api/webhooks/thumbtack/leads/:secret
 *
 * Auth (defense in depth):
 *   1. Unguessable path secret (system_settings.thumbtack_webhook_secret)
 *   2. Header X-Thumbtack-Webhook-Secret === env.THUMBTACK_WEBHOOK_SECRET
 *
 * Only eventType NegotiationCreatedV4 creates a lead. Other events are logged
 * and ignored (200). Processing errors also return 200 after DLQ log.
 */

import type { Env } from "../env.js";
import { findClientByPhone } from "../lib/client-dedup.js";
import { createOwnerInApp } from "../lib/notification-engine.js";
import { triggerLeadCreated } from "../lib/wc/triggers.js";

export const THUMBTACK_WEBHOOK_SECRET_KEY = "thumbtack_webhook_secret";
export const THUMBTACK_CAPTURE_JOB = "thumbtack_webhook_capture";
const JOB_UNHANDLED = "thumbtack_webhook_unhandled_event";
const JOB_ERROR = "thumbtack_webhook_processing_error";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function secretsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function getOrCreateThumbtackWebhookSecret(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = ?")
    .bind(THUMBTACK_WEBHOOK_SECRET_KEY)
    .first<{ value: string }>();
  if (row?.value?.trim()) return row.value.trim();

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
     VALUES (?, ?, 'string', 'integrations', 'Thumbtack webhook path secret',
             'Unguessable path segment for POST /api/webhooks/thumbtack/leads/:secret.',
             datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  )
    .bind(THUMBTACK_WEBHOOK_SECRET_KEY, token)
    .run();
  return token;
}

async function logDlq(
  env: Env,
  jobName: string,
  entityId: string | null,
  payload: unknown,
  errorMessage: string,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sync_dead_letters
       (job_name, entity_type, entity_id, payload, error_message,
        first_seen_at, last_seen_at, attempts, last_attempt_status, resolved_at)
     VALUES (?, 'webhook_capture', ?, ?, ?, ?, ?, 1, 'captured', ?)`,
  )
    .bind(
      jobName,
      entityId ?? crypto.randomUUID(),
      JSON.stringify(payload),
      errorMessage.slice(0, 1000),
      now,
      now,
      now,
    )
    .run();
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

interface ThumbtackLocation {
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
}

interface ThumbtackDetail {
  question?: string;
  answer?: string;
}

interface ThumbtackPayload {
  event?: { eventType?: string; webhookID?: string; triggeredAt?: string };
  data?: {
    negotiationID?: string;
    customer?: {
      customerID?: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
    };
    request?: {
      description?: string;
      category?: { categoryID?: string; name?: string };
      location?: ThumbtackLocation;
      details?: ThumbtackDetail[];
    };
    status?: string;
    leadPrice?: string;
    [k: string]: unknown;
  };
}

function composeNotes(data: NonNullable<ThumbtackPayload["data"]>): string {
  const parts: string[] = [];
  const category = str(data.request?.category?.name);
  if (category) parts.push(`Thumbtack category: ${category}`);
  const description = str(data.request?.description);
  if (description) parts.push(description);
  for (const d of data.request?.details ?? []) {
    const q = str(d.question);
    const a = str(d.answer);
    if (q && a) parts.push(`${q}: ${a}`);
    else if (q) parts.push(q);
    else if (a) parts.push(a);
  }
  if (str(data.leadPrice)) parts.push(`Lead price: ${data.leadPrice}`);
  return parts.join("\n\n") || "Thumbtack lead";
}

function composeAddress(loc: ThumbtackLocation | undefined): string {
  const a1 = str(loc?.address1) ?? "Unknown";
  const a2 = str(loc?.address2);
  return a2 ? `${a1}, ${a2}` : a1;
}

async function processNegotiationCreated(
  env: Env,
  body: ThumbtackPayload,
): Promise<{ ok: true; request_id: string; client_id: string; deduped: boolean } | { ok: false; error: string }> {
  const data = body.data;
  const negotiationId = str(data?.negotiationID);
  if (!negotiationId) return { ok: false, error: "missing data.negotiationID" };

  const existing = await env.DB.prepare(
    "SELECT id FROM estimate_requests WHERE thumbtack_negotiation_id = ?",
  )
    .bind(negotiationId)
    .first<{ id: string }>();
  if (existing) {
    return { ok: true, request_id: existing.id, client_id: "", deduped: true };
  }

  const firstName = str(data?.customer?.firstName) ?? "Unknown";
  const lastName = str(data?.customer?.lastName) ?? "Lead";
  const phone = str(data?.customer?.phone);
  if (!phone) return { ok: false, error: "missing data.customer.phone" };

  const matched = await findClientByPhone(env, phone);
  const now = new Date().toISOString();
  let clientId: string;

  if (matched) {
    clientId = matched.id;
  } else {
    clientId = crypto.randomUUID();
    const placeholderEmail = `thumbtack_${clientId.slice(0, 8)}@thumbtack.placeholder`;
    await env.DB.prepare(
      `INSERT INTO clients (id, first_name, last_name, email, phone, lead_source, synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'thumbtack', datetime('now'), ?, ?)`,
    )
      .bind(clientId, firstName, lastName, placeholderEmail, phone, now, now)
      .run();
  }

  const max = await env.DB.prepare(
    "SELECT COALESCE(MAX(request_number), 0) AS n FROM estimate_requests",
  ).first<{ n: number }>();
  const requestNumber = (max?.n ?? 0) + 1;
  const requestId = crypto.randomUUID();
  const loc = data?.request?.location;
  const notes = composeNotes(data!);
  const categoryName = str(data?.request?.category?.name);

  await env.DB.prepare(
    `INSERT INTO estimate_requests (
       id, request_number, status, client_id,
       property_address, property_city, property_state, property_zip,
       job_type, lead_source, source, visit_notes,
       thumbtack_negotiation_id, thumbtack_raw_payload,
       created_at, updated_at, created_by
     ) VALUES (?, ?, 'new_request', ?, ?, ?, ?, ?, 'other', 'thumbtack', 'thumbtack', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      requestId,
      requestNumber,
      clientId,
      composeAddress(loc),
      str(loc?.city) ?? "Unknown",
      str(loc?.state) ?? "Arkansas",
      str(loc?.zipCode) ?? "00000",
      notes,
      negotiationId,
      JSON.stringify(data),
      now,
      now,
      "thumbtack_webhook",
    )
    .run();

  const customerName = `${firstName} ${lastName}`.trim();
  await createOwnerInApp(env, {
    message: `New lead from Thumbtack: ${customerName} — ${categoryName ?? "Lead"}`,
    linkPath: `/app/estimating/${requestId}`,
    clientId,
    dedupe: `thumbtack:${negotiationId}`,
  });

  triggerLeadCreated(env, requestId);

  return { ok: true, request_id: requestId, client_id: clientId, deduped: false };
}

export async function handleThumbtackLeadsWebhook(
  request: Request,
  env: Env,
  pathSecret: string,
): Promise<Response> {
  const pathExpected = await getOrCreateThumbtackWebhookSecret(env);
  if (!pathSecret || !secretsEqual(pathSecret, pathExpected)) {
    return json({ error: "not_found" }, 404);
  }

  const headerSecret = (request.headers.get("X-Thumbtack-Webhook-Secret") ?? "").trim();
  const workerSecret = (env.THUMBTACK_WEBHOOK_SECRET ?? "").trim();
  if (!workerSecret || !headerSecret || !secretsEqual(headerSecret, workerSecret)) {
    return json({ error: "unauthorized" }, 401);
  }

  const rawBody = await request.text();
  let body: ThumbtackPayload;
  try {
    body = JSON.parse(rawBody) as ThumbtackPayload;
  } catch {
    await logDlq(env, JOB_ERROR, null, { rawBody: rawBody.slice(0, 5000) }, "invalid JSON body");
    return json({ ok: true, ignored: "invalid_json" }, 200);
  }

  const eventType = str(body.event?.eventType);
  if (eventType !== "NegotiationCreatedV4") {
    await logDlq(
      env,
      JOB_UNHANDLED,
      str(body.data?.negotiationID) ?? str(body.event?.webhookID),
      body,
      `Unhandled Thumbtack eventType: ${eventType ?? "(missing)"}`,
    );
    console.log(`[thumbtack] ignored eventType=${eventType ?? "missing"}`);
    return json({ ok: true, ignored: eventType ?? "missing_event_type" }, 200);
  }

  try {
    const result = await processNegotiationCreated(env, body);
    if (!result.ok) {
      await logDlq(
        env,
        JOB_ERROR,
        str(body.data?.negotiationID),
        body,
        result.error,
      );
      return json({ ok: true, error: result.error }, 200);
    }
    if (result.deduped) {
      console.log(`[thumbtack] idempotent hit negotiation=${body.data?.negotiationID}`);
      return json({ ok: true, deduped: true, request_id: result.request_id }, 200);
    }
    console.log(
      `[thumbtack] created request=${result.request_id} client=${result.client_id} negotiation=${body.data?.negotiationID}`,
    );
    return json({ ok: true, request_id: result.request_id, client_id: result.client_id }, 200);
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[thumbtack] processing error:`, message);
    try {
      await logDlq(env, JOB_ERROR, str(body.data?.negotiationID), body, message);
    } catch (dlqErr) {
      console.error(`[thumbtack] DLQ log failed:`, (dlqErr as Error).message);
    }
    return json({ ok: true, error: "processing_failed" }, 200);
  }
}

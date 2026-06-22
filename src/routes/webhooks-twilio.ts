/**
 * Inbound Twilio webhooks (Sprint 7) — PUBLIC routes, gated ONLY by the Twilio
 * request signature (no Cloudflare Access), registered the same way as
 * /api/webhooks/stripe so they bypass the edge auth.
 *
 *   POST /api/webhooks/twilio/inbound   inbound SMS → match client, log comm, owner bell
 *   POST /api/webhooks/twilio/status    delivery status callback → update the log by SID
 *
 * Signature discipline mirrors the Stripe handler: verify BEFORE any DB write,
 * constant-time compare, decide the response on every branch, audit the
 * silent/ignored/forged paths, never throw a 500 at Twilio (which would make it
 * retry). An inbound SMS with a bad/missing signature is rejected 403 with NO
 * database write. A valid inbound from an unknown number is never dropped — it
 * is audited and surfaced to the owner's bell.
 */

import type { Env } from "../env.js";
import { getTwilioConfig, verifyTwilioSignature, phoneDigits } from "../lib/twilio.js";
import { createOwnerInApp } from "../lib/notification-engine.js";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** Empty TwiML — tells Twilio "received, no auto-reply". */
function twiml(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}

/** TwiML with a reply message — for STOP/START compliance responses. */
function twimlReply(message: string): Response {
  const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`,
    {
      status: 200,
      headers: { "content-type": "text/xml; charset=utf-8" },
    },
  );
}

const OPT_OUT_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const OPT_IN_KEYWORDS = new Set(["START", "UNSTOP", "YES"]);

async function readClientPrefs(
  env: Env,
  clientId: string,
): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare("SELECT notification_preferences FROM clients WHERE id = ?")
    .bind(clientId)
    .first<{ notification_preferences: string | null }>();
  if (!row?.notification_preferences) return {};
  try {
    const parsed = JSON.parse(row.notification_preferences);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function mergeClientSmsPrefs(
  env: Env,
  clientId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const prefs = await readClientPrefs(env, clientId);
  const merged = { ...prefs, ...patch };
  await env.DB.prepare(
    "UPDATE clients SET notification_preferences = ?, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(JSON.stringify(merged), clientId)
    .run();
}

function classifyInboundKeyword(body: string): "stop" | "start" | "help" | null {
  const normalized = body.trim().toUpperCase();
  if (OPT_OUT_KEYWORDS.has(normalized)) return "stop";
  if (OPT_IN_KEYWORDS.has(normalized)) return "start";
  if (normalized === "HELP" || normalized === "INFO") return "help";
  return null;
}

async function audit(env: Env, action: string, details: unknown): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_logs (id, user_email, action, entity_type, entity_id, details, created_at) VALUES (?, 'system@twilio-webhook', ?, 'communication', ?, ?, datetime('now'))",
    )
      .bind(crypto.randomUUID(), action, crypto.randomUUID(), JSON.stringify(details))
      .run();
  } catch {
    /* auditing must never break the webhook */
  }
}

/** Parse a form body into ordered [key,value] entries (no duplicate-key loss). */
async function parseForm(request: Request): Promise<Array<[string, string]>> {
  const text = await request.text();
  const params = new URLSearchParams(text);
  return [...params.entries()];
}

async function verify(
  env: Env,
  request: Request,
  entries: Array<[string, string]>,
): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  const cfg = await getTwilioConfig(env);
  if (!cfg.authToken) {
    // No way to verify → refuse rather than trust. (Pre-Launch: set the token.)
    return { ok: false, status: 503, reason: "twilio_not_configured" };
  }
  const signature = request.headers.get("X-Twilio-Signature");
  const valid = await verifyTwilioSignature(cfg.authToken, request.url, entries, signature);
  if (!valid) return { ok: false, status: 403, reason: "invalid_signature" };
  return { ok: true };
}

// ─── POST /api/webhooks/twilio/inbound ────────────────────────────────────────

export async function handleTwilioInbound(request: Request, env: Env): Promise<Response> {
  const entries = await parseForm(request);
  const verified = await verify(env, request, entries);
  if (!verified.ok) {
    await audit(env, "twilio_inbound_rejected", { reason: verified.reason });
    return json({ error: "invalid_signature", reason: verified.reason }, { status: verified.status });
  }

  const form = new Map(entries);
  const from = form.get("From") ?? "";
  const body = form.get("Body") ?? "";
  const messageSid = form.get("MessageSid") ?? form.get("SmsSid") ?? "";
  const fromDigits = phoneDigits(from).slice(-10);

  // Match the From number against client phone / phone_secondary (last 10).
  let client: { id: string; name: string | null; first_name: string | null; last_name: string | null } | null = null;
  if (fromDigits.length === 10) {
    client = await env.DB.prepare(
      `SELECT id, name, first_name, last_name FROM clients
        WHERE substr(replace(replace(replace(replace(phone,'(',''),')',''),'-',''),' ',''), -10) = ?
           OR substr(replace(replace(replace(replace(COALESCE(phone_secondary,''),'(',''),')',''),'-',''),' ',''), -10) = ?
        LIMIT 1`,
    )
      .bind(fromDigits, fromDigits)
      .first();
  }

  if (client) {
    const name = [client.first_name, client.last_name].filter(Boolean).join(" ").trim() || client.name || "Client";
    const keyword = classifyInboundKeyword(body);
    if (keyword === "stop") {
      const now = new Date().toISOString();
      // Write to dedicated column (Sprint 24) AND the legacy JSON prefs blob for
      // notification-engine compat until that engine is updated to the column.
      await env.DB.prepare(
        `UPDATE clients SET sms_opt_out = 1, sms_opt_out_at = ?, updated_at = datetime('now') WHERE id = ?`,
      ).bind(now, client.id).run();
      await mergeClientSmsPrefs(env, client.id, {
        sms_opt_out: true,
        sms_opt_out_at: now,
        sms_opt_out_source: "inbound_stop",
      });
      await audit(env, "sms_opt_out_inbound", { client_id: client.id, message_sid: messageSid });
    } else if (keyword === "start") {
      await env.DB.prepare(
        `UPDATE clients SET sms_opt_out = 0, sms_opt_out_at = NULL, updated_at = datetime('now') WHERE id = ?`,
      ).bind(client.id).run();
      await mergeClientSmsPrefs(env, client.id, {
        sms_opt_out: false,
        sms_opt_out_source: "inbound_start",
      });
      await audit(env, "sms_opt_in_inbound", { client_id: client.id, message_sid: messageSid });
    } else if (keyword === "help") {
      await audit(env, "sms_help_inbound", { client_id: client.id, message_sid: messageSid });
    }

    const commId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO communications (
          id, client_id, channel, direction, summary, body, sent_via, high_level_message_id, created_at
       ) VALUES (?, ?, 'text_sms', 'inbound', ?, ?, 'twilio', ?, datetime('now'))`,
    )
      .bind(commId, client.id, `Inbound text from ${name}`, body, messageSid || null)
      .run();
    await env.DB.prepare("UPDATE clients SET last_interaction_date = datetime('now') WHERE id = ?")
      .bind(client.id)
      .run();

    // Update last_sms_at / last_sms_preview on the most recent open estimate_request
    // for this client (only if the columns exist — safe with ?? fallback in shape()).
    try {
      const openRequest = await env.DB.prepare(
        `SELECT id FROM estimate_requests
         WHERE client_id = ? AND status NOT IN ('won', 'lost')
         ORDER BY created_at DESC LIMIT 1`,
      )
        .bind(client.id)
        .first<{ id: string }>();
      if (openRequest) {
        await env.DB.prepare(
          `UPDATE estimate_requests
           SET last_sms_at = datetime('now'), last_sms_preview = ?, updated_at = datetime('now')
           WHERE id = ?`,
        )
          .bind(body.slice(0, 100), openRequest.id)
          .run();
      }
    } catch {
      // Column may not exist yet if migration hasn't run — safe to skip.
    }

    await createOwnerInApp(env, {
      message: `New text from ${name}: ${body.slice(0, 120)}`,
      linkPath: `/app/clients/${client.id}`,
      clientId: client.id,
      dedupe: messageSid ? `inbound:${messageSid}` : null,
    });
    await audit(env, "twilio_inbound_matched", { client_id: client.id, message_sid: messageSid });

    // Return compliance TwiML reply for STOP/START keywords.
    if (keyword === "stop") {
      return twimlReply(
        "You have been unsubscribed from Columbus Home Solutions messages. Reply START to re-subscribe.",
      );
    }
    if (keyword === "start") {
      return twimlReply(
        "You have been re-subscribed to Columbus Home Solutions messages. Reply STOP at any time to unsubscribe.",
      );
    }
  } else {
    // Check opt-out BEFORE lead creation — an unknown number sending STOP
    // should never result in a lead record.
    const unknownKeyword = classifyInboundKeyword(body);
    if (unknownKeyword === "stop" || unknownKeyword === "help" || unknownKeyword === "start") {
      // Opt-out/help from unknown number: audit only, no lead.
      await audit(env, `twilio_inbound_unknown_${unknownKeyword}`, { from, message_sid: messageSid });
      return twiml();
    }

    // Unknown number with a real message → auto-create lead.
    const newClientId = crypto.randomUUID();
    const newRequestId = crypto.randomUUID();
    const now = new Date().toISOString();
    const smsPreview = body.slice(0, 100);
    const placeholderEmail = `sms_${fromDigits || from.replace(/\D/g, "")}@sms.placeholder`;

    // 1. Create client record.
    try {
      await env.DB.prepare(
        `INSERT INTO clients (id, first_name, last_name, email, phone, lead_source, synced_at, created_at, updated_at)
         VALUES (?, 'Unknown', 'Lead', ?, ?, 'direct_call', datetime('now'), ?, ?)`,
      )
        .bind(newClientId, placeholderEmail, from, now, now)
        .run();
    } catch (e) {
      // If client insert fails (e.g. duplicate), abort lead creation and fall back to alert.
      await createOwnerInApp(env, {
        message: `Inbound text from unrecognized number ${from}: ${smsPreview}`,
        linkPath: "/app/clients",
        dedupe: messageSid ? `inbound:${messageSid}` : null,
      });
      await audit(env, "twilio_inbound_unmatched_client_create_failed", { from, error: String(e) });
      return twiml();
    }

    // 2. Generate request_number for the new estimate_request.
    let requestNumber = 9001;
    try {
      const max = await env.DB.prepare(
        "SELECT COALESCE(MAX(request_number), 0) AS n FROM estimate_requests",
      ).first<{ n: number }>();
      requestNumber = (max?.n ?? 0) + 1;
    } catch {
      // Use fallback — estimate_requests may not exist yet locally.
    }

    // 3. Create estimate_requests record.
    try {
      await env.DB.prepare(
        `INSERT INTO estimate_requests (
          id, request_number, status, client_id,
          property_address, property_city, property_state, property_zip,
          job_type, lead_source, source,
          last_sms_at, last_sms_preview,
          created_at, updated_at
        ) VALUES (?, ?, 'new_request', ?, 'Unknown', 'Unknown', 'Arkansas', '00000',
                  'unknown', 'direct_call', 'inbound_sms', ?, ?, ?, ?)`,
      )
        .bind(newRequestId, requestNumber, newClientId, now, smsPreview, now, now)
        .run();
    } catch (e) {
      await audit(env, "twilio_inbound_request_create_failed", { from, error: String(e) });
    }

    // 4. Log inbound SMS to communications.
    try {
      const commId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO communications (id, client_id, channel, direction, summary, body, sent_via, created_at)
         VALUES (?, ?, 'text_sms', 'inbound', ?, ?, 'twilio', ?)`,
      )
        .bind(commId, newClientId, `Inbound text from unknown number ${from}`, body, now)
        .run();
    } catch {
      // Communication log failure must never block the webhook.
    }

    // 5. Owner in-app alert.
    await createOwnerInApp(env, {
      message: `New lead from unknown number: ${from}`,
      linkPath: `/app/estimating/${newRequestId}`,
      clientId: newClientId,
      dedupe: messageSid ? `inbound:${messageSid}` : null,
    });
    await audit(env, "twilio_inbound_unknown_lead_created", {
      from,
      client_id: newClientId,
      request_id: newRequestId,
      message_sid: messageSid,
    });
  }

  return twiml();
}

// ─── POST /api/webhooks/twilio/status ─────────────────────────────────────────

export async function handleTwilioStatus(request: Request, env: Env): Promise<Response> {
  const entries = await parseForm(request);
  const verified = await verify(env, request, entries);
  if (!verified.ok) {
    await audit(env, "twilio_status_rejected", { reason: verified.reason });
    return json({ error: "invalid_signature", reason: verified.reason }, { status: verified.status });
  }

  const form = new Map(entries);
  const sid = form.get("MessageSid") ?? form.get("SmsSid") ?? "";
  const status = (form.get("MessageStatus") ?? form.get("SmsStatus") ?? "").toLowerCase();
  if (!sid) return json({ received: true, ignored: "no_sid" });

  // Map Twilio statuses onto the notification_logs status CHECK set.
  const map: Record<string, string> = {
    delivered: "delivered",
    sent: "sent",
    failed: "failed",
    undelivered: "failed",
  };
  const mapped = map[status];
  if (!mapped) {
    // queued / sending / accepted etc. — acknowledge, nothing to persist.
    return json({ received: true, ignored: status || "unknown" });
  }

  const setDelivered = mapped === "delivered" ? ", delivered_at = datetime('now')" : "";
  const res = await env.DB.prepare(
    `UPDATE notification_logs SET status = ?${setDelivered} WHERE external_id = ?`,
  )
    .bind(mapped, sid)
    .run();
  await audit(env, "twilio_status_callback", { message_sid: sid, status, matched: res.meta?.changes ?? 0 });
  return json({ received: true, status: mapped, matched: res.meta?.changes ?? 0 });
}

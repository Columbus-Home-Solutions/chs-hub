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
      await mergeClientSmsPrefs(env, client.id, {
        sms_opt_out: true,
        sms_opt_out_at: new Date().toISOString(),
        sms_opt_out_source: "inbound_stop",
      });
      await audit(env, "sms_opt_out_inbound", { client_id: client.id, message_sid: messageSid });
    } else if (keyword === "start") {
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
    await createOwnerInApp(env, {
      message: `New text from ${name}: ${body.slice(0, 120)}`,
      linkPath: `/app/clients/${client.id}`,
      clientId: client.id,
      dedupe: messageSid ? `inbound:${messageSid}` : null,
    });
    await audit(env, "twilio_inbound_matched", { client_id: client.id, message_sid: messageSid });
  } else {
    // Unknown number — never dropped: audit + owner bell so it can be handled.
    await createOwnerInApp(env, {
      message: `Inbound text from unrecognized number ${from}: ${body.slice(0, 120)}`,
      linkPath: "/app/clients",
      dedupe: messageSid ? `inbound:${messageSid}` : null,
    });
    await audit(env, "twilio_inbound_unmatched", { from, message_sid: messageSid });
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

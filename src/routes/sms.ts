/**
 * Sprint 24 — Two-way SMS routes
 *
 *   GET  /api/clients/:id/sms-thread      — full SMS thread for one client
 *   POST /api/sms/reply                   — send outbound SMS (Opus-reviewed path)
 *   GET  /api/sms/conversations           — SMS inbox: most recent message per client
 *
 * All routes are authenticated (Cloudflare Access). The reply route is the
 * correctness-critical path: it checks opt-out, respects NOTIFICATIONS_DISPATCH_MODE,
 * calls the existing sendSms() helper from src/lib/twilio.ts, and logs to
 * communications in the exact same shape as the inbound webhook.
 */

import type { Env } from "../env.js";
import { getTwilioConfig, sendSms, phoneDigits } from "../lib/twilio.js";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

// ─── GET /api/clients/:id/sms-thread ─────────────────────────────────────────
//
// Returns the full SMS conversation thread for a client — all communications
// rows where channel = 'text_sms', oldest-first. Includes the client's current
// sms_opt_out flag. If a message has a job_id, the job title is joined in.

export async function handleSmsThread(env: Env, clientId: string): Promise<Response> {
  // 1. Load client — verify exists and get phone + opt-out status.
  const client = await env.DB.prepare(
    `SELECT id, first_name, last_name, phone, sms_opt_out FROM clients WHERE id = ?`,
  )
    .bind(clientId)
    .first<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      phone: string | null;
      sms_opt_out: number;
    }>();

  if (!client) {
    return json({ error: "Client not found" }, { status: 404 });
  }

  // 2. Fetch all SMS messages, joined with jobs for job_title context.
  const { results } = await env.DB.prepare(
    `SELECT
       c.id,
       c.direction,
       c.body,
       c.summary,
       c.sent_via,
       c.twilio_sid,
       c.job_id,
       c.created_at,
       j.title AS job_title
     FROM communications c
     LEFT JOIN jobs j ON j.id = c.job_id
     WHERE c.client_id = ? AND c.channel = 'text_sms'
     ORDER BY c.created_at ASC
     LIMIT 1000`,
  )
    .bind(clientId)
    .all<{
      id: string;
      direction: string;
      body: string | null;
      summary: string;
      sent_via: string | null;
      twilio_sid: string | null;
      job_id: string | null;
      created_at: string;
      job_title: string | null;
    }>();

  const messages = (results ?? []).map((r) => ({
    id: r.id,
    direction: r.direction,
    body: r.body ?? r.summary,
    created_at: r.created_at,
    sent_via: r.sent_via,
    twilio_sid: r.twilio_sid,
    job_id: r.job_id,
    job_title: r.job_title,
    // Flag simulated outbound messages so the UI can show "(not sent — A2P pending)".
    simulated: r.direction === "outbound" && r.summary?.includes("simulated"),
  }));

  const clientName = [client.first_name, client.last_name].filter(Boolean).join(" ").trim() || "Unknown";

  return json({
    client_id: clientId,
    client_name: clientName,
    client_phone: client.phone,
    sms_opt_out: client.sms_opt_out === 1,
    messages,
  });
}

// ─── POST /api/sms/reply ──────────────────────────────────────────────────────
//
// Send an outbound SMS to a client. This is the correctness-critical path:
//   1. Load client, normalize phone, check sms_opt_out → 409 if opted out.
//   2. Simulate mode → log to communications, return { simulated: true }.
//   3. Live mode → call Twilio, log with twilio_sid, return { simulated: false }.
//   4. Twilio error → 502.
//
// The logged communications row uses the same shape as the inbound webhook
// (channel='text_sms', sent_via='twilio') so the thread query retrieves both.

export async function handleSmsReply(request: Request, env: Env): Promise<Response> {
  let body: { client_id?: unknown; body?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const clientId = typeof body.client_id === "string" ? body.client_id.trim() : null;
  const messageBody = typeof body.body === "string" ? body.body.trim() : null;

  if (!clientId) return json({ error: "client_id is required" }, { status: 400 });
  if (!messageBody) return json({ error: "body is required" }, { status: 400 });
  if (messageBody.length > 1600) return json({ error: "Message too long (max 1600 chars)" }, { status: 400 });

  // 1. Load client.
  const client = await env.DB.prepare(
    `SELECT id, first_name, last_name, phone, sms_opt_out FROM clients WHERE id = ?`,
  )
    .bind(clientId)
    .first<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      phone: string | null;
      sms_opt_out: number;
    }>();

  if (!client) {
    return json({ error: "Client not found" }, { status: 404 });
  }

  // 2. Opt-out guard — enforced server-side regardless of what the UI shows.
  if (client.sms_opt_out === 1) {
    return json({ error: "Client has opted out of SMS" }, { status: 409 });
  }

  if (!client.phone) {
    return json({ error: "Client has no phone number on record" }, { status: 422 });
  }

  const isLive = (env.NOTIFICATIONS_DISPATCH_MODE ?? "").toLowerCase() === "live";

  // 3. Simulate mode path — log to communications, no Twilio call.
  if (!isLive) {
    const commId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO communications (
         id, client_id, channel, direction, summary, body, sent_via, logged_by, created_at
       ) VALUES (?, ?, 'text_sms', 'outbound', ?, ?, 'twilio', 'system', datetime('now'))`,
    )
      .bind(
        commId,
        clientId,
        "Outbound SMS (simulated)",
        messageBody,
      )
      .run();

    await env.DB.prepare(
      `UPDATE clients SET last_interaction_date = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    )
      .bind(clientId)
      .run();

    return json({ simulated: true, message_id: null, comm_id: commId });
  }

  // 4. Live mode path — call Twilio.
  const cfg = await getTwilioConfig(env);

  // Normalize phone for Twilio (E.164 format — prepend +1 for US numbers).
  const digits = phoneDigits(client.phone);
  const toNumber = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : client.phone;

  const result = await sendSms(cfg, toNumber, messageBody);

  if (!result.ok) {
    return json({ error: "SMS send failed", detail: result.details }, { status: 502 });
  }

  // 5. Log the outbound SMS to communications with the Twilio SID.
  const commId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO communications (
       id, client_id, channel, direction, summary, body, sent_via, twilio_sid, logged_by, created_at
     ) VALUES (?, ?, 'text_sms', 'outbound', ?, ?, 'twilio', ?, 'system', datetime('now'))`,
  )
    .bind(
      commId,
      clientId,
      "Outbound SMS",
      messageBody,
      result.sid,
    )
    .run();

  await env.DB.prepare(
    `UPDATE clients SET last_interaction_date = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(clientId)
    .run();

  return json({ simulated: false, message_id: result.sid, comm_id: commId });
}

// ─── GET /api/sms/conversations ───────────────────────────────────────────────
//
// SMS inbox: one row per client who has any SMS history, sorted by last_message_at
// desc. unread_count is computed in SQL — number of inbound messages received
// since the client's last outbound message (or all inbound if no outbound exists).
//
// The unread definition:
//   "inbound messages after the most recent outbound message in that thread"
// If there is no outbound message at all, all inbound messages count as unread.

export async function handleSmsConversations(env: Env, url: URL): Promise<Response> {
  // The core query:
  // 1. Find the most recent SMS per client.
  // 2. Count inbound messages since last outbound (subquery).
  // 3. Join client info + open estimate_request for "Lead" badge.
  const { results } = await env.DB.prepare(
    `SELECT
       cl.id                          AS client_id,
       cl.first_name,
       cl.last_name,
       cl.phone                       AS client_phone,
       cl.sms_opt_out,
       latest.last_message_body,
       latest.last_message_at,
       latest.last_message_direction,
       COALESCE(unread.cnt, 0)        AS unread_count,
       er.id                          AS lead_request_id,
       er.request_number              AS lead_request_number,
       er.status                      AS lead_status
     FROM clients cl
     -- Latest SMS message per client
     INNER JOIN (
       SELECT
         client_id,
         body                         AS last_message_body,
         direction                    AS last_message_direction,
         created_at                   AS last_message_at
       FROM communications c1
       WHERE c1.channel = 'text_sms'
         AND c1.created_at = (
           SELECT MAX(c2.created_at)
           FROM communications c2
           WHERE c2.client_id = c1.client_id
             AND c2.channel = 'text_sms'
         )
         AND c1.id = (
           SELECT c3.id
           FROM communications c3
           WHERE c3.client_id = c1.client_id
             AND c3.channel = 'text_sms'
             AND c3.created_at = c1.created_at
           LIMIT 1
         )
     ) latest ON latest.client_id = cl.id
     -- Unread count: inbound messages after last outbound
     LEFT JOIN (
       SELECT
         client_id,
         COUNT(*) AS cnt
       FROM communications
       WHERE channel = 'text_sms'
         AND direction = 'inbound'
         AND created_at > COALESCE(
           (
             SELECT MAX(c_out.created_at)
             FROM communications c_out
             WHERE c_out.client_id = communications.client_id
               AND c_out.channel = 'text_sms'
               AND c_out.direction = 'outbound'
           ),
           '1970-01-01T00:00:00Z'
         )
       GROUP BY client_id
     ) unread ON unread.client_id = cl.id
     -- Open estimate request (for Lead badge)
     LEFT JOIN estimate_requests er
       ON er.client_id = cl.id
       AND er.status NOT IN ('won', 'lost')
       AND er.id = (
         SELECT id FROM estimate_requests
         WHERE client_id = cl.id AND status NOT IN ('won', 'lost')
         ORDER BY created_at DESC LIMIT 1
       )
     ORDER BY latest.last_message_at DESC
     LIMIT 200`,
  ).all<{
    client_id: string;
    first_name: string | null;
    last_name: string | null;
    client_phone: string | null;
    sms_opt_out: number;
    last_message_body: string | null;
    last_message_at: string;
    last_message_direction: string;
    unread_count: number;
    lead_request_id: string | null;
    lead_request_number: number | null;
    lead_status: string | null;
  }>();

  const conversations = (results ?? []).map((r) => ({
    client_id: r.client_id,
    client_name: [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || "Unknown",
    client_phone: r.client_phone,
    sms_opt_out: r.sms_opt_out === 1,
    last_message_body: r.last_message_body ?? "",
    last_message_at: r.last_message_at,
    last_message_direction: r.last_message_direction,
    unread_count: r.unread_count,
    lead_request_id: r.lead_request_id,
    lead_request_number: r.lead_request_number,
    lead_status: r.lead_status,
  }));

  return json({ conversations });
}

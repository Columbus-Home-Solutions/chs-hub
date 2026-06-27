/**
 * Sprint 26 — Automated Quote Follow-Up Sequence
 *
 * processQuoteFollowUps() folds into the existing every-15-min cron slot
 * (runNotificationProcessor in src/index.ts). It must never throw — all
 * errors are caught so co-tenant cron jobs (notifications, social publish,
 * gcal sync) are not disrupted.
 *
 * Sequence logic:
 *   follow_up_count 0 → Day 3 touch  (days_since_sent >= 3)
 *   follow_up_count 1 → Day 5 touch  (days_since_sent >= 5)
 *   follow_up_count 2 → Day 7 touch  (days_since_sent >= 7)
 *   follow_up_count 3 → Day 10 touch (days_since_sent >= 10)
 *   follow_up_count 4 → sequence complete (all touches sent)
 *
 * After Day 10 touch, sequence is marked complete. If the sequence never
 * started and days_since_sent > 10, it is marked complete without sending.
 *
 * Merge fields rendered:
 *   {{client_first_name}}  → client.first_name
 *   {{job_type}}           → estimate_request.job_type (title-cased)
 *   {{property_address}}   → estimate_request.property_address
 *   {{expiration_date}}    → estimate.expiration_date (formatted)
 *   {{estimate_link}}      → https://client.homesolutionsar.com/portal/{portal_token}
 *
 * Dispatch honours NOTIFICATIONS_DISPATCH_MODE — same simulate/live gate
 * as the existing notification engine. SMS opt-out is checked per client.
 * Email is sent regardless of SMS opt-out status.
 *
 * Each dispatched touch is logged to:
 *   - notification_logs (status = 'sent' or 'failed')
 *   - communications (direction = 'outbound', so it appears on the timeline)
 *
 * Max 20 records per cron run to avoid timeouts; next tick catches the rest.
 */

import type { Env } from "../env.js";
import { sendSms, getTwilioConfig, isConfigured as twilioConfigured } from "./twilio.js";

// ─── touch schedule ───────────────────────────────────────────────────────────

const TOUCHES: Array<{
  dayThreshold: number;
  label: string;
  smsKey: string;
  emailKey: string;
}> = [
  { dayThreshold: 3,  label: "Day 3",  smsKey: "follow_up_day3_sms",  emailKey: "follow_up_day3_email"  },
  { dayThreshold: 5,  label: "Day 5",  smsKey: "follow_up_day5_sms",  emailKey: "follow_up_day5_email"  },
  { dayThreshold: 7,  label: "Day 7",  smsKey: "follow_up_day7_sms",  emailKey: "follow_up_day7_email"  },
  { dayThreshold: 10, label: "Day 10", smsKey: "follow_up_day10_sms", emailKey: "follow_up_day10_email" },
];

// Synthetic template_id used for notification_logs rows. The FK constraint is
// not enforced by D1/SQLite unless PRAGMA foreign_keys=ON, so this is safe.
// Using 'tmpl-system-alert' which is seeded in 0030_notifications.sql as a
// real FK target.
const FOLLOW_UP_TEMPLATE_ID = "tmpl-system-alert";

export interface FollowUpStats {
  scanned: number;
  dispatched: number;
  skipped: number;
  completed: number;
  errors: number;
  duration_ms: number;
}

interface EstimateRequestRow {
  id: string;
  client_id: string;
  estimate_id: string | null;
  sent_date: string;
  follow_up_count: number;
  follow_up_sequence_active: number;
  status: string;
  job_type: string;
  property_address: string;
  property_city: string | null;
}

interface ClientRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  notification_preferences: string | null;
}

interface EstimateRow {
  id: string;
  portal_token: string | null;
  expiration_date: string | null;
  total: number | null;
}

/**
 * The main entry point. Called from runNotificationProcessor() every 15 min.
 * Wrapped in try/catch at the call site — internal errors are also caught per
 * record so one bad row never aborts the rest.
 */
export async function processQuoteFollowUps(env: Env): Promise<FollowUpStats> {
  const started = Date.now();
  const stats: FollowUpStats = {
    scanned: 0,
    dispatched: 0,
    skipped: 0,
    completed: 0,
    errors: 0,
    duration_ms: 0,
  };

  // Query estimate_requests that are eligible for follow-up:
  // - status IN ('sent', 'viewed', 'follow_up') — not won/lost
  // - sent_date IS NOT NULL — sequence anchored to sent_date
  // - converted_job_id IS NULL — not won
  // - follow_up_count < 4 — touches remaining (4 = sequence exhausted)
  // - either sequence is already active OR hasn't been initialized yet
  const now = new Date();
  const nowIso = now.toISOString();

  const { results } = await env.DB.prepare(
    `SELECT er.id, er.client_id, er.estimate_id, er.sent_date,
            COALESCE(er.follow_up_count, 0) AS follow_up_count,
            COALESCE(er.follow_up_sequence_active, 0) AS follow_up_sequence_active,
            er.status, er.job_type, er.property_address, er.property_city
     FROM estimate_requests er
     WHERE er.status IN ('sent', 'viewed', 'follow_up')
       AND er.sent_date IS NOT NULL
       AND er.converted_job_id IS NULL
       AND COALESCE(er.follow_up_count, 0) < 4
     ORDER BY er.sent_date ASC
     LIMIT 20`,
  ).all<EstimateRequestRow>();

  const rows = results ?? [];
  stats.scanned = rows.length;

  for (const row of rows) {
    try {
      const dispatched = await processOneRequest(env, row, nowIso);
      if (dispatched === null) {
        stats.skipped++;
      } else if (dispatched === false) {
        stats.completed++;
      } else {
        stats.dispatched++;
      }
    } catch (err) {
      stats.errors++;
      console.error(`[follow_up] error processing request ${row.id}:`, (err as Error).message);
    }
  }

  stats.duration_ms = Date.now() - started;
  return stats;
}

/**
 * Process a single estimate_request.
 * Returns: true = dispatched a touch; false = marked complete (no send);
 *          null = not yet due (nothing to do this tick)
 */
async function processOneRequest(
  env: Env,
  row: EstimateRequestRow,
  nowIso: string,
): Promise<true | false | null> {
  const daysSinceSent = calcDaysSince(row.sent_date);

  // If sent_date is in the future somehow (bad data), skip.
  if (daysSinceSent < 0) return null;

  // Business rule 5: sequence never started and already past Day 10 —
  // mark complete without sending.
  if (daysSinceSent > 10 && row.follow_up_count === 0 && row.follow_up_sequence_active === 0) {
    await markSequenceComplete(env, row.id, nowIso);
    return false;
  }

  // Determine which touch is due based on follow_up_count.
  if (row.follow_up_count >= TOUCHES.length) {
    // All touches already sent — mark complete.
    await markSequenceComplete(env, row.id, nowIso);
    return false;
  }

  const touch = TOUCHES[row.follow_up_count];

  // Not yet at the day threshold — nothing to do this tick.
  if (daysSinceSent < touch.dayThreshold) return null;

  // Fetch supporting records.
  const client = await env.DB.prepare(
    "SELECT id, first_name, last_name, name, phone, email, notification_preferences FROM clients WHERE id = ?",
  )
    .bind(row.client_id)
    .first<ClientRow>();

  if (!client) {
    console.warn(`[follow_up] client not found for request ${row.id}`);
    return null;
  }

  const estimate = row.estimate_id
    ? await env.DB.prepare(
        "SELECT id, portal_token, expiration_date, total FROM estimates WHERE id = ?",
      )
        .bind(row.estimate_id)
        .first<EstimateRow>()
    : null;

  // Build the portal link (use estimate portal_token → /portal/ path).
  const origin = (env.APP_PUBLIC_ORIGIN ?? "https://client.homesolutionsar.com").replace(/\/$/, "");
  const estimateLink = estimate?.portal_token
    ? `${origin}/portal/${estimate.portal_token}`
    : `${origin}/portal/`;

  // Format merge fields.
  const mergeCtx = buildMergeContext(row, client, estimate, estimateLink);

  // Load templates from system_settings.
  const [smsSetting, emailSetting] = await Promise.all([
    env.DB.prepare("SELECT value FROM system_settings WHERE key = ?")
      .bind(touch.smsKey)
      .first<{ value: string }>(),
    env.DB.prepare("SELECT value FROM system_settings WHERE key = ?")
      .bind(touch.emailKey)
      .first<{ value: string }>(),
  ]);

  const smsBody = smsSetting?.value ? renderTemplate(smsSetting.value, mergeCtx) : null;

  let emailSubject: string | null = null;
  let emailBody: string | null = null;
  if (emailSetting?.value) {
    try {
      const parsed = JSON.parse(emailSetting.value) as { subject?: string; body?: string };
      emailSubject = parsed.subject ? renderTemplate(parsed.subject, mergeCtx) : null;
      emailBody = parsed.body ? renderTemplate(parsed.body, mergeCtx) : null;
    } catch {
      emailBody = renderTemplate(emailSetting.value, mergeCtx);
    }
  }

  const live = (env.NOTIFICATIONS_DISPATCH_MODE ?? "").toLowerCase() === "live";

  // ─── SMS dispatch ───────────────────────────────────────────────────────────
  if (smsBody && client.phone) {
    const smsOptOut = isSmsOptOut(client.notification_preferences);
    if (smsOptOut) {
      // Log skipped SMS per spec (Business Rule 3).
      await logNotification(env, {
        triggerEvent: `quote_follow_up_${touch.label.toLowerCase().replace(" ", "_")}`,
        recipientName: clientDisplayName(client),
        recipientContact: client.phone,
        channel: "sms",
        subject: null,
        body: smsBody,
        status: "failed",
        errorMessage: "Client opted out of SMS",
        clientId: client.id,
        estimateRequestId: row.id,
      });
    } else {
      let externalId: string;
      let smsStatus: "sent" | "failed";
      let smsError: string | null = null;

      if (!live) {
        externalId = `simulated:${crypto.randomUUID()}`;
        smsStatus = "sent";
      } else {
        const cfg = await getTwilioConfig(env);
        if (twilioConfigured(cfg)) {
          const r = await sendSms(cfg, client.phone, smsBody);
          if (r.ok) {
            externalId = r.sid;
            smsStatus = "sent";
          } else {
            externalId = `failed:${crypto.randomUUID()}`;
            smsStatus = "failed";
            smsError = `${r.error}: ${r.details}`;
          }
        } else {
          externalId = `simulated:${crypto.randomUUID()}`;
          smsStatus = "sent";
        }
      }

      const commId = await logCommunication(env, {
        clientId: client.id,
        channel: "text_sms",
        summary: `${touch.label} follow-up SMS`,
        body: smsBody,
      });

      await logNotification(env, {
        triggerEvent: `quote_follow_up_${touch.label.toLowerCase().replace(" ", "_")}`,
        recipientName: clientDisplayName(client),
        recipientContact: client.phone,
        channel: "sms",
        subject: null,
        body: smsBody,
        status: smsStatus,
        errorMessage: smsError,
        clientId: client.id,
        estimateRequestId: row.id,
        externalId,
        communicationId: commId,
      });
    }
  }

  // ─── Email dispatch ─────────────────────────────────────────────────────────
  // Email is sent regardless of SMS opt-out status (Business Rule 3).
  if (emailBody && client.email) {
    let externalId: string;
    let emailStatus: "sent" | "failed";
    let emailError: string | null = null;

    if (!live) {
      externalId = `simulated:${crypto.randomUUID()}`;
      emailStatus = "sent";
    } else {
      const from = (env.NOTIFICATIONS_EMAIL_FROM ?? "").trim();
      const apiKey = (env.RESEND_API_KEY ?? "").trim();
      if (!from || !apiKey || env.RESEND_DRY_RUN === "1") {
        externalId = `simulated:${crypto.randomUUID()}`;
        emailStatus = "sent";
      } else {
        const r = await sendResendEmail(
          apiKey,
          from,
          client.email,
          emailSubject ?? "Following up on your estimate",
          emailBody,
        );
        if (r.ok) {
          externalId = r.id;
          emailStatus = "sent";
        } else {
          externalId = `failed:${crypto.randomUUID()}`;
          emailStatus = "failed";
          emailError = r.error;
        }
      }
    }

    const commId = await logCommunication(env, {
      clientId: client.id,
      channel: "email",
      summary: `${touch.label} follow-up email`,
      body: emailBody,
    });

    await logNotification(env, {
      triggerEvent: `quote_follow_up_${touch.label.toLowerCase().replace(" ", "_")}`,
      recipientName: clientDisplayName(client),
      recipientContact: client.email,
      channel: "email",
      subject: emailSubject,
      body: emailBody,
      status: emailStatus,
      errorMessage: emailError,
      clientId: client.id,
      estimateRequestId: row.id,
      externalId,
      communicationId: commId,
    });
  }

  // ─── Increment follow_up_count and update status ────────────────────────────
  const newCount = row.follow_up_count + 1;

  await env.DB.prepare(
    `UPDATE estimate_requests SET
       follow_up_count = ?,
       last_follow_up_date = datetime('now'),
       follow_up_sequence_active = 1,
       status = 'follow_up',
       updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(newCount, row.id)
    .run();

  // If this was the Day 10 touch (count was 3, now 4) → mark sequence complete.
  if (newCount >= 4) {
    await markSequenceComplete(env, row.id, nowIso);
  }

  return true;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function markSequenceComplete(env: Env, requestId: string, _nowIso: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE estimate_requests SET
       follow_up_sequence_active = 0,
       follow_up_completed_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(requestId)
    .run();
}

function calcDaysSince(iso: string): number {
  // Normalise SQLite datetime('now') values (space separator, no Z) and ISO-8601.
  const t = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function clientDisplayName(c: ClientRow): string {
  return [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.name || "Client";
}

function isSmsOptOut(notificationPrefs: string | null): boolean {
  if (!notificationPrefs) return false;
  try {
    const prefs = JSON.parse(notificationPrefs) as Record<string, unknown>;
    return prefs.sms_opt_out === true;
  } catch {
    return false;
  }
}

function renderTemplate(template: string, ctx: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    return ctx[key] ?? "";
  });
}

function buildMergeContext(
  row: EstimateRequestRow,
  client: ClientRow,
  estimate: EstimateRow | null | undefined,
  estimateLink: string,
): Record<string, string> {
  const ctx: Record<string, string> = {};

  const firstName = client.first_name ?? (client.name ?? "").split(" ")[0] ?? "";
  if (firstName) ctx.client_first_name = firstName;
  const fullName = [client.first_name, client.last_name].filter(Boolean).join(" ").trim() || client.name || "";
  if (fullName) ctx.client_name = fullName;

  ctx.job_type = titleCase(row.job_type);
  ctx.property_address = row.property_address;

  if (estimate?.expiration_date) {
    ctx.expiration_date = formatDate(estimate.expiration_date);
  }

  ctx.estimate_link = estimateLink;

  return ctx;
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(iso: string): string {
  const d = new Date(iso.includes("T") ? iso : iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

interface LogNotificationArgs {
  triggerEvent: string;
  recipientName: string;
  recipientContact: string;
  channel: string;
  subject: string | null;
  body: string;
  status: string;
  errorMessage?: string | null;
  clientId: string;
  estimateRequestId: string;
  externalId?: string;
  communicationId?: string | null;
}

async function logNotification(env: Env, a: LogNotificationArgs): Promise<void> {
  const sentAt = a.status === "sent" ? "datetime('now')" : "NULL";
  await env.DB.prepare(
    `INSERT INTO notification_logs (
       id, template_id, trigger_event, recipient_type, recipient_name, recipient_contact,
       channel, subject, body, status, error_message, client_id, estimate_request_id,
       communication_id, external_id, sent_at, created_at
     ) VALUES (?, ?, ?, 'client', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${sentAt}, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      FOLLOW_UP_TEMPLATE_ID,
      a.triggerEvent,
      a.recipientName,
      a.recipientContact,
      a.channel,
      a.subject ?? null,
      a.body,
      a.status,
      a.errorMessage ?? null,
      a.clientId,
      a.estimateRequestId,
      a.communicationId ?? null,
      a.externalId ?? null,
    )
    .run();
}

interface LogCommArgs {
  clientId: string;
  channel: "text_sms" | "email";
  summary: string;
  body: string;
}

async function logCommunication(env: Env, a: LogCommArgs): Promise<string> {
  const commId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO communications (
       id, client_id, channel, direction, summary, body, sent_via, created_at
     ) VALUES (?, ?, ?, 'outbound', ?, ?, 'system_auto', datetime('now'))`,
  )
    .bind(commId, a.clientId, a.channel, a.summary, a.body)
    .run();
  return commId;
}

async function sendResendEmail(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  text: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `resend ${res.status}: ${body.slice(0, 300)}` };
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: data.id ?? `resend:${crypto.randomUUID()}` };
  } catch (e) {
    return { ok: false, error: `resend_exception: ${(e as Error).message}` };
  }
}

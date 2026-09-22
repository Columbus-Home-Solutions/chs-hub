/**
 * Sprint 27 — Pre-Appointment Outreach Sequence + Post-Visit Follow-Up
 *
 * processNewLeadOutreach() folds into the existing every-15-min cron slot
 * (runNotificationProcessor in src/index.ts). It must never throw — all
 * errors are caught so co-tenant cron jobs are not disrupted.
 *
 * Outreach sequence logic (SMS only — no email):
 *   Clock is contacted_at for status=contacted. In-flight new_request rows
 *   that already have sequence_active=1 keep using created_at until they finish.
 *   lead_outreach_count 0 → Day 1 (days >= 0, next 15-minute tick inside 9am–7pm Central)
 *   lead_outreach_count 1 → Day 2 (days >= 1, same window)
 *   lead_outreach_count 2 → Day 3 (days >= 2, same window)
 *   lead_outreach_count 3 → sequence complete
 *
 * New sequences start only when a lead enters Contacted (applyLeadStageChange).
 * No new sequences start on new_request.
 *
 * Stops automatically when:
 *   - the lead leaves Contacted, an appointment is set, or it is marked lost
 *   - the customer replies (inbound SMS)
 *   - 3 touches sent
 *
 * triggerPostVisitFollowUp() fires a single dual-channel (SMS + email) message
 * when a request moves to visit_done. Called inline from the status-update handler.
 * Deduped via notification_logs key 'post_visit_{requestId}'.
 *
 * All dispatch respects NOTIFICATIONS_DISPATCH_MODE (simulate/live).
 * SMS opt-out (clients.sms_opt_out) is honoured; skip is logged with status='skipped'.
 */

import type { Env } from "../env.js";
import { isWithinCentralSendWindow } from "./central-send-window.js";
import { sendSms, getTwilioConfig, isConfigured as twilioConfigured } from "./twilio.js";
import { renderTemplateText } from "./merge-render.js";

// ─── touch schedule ───────────────────────────────────────────────────────────

export { CHS_TIMEZONE } from "./central-send-window.js";

const OUTREACH_TOUCHES: Array<{
  dayThreshold: number;
  label: string;
  smsKey: string;
}> = [
  { dayThreshold: 0, label: "Day 1", smsKey: "outreach_day1_sms" },
  { dayThreshold: 1, label: "Day 2", smsKey: "outreach_day2_sms" },
  { dayThreshold: 2, label: "Day 3", smsKey: "outreach_day3_sms" },
];

// Synthetic template_id — matches the pattern used in quote-follow-up.ts.
const OUTREACH_TEMPLATE_ID = "tmpl-system-alert";

export interface OutreachStats {
  scanned: number;
  dispatched: number;
  skipped: number;
  completed: number;
  errors: number;
  duration_ms: number;
}

interface OutreachRow {
  id: string;
  client_id: string;
  job_type: string;
  property_address: string;
  outreach_clock: string;
  lead_outreach_count: number;
  lead_outreach_sequence_active: number;
  first_name: string | null;
  phone: string | null;
  email: string | null;
  sms_opt_out: number | null;
}

/**
 * Contacted rows with an active sequence, plus in-flight new_request sequences
 * started before the Contacted cutover. INNER JOIN clients — no client, no text.
 */
export const LEAD_OUTREACH_CANDIDATE_SQL = `SELECT er.id, er.client_id, er.job_type, er.property_address,
            CASE WHEN er.status = 'contacted' THEN er.contacted_at ELSE er.created_at END AS outreach_clock,
            COALESCE(er.lead_outreach_count, 0) AS lead_outreach_count,
            COALESCE(er.lead_outreach_sequence_active, 0) AS lead_outreach_sequence_active,
            c.first_name, c.phone, c.email, c.sms_opt_out
     FROM estimate_requests er
     JOIN clients c ON c.id = er.client_id
     WHERE er.appointment_date IS NULL
       AND COALESCE(er.appointment_completed, 0) = 0
       AND er.lead_outreach_sequence_active = 1
       AND er.lead_outreach_completed_at IS NULL
       AND (
         (er.status = 'contacted' AND er.contacted_at IS NOT NULL)
         OR er.status = 'new_request'
       )
     LIMIT 20`;

// ─── processNewLeadOutreach ───────────────────────────────────────────────────

/**
 * Main entry point — called from runNotificationProcessor() every 15 min.
 * Processes up to 20 contacted (or in-flight new_request) records with no appointment.
 */
export async function processNewLeadOutreach(env: Env): Promise<OutreachStats> {
  const started = Date.now();
  const stats: OutreachStats = {
    scanned: 0,
    dispatched: 0,
    skipped: 0,
    completed: 0,
    errors: 0,
    duration_ms: 0,
  };

  const { results } = await env.DB.prepare(LEAD_OUTREACH_CANDIDATE_SQL).all<OutreachRow>();

  const rows = results ?? [];
  stats.scanned = rows.length;

  for (const row of rows) {
    try {
      const result = await processOneOutreach(env, row);
      if (result === null) {
        stats.skipped++;
      } else if (result === false) {
        stats.completed++;
      } else {
        stats.dispatched++;
      }
    } catch (err) {
      stats.errors++;
      console.error(`[lead_outreach] error processing request ${row.id}:`, (err as Error).message);
    }
  }

  stats.duration_ms = Date.now() - started;
  return stats;
}

/**
 * Process a single estimate_request for outreach.
 * Returns: true = dispatched a touch; false = marked complete (no send);
 *          null = not yet due (nothing to do this tick)
 */
async function processOneOutreach(
  env: Env,
  row: OutreachRow,
): Promise<true | false | null> {
  const daysElapsed = calcDaysSince(row.outreach_clock);

  if (daysElapsed < 0) return null;

  // All touches already sent.
  if (row.lead_outreach_count >= OUTREACH_TOUCHES.length) {
    await markOutreachComplete(env, row.id);
    return false;
  }

  const touch = OUTREACH_TOUCHES[row.lead_outreach_count];

  // Not yet at the day threshold — nothing to do this tick.
  if (daysElapsed < touch.dayThreshold) return null;

  // 9:00 AM–7:00 PM Central. A lead moved at 11 PM texts at 9 AM.
  if (!isWithinCentralSendWindow()) return null;

  // Load SMS template.
  const smsSetting = await env.DB.prepare(
    "SELECT value FROM system_settings WHERE key = ?",
  )
    .bind(touch.smsKey)
    .first<{ value: string }>();

  const mergeCtx = buildMergeContext(row);
  const smsBody = smsSetting?.value ? renderTemplate(smsSetting.value, mergeCtx) : null;

  const live = (env.NOTIFICATIONS_DISPATCH_MODE ?? "").toLowerCase() === "live";

  // ─── SMS dispatch (only channel for outreach sequence) ─────────────────────
  if (smsBody && row.phone) {
    const smsOptOut = row.sms_opt_out === 1;

    if (smsOptOut) {
      await logNotification(env, {
        triggerEvent: `lead_outreach_day_${row.lead_outreach_count + 1}`,
        recipientName: row.first_name ?? "Client",
        recipientContact: row.phone,
        channel: "sms",
        subject: null,
        body: smsBody,
        status: "skipped",
        skipReason: "sms_opt_out",
        clientId: row.client_id,
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
          const r = await sendSms(cfg, row.phone, smsBody);
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
        clientId: row.client_id,
        channel: "text_sms",
        summary: `${touch.label} outreach SMS`,
        body: smsBody,
      });

      await logNotification(env, {
        triggerEvent: `lead_outreach_day_${row.lead_outreach_count + 1}`,
        recipientName: row.first_name ?? "Client",
        recipientContact: row.phone,
        channel: "sms",
        subject: null,
        body: smsBody,
        status: smsStatus,
        errorMessage: smsError,
        clientId: row.client_id,
        estimateRequestId: row.id,
        externalId,
        communicationId: commId,
      });
    }
  }

  // ─── Update outreach state ──────────────────────────────────────────────────
  const newCount = row.lead_outreach_count + 1;

  await env.DB.prepare(
    `UPDATE estimate_requests SET
       lead_outreach_sequence_active = 1,
       lead_outreach_count = ?,
       last_outreach_date = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(newCount, row.id)
    .run();

  // After Day 3 touch (count was 2, now 3) → mark sequence complete.
  if (newCount >= OUTREACH_TOUCHES.length) {
    await markOutreachComplete(env, row.id);
  }

  return true;
}

async function markOutreachComplete(env: Env, requestId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE estimate_requests SET
       lead_outreach_sequence_active = 0,
       lead_outreach_completed_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(requestId)
    .run();
}

// ─── triggerPostVisitFollowUp ─────────────────────────────────────────────────

interface PostVisitRow {
  id: string;
  client_id: string;
  job_type: string;
  property_address: string;
  first_name: string | null;
  phone: string | null;
  email: string | null;
  sms_opt_out: number | null;
}

/**
 * Fire a single dual-channel (SMS + email) message when an estimate request
 * moves to visit_done. Called inline from the status-update handler.
 * Deduped via notification_logs: if a row already exists for
 * trigger_event='post_visit_follow_up' and estimate_request_id=requestId,
 * we skip silently.
 */
export async function triggerPostVisitFollowUp(requestId: string, env: Env): Promise<void> {
  // Dedupe check — only fire once per request.
  const existing = await env.DB.prepare(
    `SELECT id FROM notification_logs
     WHERE trigger_event = 'post_visit_follow_up' AND estimate_request_id = ?
     LIMIT 1`,
  )
    .bind(requestId)
    .first<{ id: string }>();

  if (existing) return; // Already fired.

  // Load the estimate request + client.
  const row = await env.DB.prepare(
    `SELECT er.id, er.client_id, er.job_type, er.property_address,
            c.first_name, c.phone, c.email, c.sms_opt_out
     FROM estimate_requests er
     JOIN clients c ON c.id = er.client_id
     WHERE er.id = ?`,
  )
    .bind(requestId)
    .first<PostVisitRow>();

  if (!row) {
    console.warn(`[post_visit] estimate request not found: ${requestId}`);
    return;
  }

  // Load templates.
  const [smsSetting, emailSubjectSetting, emailBodySetting] = await Promise.all([
    env.DB.prepare("SELECT value FROM system_settings WHERE key = 'post_visit_sms'")
      .first<{ value: string }>(),
    env.DB.prepare("SELECT value FROM system_settings WHERE key = 'post_visit_email_subject'")
      .first<{ value: string }>(),
    env.DB.prepare("SELECT value FROM system_settings WHERE key = 'post_visit_email_body'")
      .first<{ value: string }>(),
  ]);

  const mergeCtx = buildMergeContext(row);
  const smsBody = smsSetting?.value ? renderTemplate(smsSetting.value, mergeCtx) : null;
  const emailSubject = emailSubjectSetting?.value
    ? renderTemplate(emailSubjectSetting.value, mergeCtx)
    : null;
  const emailBody = emailBodySetting?.value
    ? renderTemplate(emailBodySetting.value, mergeCtx)
    : null;

  const live = (env.NOTIFICATIONS_DISPATCH_MODE ?? "").toLowerCase() === "live";

  // ─── SMS ───────────────────────────────────────────────────────────────────
  if (smsBody && row.phone) {
    const smsOptOut = row.sms_opt_out === 1;

    if (smsOptOut) {
      await logNotification(env, {
        triggerEvent: "post_visit_follow_up",
        recipientName: row.first_name ?? "Client",
        recipientContact: row.phone,
        channel: "sms",
        subject: null,
        body: smsBody,
        status: "skipped",
        skipReason: "sms_opt_out",
        clientId: row.client_id,
        estimateRequestId: requestId,
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
          const r = await sendSms(cfg, row.phone, smsBody);
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
        clientId: row.client_id,
        channel: "text_sms",
        summary: "Post-visit follow-up SMS",
        body: smsBody,
      });

      await logNotification(env, {
        triggerEvent: "post_visit_follow_up",
        recipientName: row.first_name ?? "Client",
        recipientContact: row.phone,
        channel: "sms",
        subject: null,
        body: smsBody,
        status: smsStatus,
        errorMessage: smsError,
        clientId: row.client_id,
        estimateRequestId: requestId,
        externalId,
        communicationId: commId,
      });
    }
  }

  // ─── Email ─────────────────────────────────────────────────────────────────
  if (emailBody && row.email) {
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
          row.email,
          emailSubject ?? "We're working on your estimate!",
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
      clientId: row.client_id,
      channel: "email",
      summary: "Post-visit follow-up email",
      body: emailBody,
    });

    await logNotification(env, {
      triggerEvent: "post_visit_follow_up",
      recipientName: row.first_name ?? "Client",
      recipientContact: row.email,
      channel: "email",
      subject: emailSubject,
      body: emailBody,
      status: emailStatus,
      errorMessage: emailError,
      clientId: row.client_id,
      estimateRequestId: requestId,
      externalId,
      communicationId: commId,
    });
  }
}

// ─── shared helpers ───────────────────────────────────────────────────────────

function parseCreatedAt(iso: string): Date | null {
  const t = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  return Number.isNaN(t.getTime()) ? null : t;
}

export function calcDaysSince(iso: string, now: Date = new Date()): number {
  const created = parseCreatedAt(iso);
  if (!created) return 0;
  return Math.floor((now.getTime() - created.getTime()) / 86_400_000);
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderTemplate(template: string, ctx: Record<string, string>): string {
  return renderTemplateText(template, ctx);
}

function buildMergeContext(row: { first_name: string | null; job_type: string; property_address: string }): Record<string, string> {
  const ctx: Record<string, string> = {};
  if (row.first_name) ctx.client_first_name = row.first_name;
  ctx.job_type = titleCase(row.job_type);
  ctx.property_address = row.property_address;
  return ctx;
}

interface LogNotificationArgs {
  triggerEvent: string;
  recipientName: string;
  recipientContact: string;
  channel: string;
  subject: string | null;
  body: string;
  status: string;
  skipReason?: string | null;
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
      OUTREACH_TEMPLATE_ID,
      a.triggerEvent,
      a.recipientName,
      a.recipientContact,
      a.channel,
      a.subject ?? null,
      a.body,
      a.status,
      a.errorMessage ?? a.skipReason ?? null,
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

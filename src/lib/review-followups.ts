/**
 * Sprint 35 — Google Review Request sequence.
 *
 * sendImmediateReviewRequest()  — called from handleCompletionPackageSend
 *   immediately after completion_package_sent_at is stamped.
 *
 * processReviewFollowUps()  — called from runNightly() (15 7 * * *), folded
 *   in alongside the punch-list reminder sweep.
 *
 * Sequence:
 *   Day 0 (immediate) → google_review_request     (dedupe_key: google_review_request_{jobId})
 *   Day 3             → google_review_followup_1  (dedupe_key: google_review_followup_1_{jobId})
 *   Day 7             → google_review_followup_2  (dedupe_key: google_review_followup_2_{jobId})
 *
 * Stop conditions (checked at query/send time):
 *   review_enabled = 0  → skip all sends for that job
 *   review_received = 1 → skip all follow-up sends
 *
 * All sends respect NOTIFICATIONS_DISPATCH_MODE. Failures are non-fatal —
 * the caller must wrap in try/catch so other processors are not disrupted.
 */

import type { Env } from "../env.js";
import { sendSms, getTwilioConfig, isConfigured as twilioConfigured } from "./twilio.js";

// Single hardcoded constant for v1 — not per-job, not configurable in UI.
export const GOOGLE_REVIEW_LINK = "https://g.page/r/CQ_gM4-vOzjFEBM/review";

const TEMPLATE_ID_SMS   = "tmpl-google-review-request-sms";
const TEMPLATE_ID_EMAIL = "tmpl-google-review-request-email";
const FOLLOWUP1_SMS     = "tmpl-google-review-followup1-sms";
const FOLLOWUP1_EMAIL   = "tmpl-google-review-followup1-email";
const FOLLOWUP2_SMS     = "tmpl-google-review-followup2-sms";
const FOLLOWUP2_EMAIL   = "tmpl-google-review-followup2-email";

interface ClientInfo {
  id: string;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  notification_preferences: string | null;
}

interface JobReviewRow {
  id: string;
  title: string | null;
  review_enabled: number;
  review_received: number;
  completion_package_sent_at: string | null;
  client_id: string | null;
}

export interface ReviewFollowUpStats {
  scanned: number;
  dispatched: number;
  skipped: number;
  errors: number;
  duration_ms: number;
}

// ─── Immediate send (day 0) ───────────────────────────────────────────────────

/**
 * Fire the immediate google_review_request send right after
 * completion_package_sent_at is stamped. Non-fatal — caller wraps in
 * try/catch. Skips if review_enabled = 0.
 */
export async function sendImmediateReviewRequest(
  env: Env,
  jobId: string,
  clientId: string | null,
): Promise<void> {
  const dedupeKey = `google_review_request_${jobId}`;

  // Idempotent — skip if already logged (resend protection).
  const already = await env.DB.prepare(
    "SELECT id FROM notification_logs WHERE dedupe_key = ?",
  ).bind(dedupeKey).first<{ id: string }>();
  if (already) return;

  // Confirm review_enabled on the job (may have been toggled before send).
  const job = await env.DB.prepare(
    "SELECT review_enabled FROM jobs WHERE id = ?",
  ).bind(jobId).first<{ review_enabled: number }>();
  if (!job || job.review_enabled === 0) return;

  if (!clientId) return;

  const client = await env.DB.prepare(
    "SELECT id, first_name, last_name, name, phone, email, notification_preferences FROM clients WHERE id = ?",
  ).bind(clientId).first<ClientInfo>();
  if (!client) return;

  const firstName = client.first_name ?? (client.name ?? "").split(" ")[0] ?? "";
  const mergeCtx: Record<string, string> = {
    review_link: GOOGLE_REVIEW_LINK,
    client_first_name: firstName,
  };

  const live = (env.NOTIFICATIONS_DISPATCH_MODE ?? "").toLowerCase() === "live";

  // ─── SMS ───────────────────────────────────────────────────────────────────
  if (client.phone && !isSmsOptOut(client.notification_preferences)) {
    const smsBody = await renderTemplate(env, TEMPLATE_ID_SMS, mergeCtx, "body");
    if (smsBody) {
      let smsStatus: "sent" | "simulated" | "failed" = "simulated";
      if (live) {
        const cfg = await getTwilioConfig(env);
        if (twilioConfigured(cfg)) {
          const r = await sendSms(cfg, client.phone, smsBody);
          smsStatus = r.ok ? "sent" : "failed";
          if (!r.ok) {
            console.warn(`[review_request] SMS failed for job ${jobId}: ${r.error}: ${r.details}`);
          }
        }
      } else {
        console.log(`[review_request][SIMULATE] SMS to=${client.phone} body="${smsBody.slice(0, 80)}"`);
      }

      await logNotification(env, {
        templateId: TEMPLATE_ID_SMS,
        triggerEvent: "google_review_request",
        channel: "sms",
        clientId: client.id,
        jobId,
        contact: client.phone,
        name: clientDisplayName(client),
        body: smsBody,
        subject: null,
        status: live ? smsStatus : "simulated",
        dedupeKey,
      });
    }
  }

  // ─── Email ─────────────────────────────────────────────────────────────────
  if (client.email) {
    const emailBody    = await renderTemplate(env, TEMPLATE_ID_EMAIL, mergeCtx, "body");
    const emailSubject = await renderTemplate(env, TEMPLATE_ID_EMAIL, mergeCtx, "subject");
    if (emailBody) {
      let emailStatus: "sent" | "simulated" | "failed" = "simulated";
      if (live) {
        const r = await sendResendEmail(
          env,
          client.email,
          emailSubject ?? "One quick favor — would you mind leaving us a review?",
          emailBody,
        );
        emailStatus = r.ok ? "sent" : "failed";
        if (!r.ok) {
          console.warn(`[review_request] email failed for job ${jobId}: ${r.error}`);
        }
      } else {
        console.log(`[review_request][SIMULATE] email to=${client.email} subject="${emailSubject}"`);
      }

      await logNotification(env, {
        templateId: TEMPLATE_ID_EMAIL,
        triggerEvent: "google_review_request",
        channel: "email",
        clientId: client.id,
        jobId,
        contact: client.email,
        name: clientDisplayName(client),
        body: emailBody,
        subject: emailSubject,
        status: live ? emailStatus : "simulated",
        dedupeKey: `${dedupeKey}_email`,
      });
    }
  }
}

// ─── Nightly follow-up sweep ──────────────────────────────────────────────────

/**
 * Day-3 and Day-7 follow-up sweep. Folded into the 15 7 * * * nightly cron.
 * Mirrors the calcDaysSince pattern from quote-follow-up.ts exactly.
 * Never throws — caller wraps in try/catch.
 */
export async function processReviewFollowUps(env: Env): Promise<ReviewFollowUpStats> {
  const started = Date.now();
  const stats: ReviewFollowUpStats = { scanned: 0, dispatched: 0, skipped: 0, errors: 0, duration_ms: 0 };

  // Jobs eligible for follow-up:
  //   - completion_package_sent_at IS NOT NULL (sequence anchored to this date)
  //   - review_enabled = 1 (stop condition)
  //   - review_received = 0 (stop condition)
  //   - completion_package_sent_at is within the day-7 window (no point scanning older jobs)
  const { results } = await env.DB.prepare(
    `SELECT j.id, j.title, j.review_enabled, j.review_received,
            j.completion_package_sent_at, j.client_id
     FROM jobs j
     WHERE j.completion_package_sent_at IS NOT NULL
       AND COALESCE(j.review_enabled, 1) = 1
       AND COALESCE(j.review_received, 0) = 0
     ORDER BY j.completion_package_sent_at ASC
     LIMIT 50`,
  ).all<JobReviewRow>();

  const rows = results ?? [];
  stats.scanned = rows.length;

  for (const row of rows) {
    try {
      const dispatched = await processOneJobFollowUp(env, row);
      if (dispatched) stats.dispatched++;
      else stats.skipped++;
    } catch (e) {
      stats.errors++;
      console.error(`[review_followup] error processing job ${row.id}:`, (e as Error).message);
    }
  }

  stats.duration_ms = Date.now() - started;
  return stats;
}

async function processOneJobFollowUp(env: Env, row: JobReviewRow): Promise<boolean> {
  if (!row.completion_package_sent_at || !row.client_id) return false;

  const daysSince = calcDaysSince(row.completion_package_sent_at);

  // Determine which follow-up is due.
  // Day 3 → followup_1,  Day 7 → followup_2
  // Mirror the >= threshold pattern from quote-follow-up.ts (no ±1 window).
  if (daysSince < 3) return false;

  const follows: Array<{
    minDay: number;
    maxDay: number;
    dedupeKey: string;
    triggerEvent: string;
    smsTmplId: string;
    emailTmplId: string;
  }> = [
    {
      minDay: 3,
      maxDay: 6,
      dedupeKey: `google_review_followup_1_${row.id}`,
      triggerEvent: "google_review_followup_1",
      smsTmplId: FOLLOWUP1_SMS,
      emailTmplId: FOLLOWUP1_EMAIL,
    },
    {
      minDay: 7,
      maxDay: 999,
      dedupeKey: `google_review_followup_2_${row.id}`,
      triggerEvent: "google_review_followup_2",
      smsTmplId: FOLLOWUP2_SMS,
      emailTmplId: FOLLOWUP2_EMAIL,
    },
  ];

  let dispatched = false;
  for (const follow of follows) {
    if (daysSince < follow.minDay) continue;

    // Already sent? Skip.
    const already = await env.DB.prepare(
      "SELECT id FROM notification_logs WHERE dedupe_key = ?",
    ).bind(follow.dedupeKey).first<{ id: string }>();
    if (already) continue;

    // Re-check stop conditions at send time.
    if (!row.review_enabled || row.review_received) return false;

    const client = await env.DB.prepare(
      "SELECT id, first_name, last_name, name, phone, email, notification_preferences FROM clients WHERE id = ?",
    ).bind(row.client_id).first<ClientInfo>();
    if (!client) continue;

    const firstName = client.first_name ?? (client.name ?? "").split(" ")[0] ?? "";
    const mergeCtx: Record<string, string> = {
      review_link: GOOGLE_REVIEW_LINK,
      client_first_name: firstName,
      job_title: row.title ?? "",
    };

    const live = (env.NOTIFICATIONS_DISPATCH_MODE ?? "").toLowerCase() === "live";

    // SMS
    if (client.phone && !isSmsOptOut(client.notification_preferences)) {
      const smsBody = await renderTemplate(env, follow.smsTmplId, mergeCtx, "body");
      if (smsBody) {
        let smsStatus: "sent" | "simulated" | "failed" = "simulated";
        if (live) {
          const cfg = await getTwilioConfig(env);
          if (twilioConfigured(cfg)) {
            const r = await sendSms(cfg, client.phone, smsBody);
            smsStatus = r.ok ? "sent" : "failed";
            if (!r.ok) {
              console.warn(`[review_followup] SMS failed job ${row.id}: ${r.error}: ${r.details}`);
            }
          }
        } else {
          console.log(`[review_followup][SIMULATE] ${follow.triggerEvent} SMS to=${client.phone} body="${smsBody.slice(0, 80)}"`);
        }

        await logNotification(env, {
          templateId: follow.smsTmplId,
          triggerEvent: follow.triggerEvent,
          channel: "sms",
          clientId: client.id,
          jobId: row.id,
          contact: client.phone,
          name: clientDisplayName(client),
          body: smsBody,
          subject: null,
          status: live ? smsStatus : "simulated",
          dedupeKey: follow.dedupeKey,
        });
        dispatched = true;
      }
    }

    // Email
    if (client.email) {
      const emailBody    = await renderTemplate(env, follow.emailTmplId, mergeCtx, "body");
      const emailSubject = await renderTemplate(env, follow.emailTmplId, mergeCtx, "subject");
      if (emailBody) {
        let emailStatus: "sent" | "simulated" | "failed" = "simulated";
        if (live) {
          const r = await sendResendEmail(env, client.email, emailSubject ?? "Following up", emailBody);
          emailStatus = r.ok ? "sent" : "failed";
          if (!r.ok) {
            console.warn(`[review_followup] email failed job ${row.id}: ${r.error}`);
          }
        } else {
          console.log(`[review_followup][SIMULATE] ${follow.triggerEvent} email to=${client.email} subject="${emailSubject}"`);
        }

        await logNotification(env, {
          templateId: follow.emailTmplId,
          triggerEvent: follow.triggerEvent,
          channel: "email",
          clientId: client.id,
          jobId: row.id,
          contact: client.email,
          name: clientDisplayName(client),
          body: emailBody,
          subject: emailSubject,
          status: live ? emailStatus : "simulated",
          dedupeKey: `${follow.dedupeKey}_email`,
        });
        dispatched = true;
      }
    }
  }

  return dispatched;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function calcDaysSince(iso: string): number {
  const t = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function clientDisplayName(c: ClientInfo): string {
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

function renderMergeFields(template: string, ctx: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => ctx[key] ?? "");
}

async function renderTemplate(
  env: Env,
  templateId: string,
  ctx: Record<string, string>,
  field: "body" | "subject",
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT body_template, subject FROM notification_templates WHERE id = ?`,
  ).bind(templateId).first<{ body_template: string | null; subject: string | null }>();
  if (!row) return null;
  const raw = field === "body" ? row.body_template : row.subject;
  if (!raw) return null;
  return renderMergeFields(raw, ctx);
}

interface LogArgs {
  templateId: string;
  triggerEvent: string;
  channel: string;
  clientId: string;
  jobId: string;
  contact: string;
  name: string;
  body: string;
  subject: string | null;
  status: string;
  dedupeKey: string;
}

async function logNotification(env: Env, a: LogArgs): Promise<void> {
  const sentAt = a.status === "sent" || a.status === "simulated" ? "datetime('now')" : "NULL";
  await env.DB.prepare(
    `INSERT OR IGNORE INTO notification_logs (
       id, template_id, trigger_event, recipient_type, recipient_name, recipient_contact,
       channel, subject, body, status, client_id, job_id,
       dedupe_key, sent_at, created_at
     ) VALUES (?, ?, ?, 'client', ?, ?, ?, ?, ?, ?, ?, ?, ?, ${sentAt}, datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      a.templateId,
      a.triggerEvent,
      a.name,
      a.contact,
      a.channel,
      a.subject ?? null,
      a.body,
      a.status,
      a.clientId,
      a.jobId,
      a.dedupeKey,
    )
    .run();
}

async function sendResendEmail(
  env: Env,
  to: string,
  subject: string,
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const from   = (env.NOTIFICATIONS_EMAIL_FROM ?? "").trim();
  const apiKey = (env.RESEND_API_KEY ?? "").trim();
  if (!from || !apiKey || env.RESEND_DRY_RUN === "1") {
    return { ok: true };
  }
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
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `resend_exception: ${(e as Error).message}` };
  }
}

/**
 * Sprint 27 follow-up — morning-of SMS reminder for scheduled proposal reviews.
 *
 * Folds into the existing every-15-min cron slot (runNotificationProcessor). Fires once
 * per estimate request per calendar day (Central) on the first tick after 8:00 AM CT.
 * Internal only — goes to the job's assigned PM (assigned_to, else created_by) when a
 * converted job exists, otherwise the active owner.
 */

import type { Env } from "../env.js";
import { resolveOwner } from "./notification-engine.js";
import { sendSms, getTwilioConfig, isConfigured as twilioConfigured } from "./twilio.js";
import { ctToday, toCtDate, ymd, utcDate } from "../services/wc-dates.js";

const TEMPLATE_ID = "tmpl-system-alert";

export interface ProposalReminderStats {
  scanned: number;
  dispatched: number;
  skipped: number;
  errors: number;
  duration_ms: number;
}

interface ReminderRow {
  id: string;
  proposal_review_date: string;
  job_type: string;
  property_address: string;
  client_id: string;
  client_first_name: string | null;
  client_last_name: string | null;
  job_assigned_to: string | null;
  job_created_by: string | null;
}

interface InternalUser {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
}

/** Current hour (0–23) in America/Chicago. */
function centralHour(now = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      hour12: false,
    }).format(now),
  );
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatReviewTime(iso: string): string {
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/Chicago",
  });
}

async function resolveInternalRecipient(
  env: Env,
  pmId: string | null,
): Promise<{ user: InternalUser | null; usedOwnerFallback: boolean }> {
  if (pmId) {
    const pm = await env.DB.prepare(
      "SELECT id, email, first_name, last_name, phone FROM users WHERE id = ? AND is_active = 1",
    )
      .bind(pmId)
      .first<InternalUser>();
    if (pm) return { user: pm, usedOwnerFallback: false };
  }
  const owner = await resolveOwner(env);
  return { user: owner, usedOwnerFallback: true };
}

/**
 * Main entry — called from runNotificationProcessor() every 15 min.
 * Must not throw; per-row errors are caught internally.
 */
export async function processProposalReviewReminders(env: Env): Promise<ProposalReminderStats> {
  const started = Date.now();
  const stats: ProposalReminderStats = {
    scanned: 0,
    dispatched: 0,
    skipped: 0,
    errors: 0,
    duration_ms: 0,
  };

  // Morning-of only — first eligible tick is ~8:00–8:15 AM Central.
  if (centralHour() < 8) {
    stats.duration_ms = Date.now() - started;
    return stats;
  }

  const todayCt = ymd(utcDate(ctToday()));
  const tomorrowParts = ctToday();
  const tomorrowDate = utcDate(todayCtPartsAddDay(tomorrowParts));
  const tomorrowCt = ymd(tomorrowDate);

  const { results } = await env.DB.prepare(
    `SELECT
       er.id,
       er.proposal_review_date,
       er.job_type,
       er.property_address,
       er.client_id,
       c.first_name AS client_first_name,
       c.last_name AS client_last_name,
       j.assigned_to AS job_assigned_to,
       j.created_by AS job_created_by
     FROM estimate_requests er
     JOIN clients c ON c.id = er.client_id
     LEFT JOIN jobs j ON j.id = er.converted_job_id
     WHERE er.proposal_review_date IS NOT NULL
       AND er.proposal_review_date >= ?
       AND er.proposal_review_date < ?
       AND er.status NOT IN ('won', 'lost')
     ORDER BY er.proposal_review_date ASC
     LIMIT 20`,
  )
    .bind(`${todayCt}T00:00:00`, `${tomorrowCt}T00:00:00`)
    .all<ReminderRow>();

  const live = (env.NOTIFICATIONS_DISPATCH_MODE ?? "").toLowerCase() === "live";

  for (const row of results ?? []) {
    stats.scanned++;
    try {
      if (toCtDate(row.proposal_review_date) !== todayCt) {
        stats.skipped++;
        continue;
      }

      const dedupeKey = `proposal_review_reminder:${row.id}:${todayCt}`;
      const existing = await env.DB.prepare(
        "SELECT id FROM notification_logs WHERE dedupe_key = ? LIMIT 1",
      )
        .bind(dedupeKey)
        .first<{ id: string }>();
      if (existing) {
        stats.skipped++;
        continue;
      }

      const pmId = row.job_assigned_to ?? row.job_created_by;
      const { user: recipient, usedOwnerFallback } = await resolveInternalRecipient(env, pmId);
      if (!recipient?.phone) {
        console.warn(
          `[proposal_reminder] No phone for recipient on request ${row.id}` +
            (usedOwnerFallback ? " (owner fallback)" : " (assigned PM)"),
        );
        stats.skipped++;
        continue;
      }

      const clientName = [row.client_first_name, row.client_last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
      const reviewTime = formatReviewTime(row.proposal_review_date);
      const jobLabel = titleCase(row.job_type || "project");
      const messageBody =
        `📅 Proposal Review Today — ${clientName}, ${jobLabel} at ${row.property_address}.` +
        (reviewTime ? ` Scheduled for ${reviewTime}.` : "");

      let externalId: string;
      let smsStatus: "sent" | "failed";

      if (!live) {
        console.log(
          `[proposal_reminder] SIMULATE — would send to ${recipient.phone}: ${messageBody}`,
        );
        externalId = `simulated:${crypto.randomUUID()}`;
        smsStatus = "sent";
      } else {
        const cfg = await getTwilioConfig(env);
        if (twilioConfigured(cfg)) {
          const r = await sendSms(cfg, recipient.phone, messageBody);
          if (r.ok) {
            externalId = r.sid;
            smsStatus = "sent";
          } else {
            externalId = `failed:${crypto.randomUUID()}`;
            smsStatus = "failed";
            console.error(
              `[proposal_reminder] SMS failed for request ${row.id}: ${r.error}: ${r.details}`,
            );
          }
        } else {
          externalId = `simulated:${crypto.randomUUID()}`;
          smsStatus = "sent";
        }
      }

      const recipientName =
        [recipient.first_name, recipient.last_name].filter(Boolean).join(" ").trim() ||
        recipient.email;

      await env.DB.prepare(
        `INSERT INTO notification_logs (
           id, template_id, trigger_event, recipient_type, recipient_name, recipient_contact,
           recipient_user_id, channel, subject, body, status, external_id, client_id,
           estimate_request_id, dedupe_key, sent_at, created_at
         ) VALUES (?, ?, 'proposal_review_reminder', 'user', ?, ?, ?, 'sms', NULL, ?, ?, ?, ?, ?, ?, ${
           smsStatus === "sent" ? "datetime('now')" : "NULL"
         }, datetime('now'))`,
      )
        .bind(
          crypto.randomUUID(),
          TEMPLATE_ID,
          recipientName,
          recipient.phone,
          recipient.id,
          messageBody,
          smsStatus,
          externalId,
          row.client_id,
          row.id,
          dedupeKey,
        )
        .run();

      stats.dispatched++;
    } catch (err) {
      stats.errors++;
      console.error(
        `[proposal_reminder] error processing request ${row.id}:`,
        (err as Error).message,
      );
    }
  }

  stats.duration_ms = Date.now() - started;
  return stats;
}

function todayCtPartsAddDay(parts: { year: number; month: number; day: number }): {
  year: number;
  month: number;
  day: number;
} {
  const d = utcDate(parts);
  d.setUTCDate(d.getUTCDate() + 1);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

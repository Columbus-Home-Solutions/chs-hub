/**
 * Nightly punch list reminder sweep (Sprint 33).
 *
 * Folded into the existing 15 7 * * * cron handler — day-of reminders and
 * 1-day-after follow-ups for open items on sent lists with a scheduled_date.
 */

import type { Env } from "../env.js";
import { getTwilioConfig, isConfigured as twilioConfigured, sendSms } from "./twilio.js";
import { punchListSecureLink } from "./punch-list-pdf.js";

async function sendPunchListEmail(
  env: Env,
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  const live = (env.NOTIFICATIONS_DISPATCH_MODE ?? "").toLowerCase() === "live";
  const from = (env.NOTIFICATIONS_EMAIL_FROM ?? "").trim();
  const apiKey = (env.RESEND_API_KEY ?? "").trim();

  if (!live || !from || !apiKey || env.RESEND_DRY_RUN === "1") {
    console.log(`[punch-list-reminder][SIMULATE] email to=${to} subject="${subject}"`);
    return;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text: body }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[punch-list-reminder] email failed ${res.status}: ${detail.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn(`[punch-list-reminder] email exception: ${(e as Error).message}`);
  }
}

export async function runPunchListReminderSweep(env: Env): Promise<{ scanned: number; reminded: number; followups: number }> {
  const stats = { scanned: 0, reminded: 0, followups: 0 };
  const twilioCfg = await getTwilioConfig(env);

  const { results: sentLists } = await env.DB.prepare(
    `SELECT pl.id, pl.job_id, pl.scheduled_date, pl.sent_at,
            j.title AS job_title, j.property_address
       FROM punch_lists pl
       JOIN jobs j ON j.id = pl.job_id
      WHERE pl.status = 'sent'
        AND pl.scheduled_date IS NOT NULL`,
  ).all<{
    id: string;
    job_id: string;
    scheduled_date: string;
    sent_at: string | null;
    job_title: string | null;
    property_address: string | null;
  }>();

  const today = new Date().toISOString().split("T")[0];

  for (const list of sentLists ?? []) {
    stats.scanned++;

    const { results: tokens } = await env.DB.prepare(
      `SELECT pst.*,
              s.phone, s.email,
              COALESCE(s.company_name, s.company) AS company_name,
              COALESCE(s.contact_name, s.primary_contact) AS contact_name
         FROM punch_list_sub_tokens pst
         JOIN subcontractors s ON s.id = pst.sub_id
        WHERE pst.punch_list_id = ? AND pst.is_active = 1`,
    )
      .bind(list.id)
      .all<{
        id: string;
        sub_id: string;
        token: string;
        reminder_sent_at: string | null;
        followup_sent_at: string | null;
        phone: string | null;
        email: string | null;
        company_name: string | null;
        contact_name: string | null;
      }>();

    for (const token of tokens ?? []) {
      const openItems = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM punch_list_items
          WHERE punch_list_id = ? AND sub_id = ? AND status = 'open'`,
      )
        .bind(list.id, token.sub_id)
        .first<{ n: number }>();

      if (!openItems || openItems.n === 0) continue;

      const schedDate = list.scheduled_date;
      const subName = (token.contact_name || token.company_name || "there") as string;
      const link = punchListSecureLink(token.token);
      const jobTitle = list.job_title ?? "your project";
      const msg = `Hi ${subName}, reminder: you have ${openItems.n} open punch list item(s) for ${jobTitle}. View and complete here: ${link}`;

      if (schedDate === today && !token.reminder_sent_at) {
        if (token.phone && twilioConfigured(twilioCfg)) {
          await sendSms(twilioCfg, token.phone, msg);
        }
        if (token.email) {
          await sendPunchListEmail(env, token.email, `Punch List Reminder — ${jobTitle}`, msg);
        }
        await env.DB.prepare(
          `UPDATE punch_list_sub_tokens SET reminder_sent_at = datetime('now') WHERE id = ?`,
        )
          .bind(token.id)
          .run();
        stats.reminded++;
      }

      const dayAfter = new Date(schedDate + "T12:00:00Z");
      dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
      const dayAfterStr = dayAfter.toISOString().split("T")[0];

      if (dayAfterStr === today && !token.followup_sent_at) {
        const followupMsg = `Hi ${subName}, your punch list items for ${jobTitle} were due yesterday and are still open. Please complete ASAP: ${link}`;
        if (token.phone && twilioConfigured(twilioCfg)) {
          await sendSms(twilioCfg, token.phone, followupMsg);
        }
        if (token.email) {
          await sendPunchListEmail(
            env,
            token.email,
            `Punch List Past Due — ${jobTitle}`,
            followupMsg,
          );
        }
        await env.DB.prepare(
          `UPDATE punch_list_sub_tokens SET followup_sent_at = datetime('now') WHERE id = ?`,
        )
          .bind(token.id)
          .run();
        stats.followups++;
      }
    }
  }

  return stats;
}

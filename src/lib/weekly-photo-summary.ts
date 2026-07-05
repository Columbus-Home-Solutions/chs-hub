/**
 * Weekly photo summary cron (Sprint 18 carry-forward).
 *
 * Fires `weekly_photo_summary` notifications for in-progress jobs that received
 * at least one active photo in the past 7 days. Runs on Monday only, piggybacks
 * on the nightly (15 7 * * *) cron — no extra trigger.
 *
 * Sprint 38 Run 2: also generates a Claude-written recap paragraph grounded in
 * that week's daily logs, schedule entries, and photo count. Recap is passed as
 * the {{weekly_recap}} merge field. Fails gracefully to a fallback string if
 * Claude is unavailable — the photo-link behavior is unchanged either way.
 */

import type { Env } from "../env.js";
import { triggerNotification } from "./notification-engine.js";
import { generateWeeklyRecap } from "./weekly-recap.js";

interface JobPhotoRow {
  job_id: string;
  client_id: string;
  title: string | null;
  portal_token: string | null;
  photo_count: number;
  billing_model: string | null;
  portal_type: string | null;
}

/** ISO week key for dedupe (one summary per job per week). */
function weekInstanceKey(d: Date = new Date()): string {
  const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `week:${utc.getUTCFullYear()}-W${week}`;
}

/** Returns YYYY-MM-DD for N days ago relative to now (UTC). */
function daysAgoIso(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function runWeeklyPhotoSummary(env: Env): Promise<void> {
  if (new Date().getDay() !== 1) return;

  const origin = (env.APP_PUBLIC_ORIGIN ?? "https://client.homesolutionsar.com").replace(/\/$/, "");
  const instanceKey = weekInstanceKey();
  const weekEnd = daysAgoIso(0);   // today (Monday = end of the review window)
  const weekStart = daysAgoIso(7); // 7 days ago

  const { results } = await env.DB.prepare(
    `SELECT j.id AS job_id, j.client_id, j.title, j.portal_token,
            j.billing_model, j.portal_type,
            COUNT(p.id) AS photo_count
       FROM jobs j
       INNER JOIN photos p ON p.job_id = j.id
        AND p.created_at >= datetime('now', '-7 days')
        AND p.is_active = 1
      WHERE j.status = 'in_progress'
        AND j.client_id IS NOT NULL
      GROUP BY j.id`,
  ).all<JobPhotoRow>();

  let fired = 0;
  for (const row of results ?? []) {
    if (!row.client_id) continue;

    const photoSummaryLink = row.portal_token ? `${origin}/portal/${row.portal_token}` : origin;

    // Cost-plus gating: only include budget language for open-book jobs.
    const isCostPlus =
      (row.billing_model ?? "").toLowerCase() === "cost_plus" ||
      (row.portal_type ?? "").toLowerCase() === "cost_plus";

    // Generate the AI recap paragraph for this job's week.
    // Non-fatal: generateWeeklyRecap always returns a string (fallback if AI fails).
    let weeklyRecap = "";
    try {
      weeklyRecap = await generateWeeklyRecap(env, {
        jobId: row.job_id,
        jobTitle: row.title ?? "your project",
        weekStart,
        weekEnd,
        photoCount: row.photo_count,
        isCostPlus,
      });
    } catch (err) {
      console.warn(
        `[weekly_photo_summary] recap generation failed for job ${row.job_id}:`,
        (err as Error).message,
      );
      weeklyRecap = `We made progress on your project this week${row.photo_count > 0 ? ` and added ${row.photo_count} new photo${row.photo_count === 1 ? "" : "s"}` : ""}. Check the link below for the latest updates.`;
    }

    await triggerNotification(env, "weekly_photo_summary", {
      clientId: row.client_id,
      jobId: row.job_id,
      instanceKey,
      merge: {
        photo_count: String(row.photo_count),
        photo_summary_link: photoSummaryLink,
        weekly_recap: weeklyRecap,
        ...(row.title ? { job_title: row.title } : {}),
      },
    });
    fired++;
  }

  console.log(`[weekly_photo_summary] fired for ${fired} jobs`);
}

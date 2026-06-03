/**
 * Weekly photo summary cron (Sprint 18 carry-forward).
 *
 * Fires `weekly_photo_summary` notifications for in-progress jobs that received
 * at least one active photo in the past 7 days. Runs on Monday only, piggybacks
 * on the nightly (15 7 * * *) cron — no extra trigger.
 */

import type { Env } from "../env.js";
import { triggerNotification } from "./notification-engine.js";

interface JobPhotoRow {
  job_id: string;
  client_id: string;
  title: string | null;
  portal_token: string | null;
  photo_count: number;
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

export async function runWeeklyPhotoSummary(env: Env): Promise<void> {
  if (new Date().getDay() !== 1) return;

  const origin = (env.APP_PUBLIC_ORIGIN ?? "https://client.homesolutionsar.com").replace(/\/$/, "");
  const instanceKey = weekInstanceKey();

  const { results } = await env.DB.prepare(
    `SELECT j.id AS job_id, j.client_id, j.title, j.portal_token, COUNT(p.id) AS photo_count
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
    await triggerNotification(env, "weekly_photo_summary", {
      clientId: row.client_id,
      jobId: row.job_id,
      instanceKey,
      merge: {
        photo_count: String(row.photo_count),
        photo_summary_link: photoSummaryLink,
        ...(row.title ? { job_title: row.title } : {}),
      },
    });
    fired++;
  }

  console.log(`[weekly_photo_summary] fired for ${fired} jobs`);
}

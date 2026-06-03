/**
 * Content schedules — list / detail / monthly generator (Sprint 16, Deliverable C).
 *
 *   GET  /api/content-schedules            list (+ counts from the view)
 *   GET  /api/content-schedules/:id        detail + its posts (by month/year)
 *   POST /api/content-schedules/generate   { month, year } — the generator
 *
 * Linkage to a schedule is by month/year (the `v_content_schedule_counts` view
 * joins social_posts.scheduled_date → content_schedules.month/year). There is NO
 * schedule_id FK and this sprint does not add one. The generator writes the
 * batch as `pending_approval` (generated_by='ai_schedule') and creates/refreshes
 * the `content_schedules` row set to `active`.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { createOwnerInApp } from "../lib/notification-engine.js";
import { planSchedule, type PlannedPost, type SchedulableJob } from "../lib/content-schedule.js";
import {
  fallbackHashtags,
  generateCaptions,
  generateHashtags,
  type CaptionContext,
} from "../lib/social-ai.js";
import { err, json, logSocialAudit, readJson, shapeSocialPost, type SocialPostRow } from "../lib/social.js";

const OWNER_ONLY = ["owner"] as const;

// ─── GET /api/content-schedules ─────────────────────────────────────────────

export async function handleContentScheduleList(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT cs.id, cs.month, cs.year, cs.status, cs.generated_date, cs.notes, cs.created_at,
            COALESCE(v.total_posts_planned, 0) AS total_posts_planned,
            COALESCE(v.job_completion_count, 0) AS job_completion_count,
            COALESCE(v.seasonal_count, 0) AS seasonal_count,
            COALESCE(v.tips_count, 0) AS tips_count
       FROM content_schedules cs
       LEFT JOIN v_content_schedule_counts v ON v.schedule_id = cs.id
      ORDER BY cs.year DESC, cs.month DESC`,
  ).all<Record<string, unknown>>();
  return json({ as_of: new Date().toISOString(), schedules: results ?? [] });
}

// ─── GET /api/content-schedules/:id ─────────────────────────────────────────

export async function handleContentScheduleGet(env: Env, id: string): Promise<Response> {
  const schedule = await env.DB.prepare(
    `SELECT cs.id, cs.month, cs.year, cs.status, cs.generated_date, cs.notes, cs.created_at,
            COALESCE(v.total_posts_planned, 0) AS total_posts_planned,
            COALESCE(v.job_completion_count, 0) AS job_completion_count,
            COALESCE(v.seasonal_count, 0) AS seasonal_count,
            COALESCE(v.tips_count, 0) AS tips_count
       FROM content_schedules cs
       LEFT JOIN v_content_schedule_counts v ON v.schedule_id = cs.id
      WHERE cs.id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!schedule) return err(404, "not_found", "Schedule not found.");

  // Posts for this schedule = posts scheduled in its month/year (no FK).
  const month = Number(schedule.month);
  const year = Number(schedule.year);
  const { results } = await env.DB.prepare(
    `SELECT * FROM social_posts
      WHERE CAST(strftime('%m', scheduled_date) AS INTEGER) = ?
        AND CAST(strftime('%Y', scheduled_date) AS INTEGER) = ?
      ORDER BY scheduled_date ASC`,
  )
    .bind(month, year)
    .all<SocialPostRow>();

  return json({ schedule, posts: (results ?? []).map(shapeSocialPost) });
}

// ─── POST /api/content-schedules/generate ───────────────────────────────────

export async function handleContentScheduleGenerate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  const now = new Date();
  const month = Number(body?.month ?? now.getUTCMonth() + 1);
  const year = Number(body?.year ?? now.getUTCFullYear());
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return err(400, "bad_request", "month must be 1–12.");
  }
  if (!Number.isInteger(year) || year < 2024 || year > 2100) {
    return err(400, "bad_request", "year is out of range.");
  }

  // 1) Jobs expected to complete this month (actual_end_date preferred, else
  //    target_end_date), with their social-ready photo availability.
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  const { results: jobRows } = await env.DB.prepare(
    `SELECT j.id, j.job_type, j.property_city, j.estimate_id,
            COALESCE(j.actual_end_date, j.target_end_date) AS completion_date,
            (SELECT COUNT(*) FROM photos p
              WHERE p.job_id = j.id AND COALESCE(p.is_active,1)=1 AND COALESCE(p.is_social_ready,0)=1) AS social_ready
       FROM jobs j
      WHERE j.source = 'estimate'
        AND substr(COALESCE(j.actual_end_date, j.target_end_date), 1, 7) = ?`,
  )
    .bind(ym)
    .all<{
      id: string;
      job_type: string | null;
      property_city: string | null;
      estimate_id: string | null;
      completion_date: string | null;
      social_ready: number;
    }>();

  const jobsById = new Map((jobRows ?? []).map((j) => [j.id, j]));
  const schedulableJobs: SchedulableJob[] = (jobRows ?? [])
    .filter((j) => j.completion_date)
    .map((j) => ({
      id: j.id,
      jobType: j.job_type,
      completionDate: j.completion_date as string,
      hasSocialReady: (j.social_ready ?? 0) > 0,
    }));

  // 2) Recent post dates (spacing hint).
  const { results: recent } = await env.DB.prepare(
    "SELECT scheduled_date FROM social_posts WHERE scheduled_date IS NOT NULL ORDER BY scheduled_date DESC LIMIT 30",
  ).all<{ scheduled_date: string }>();
  const recentPostDates = (recent ?? []).map((r) => r.scheduled_date);

  // 3) Plan the balanced batch (pure).
  const plan = planSchedule({ month, year, jobs: schedulableJobs, recentPostDates });

  // 4) Draft + insert each planned post as pending_approval (generated_by='ai_schedule').
  const createdIds: string[] = [];
  for (const planned of plan.posts) {
    const id = await draftAndInsert(env, planned, jobsById);
    if (id) createdIds.push(id);
  }

  // 5) Create / refresh the content_schedules row → active.
  const existing = await env.DB.prepare(
    "SELECT id FROM content_schedules WHERE month = ? AND year = ?",
  )
    .bind(month, year)
    .first<{ id: string }>();
  let scheduleId: string;
  if (existing) {
    scheduleId = existing.id;
    await env.DB.prepare(
      "UPDATE content_schedules SET status = 'active', generated_date = datetime('now') WHERE id = ?",
    )
      .bind(scheduleId)
      .run();
  } else {
    scheduleId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO content_schedules (id, month, year, status, generated_date, created_at) VALUES (?, ?, ?, 'active', datetime('now'), datetime('now'))",
    )
      .bind(scheduleId, month, year)
      .run();
  }

  // 6) Notify owner about jobs skipped for missing social-ready photos.
  if (plan.skippedJobs.length > 0) {
    await createOwnerInApp(env, {
      message: `Monthly schedule generated. ${plan.skippedJobs.length} completing job(s) were skipped — flag their photos as social-ready to include them.`,
      linkPath: "/app/social",
      dedupe: `social_schedule_skipped:${ym}`,
    });
  }

  await logSocialAudit(env, user.email, "content_schedule_generated", scheduleId, {
    month,
    year,
    posts_created: createdIds.length,
    skipped_jobs: plan.skippedJobs.length,
  });

  return json(
    {
      ok: true,
      schedule_id: scheduleId,
      month,
      year,
      posts_created: createdIds.length,
      skipped_jobs: plan.skippedJobs,
    },
    { status: 201 },
  );
}

// ─── per-post drafting ─────────────────────────────────────────────────────

async function draftAndInsert(
  env: Env,
  planned: PlannedPost,
  jobsById: Map<string, { job_type: string | null; property_city: string | null; estimate_id: string | null }>,
): Promise<string | null> {
  try {
    let ctx: CaptionContext;
    let photoIds: string[] = [];
    let jobId: string | null = planned.job_id;

    if (planned.post_type === "job_completion" && planned.job_id) {
      const job = jobsById.get(planned.job_id);
      // Pick social-ready before/after photos for this job.
      const { results: ph } = await env.DB.prepare(
        `SELECT id, is_before_photo, is_after_photo FROM photos
          WHERE job_id = ? AND COALESCE(is_active,1)=1 AND COALESCE(is_social_ready,0)=1
          ORDER BY COALESCE(taken_at, created_at) DESC LIMIT 4`,
      )
        .bind(planned.job_id)
        .all<{ id: string; is_before_photo: number | null; is_after_photo: number | null }>();
      const before = (ph ?? []).find((p) => p.is_before_photo);
      const after = (ph ?? []).find((p) => p.is_after_photo);
      photoIds = [before?.id, after?.id].filter(Boolean) as string[];
      if (photoIds.length === 0) photoIds = (ph ?? []).slice(0, 2).map((p) => p.id);

      let scope: string | null = null;
      if (job?.estimate_id) {
        const { results: items } = await env.DB.prepare(
          "SELECT product_service FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order ASC LIMIT 6",
        )
          .bind(job.estimate_id)
          .all<{ product_service: string | null }>();
        const names = (items ?? []).map((i) => i.product_service).filter(Boolean) as string[];
        if (names.length) scope = names.join(", ");
      }
      ctx = {
        kind: "job_completion",
        jobType: job?.job_type ?? null,
        scope,
        city: job?.property_city ?? null, // city only (rule #9)
        beforeDescription: null,
        afterDescription: null,
      };
    } else {
      ctx = {
        kind: planned.post_type === "tips_tricks" ? "tips_tricks" : "seasonal_tips",
        topic: planned.topic ?? "home improvement tips",
        season: planned.season,
      };
    }

    const id = crypto.randomUUID();
    const captionRes = await generateCaptions(env, ctx);
    const caption = captionRes.ok
      ? captionRes.options[0]
      : ctx.kind === "job_completion"
        ? `Another project complete! Free estimates — call us!`
        : `${planned.topic ?? "Home tips"} — from your central-Arkansas remodeling team.`;
    const hashRes = await generateHashtags(env, ctx, `${id}`).catch(() => ({
      ok: true,
      hashtags: fallbackHashtags(id),
      fallback: true,
    }));

    await env.DB.prepare(
      `INSERT INTO social_posts
         (id, post_type, status, caption, hashtags, platform, scheduled_date,
          job_id, photo_ids, generated_by, created_at)
       VALUES (?, ?, 'pending_approval', ?, ?, 'both', ?, ?, ?, 'ai_schedule', datetime('now'))`,
    )
      .bind(
        id,
        planned.post_type,
        caption,
        JSON.stringify(hashRes.hashtags),
        planned.scheduled_date,
        jobId,
        photoIds.length ? JSON.stringify(photoIds) : null,
      )
      .run();
    return id;
  } catch (err) {
    console.error("[content-schedules] draftAndInsert failed:", (err as Error).message);
    return null;
  }
}

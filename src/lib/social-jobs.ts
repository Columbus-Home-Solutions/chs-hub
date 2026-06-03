/**
 * Job-completion post auto-generation (Sprint 16, Deliverable E).
 *
 * A labeled seam off the existing `job → Complete` transition (jobs-api.ts).
 * It NEVER auto-publishes — everything it creates enters the approval queue as
 * `pending_approval` (business rule #1).
 *
 *   Has social-ready photos? → auto-select best before/after, draft captions via
 *     Deliverable B, create a `pending_approval` post (generated_by='ai_job_complete').
 *   No social-ready photos?  → fire the SIMULATE "flag photos?" owner alert,
 *     create nothing (business rule #2).
 *
 * Non-fatal by contract: any failure here is logged and swallowed so a social
 * hiccup never blocks the job's status change.
 */

import type { Env } from "../env.js";
import { createOwnerInApp } from "./notification-engine.js";
import { fallbackHashtags, generateCaptions, generateHashtags } from "./social-ai.js";
import { logSocialAudit } from "./social.js";

interface JobRow {
  id: string;
  job_type: string | null;
  title: string | null;
  property_city: string | null;
  estimate_id: string | null;
}

interface PhotoLite {
  id: string;
  caption: string | null;
  is_before_photo: number | null;
  is_after_photo: number | null;
  taken_at: string | null;
}

export interface JobCompletionResult {
  created: boolean;
  notified: boolean;
  post_id?: string;
  reason?: string;
}

/** Select the best before/after pair from a job's social-ready photos. */
export function selectBeforeAfter(photos: PhotoLite[]): { before: PhotoLite | null; after: PhotoLite | null; ordered: PhotoLite[] } {
  const afters = photos.filter((p) => p.is_after_photo).sort(byTakenDesc);
  const befores = photos.filter((p) => p.is_before_photo).sort(byTakenDesc);
  const after = afters[0] ?? null;
  const before = befores[0] ?? null;
  const ordered: PhotoLite[] = [];
  if (before) ordered.push(before);
  if (after) ordered.push(after);
  // If neither flagged, fall back to the most recent social-ready photos.
  if (ordered.length === 0) {
    return { before: null, after: null, ordered: [...photos].sort(byTakenDesc).slice(0, 2) };
  }
  return { before, after, ordered };
}

function byTakenDesc(a: PhotoLite, b: PhotoLite): number {
  return (b.taken_at ?? "").localeCompare(a.taken_at ?? "");
}

/**
 * Entry point hooked from handleJobStatus when a job reaches `complete`.
 * Returns a small result for logging; never throws.
 */
export async function maybeGenerateJobCompletionPost(
  env: Env,
  jobId: string,
  actor: string,
): Promise<JobCompletionResult> {
  try {
    // Idempotency: one auto-generated completion post per job.
    const existing = await env.DB.prepare(
      "SELECT id FROM social_posts WHERE job_id = ? AND generated_by = 'ai_job_complete' LIMIT 1",
    )
      .bind(jobId)
      .first<{ id: string }>();
    if (existing) return { created: false, notified: false, reason: "already_generated" };

    const job = await env.DB.prepare(
      "SELECT id, job_type, title, property_city, estimate_id FROM jobs WHERE id = ?",
    )
      .bind(jobId)
      .first<JobRow>();
    if (!job) return { created: false, notified: false, reason: "job_not_found" };

    const { results: photoRows } = await env.DB.prepare(
      `SELECT id, caption, is_before_photo, is_after_photo, taken_at
         FROM photos
        WHERE job_id = ? AND COALESCE(is_active, 1) = 1 AND COALESCE(is_social_ready, 0) = 1
        ORDER BY COALESCE(taken_at, created_at) DESC`,
    )
      .bind(jobId)
      .all<PhotoLite>();
    const photos = photoRows ?? [];

    // No social-ready photos → notify, create nothing (business rule #2).
    if (photos.length === 0) {
      await createOwnerInApp(env, {
        message: `Job "${job.title ?? job.id}" was completed — flag before/after photos to create a social post?`,
        linkPath: `/app/jobs/${jobId}`,
        dedupe: `social_flag_photos:${jobId}`,
      });
      return { created: false, notified: true, reason: "no_social_ready_photos" };
    }

    const { ordered } = selectBeforeAfter(photos);
    const photoIds = ordered.map((p) => p.id);

    // Scope summary from estimate line items (no address — city only downstream).
    let scope: string | null = null;
    if (job.estimate_id) {
      const { results: items } = await env.DB.prepare(
        "SELECT product_service FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order ASC LIMIT 6",
      )
        .bind(job.estimate_id)
        .all<{ product_service: string | null }>();
      const names = (items ?? []).map((i) => i.product_service).filter(Boolean) as string[];
      if (names.length) scope = names.join(", ");
    }

    const ctx = {
      kind: "job_completion" as const,
      jobType: job.job_type,
      scope,
      city: job.property_city, // city ONLY — never the street address (rule #9)
      beforeDescription: ordered.find((p) => p.is_before_photo)?.caption ?? null,
      afterDescription: ordered.find((p) => p.is_after_photo)?.caption ?? null,
    };

    const captionRes = await generateCaptions(env, ctx);
    const caption = captionRes.ok
      ? captionRes.options[0]
      : `Another ${job.job_type ?? "project"} complete${job.property_city ? ` in ${job.property_city}` : ""}! Free estimates — call us!`;

    const hashRes = await generateHashtags(env, ctx, jobId).catch(() => ({
      ok: true,
      hashtags: fallbackHashtags(jobId, job.job_type),
      fallback: true,
    }));

    const id = crypto.randomUUID();
    // Suggest a near-future slot (tomorrow 6 PM) — owner reschedules freely.
    const scheduled = new Date(Date.now() + 24 * 3_600_000);
    scheduled.setUTCHours(23, 0, 0, 0); // ~6 PM Central
    await env.DB.prepare(
      `INSERT INTO social_posts
         (id, post_type, status, caption, hashtags, platform, scheduled_date,
          job_id, photo_ids, generated_by, created_at)
       VALUES (?, 'job_completion', 'pending_approval', ?, ?, 'both', ?, ?, ?, 'ai_job_complete', datetime('now'))`,
    )
      .bind(
        id,
        caption,
        JSON.stringify(hashRes.hashtags),
        scheduled.toISOString(),
        jobId,
        JSON.stringify(photoIds),
      )
      .run();

    await logSocialAudit(env, actor, "social_post_autogenerated", id, {
      job_id: jobId,
      ai_caption: captionRes.ok,
      photo_count: photoIds.length,
    });

    return { created: true, notified: false, post_id: id };
  } catch (err) {
    console.error("[social-jobs] maybeGenerateJobCompletionPost failed:", (err as Error).message);
    return { created: false, notified: false, reason: (err as Error).message };
  }
}

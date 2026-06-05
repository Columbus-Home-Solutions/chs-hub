/**
 * Social-post CRUD + queue + lifecycle (Sprint 16, Deliverable A/B/D).
 *
 *   GET    /api/social-posts                 list (?status=&type=&from=&to=)
 *   GET    /api/social-posts/queue           approval queue (pending_approval)
 *   POST   /api/social-posts                 create a manual post
 *   POST   /api/social-posts/approve-batch   batch approve { ids: [] }
 *   GET    /api/social-posts/:id             detail (+ resolved photos / image)
 *   PUT    /api/social-posts/:id             update (blocked once published)
 *   DELETE /api/social-posts/:id             hard delete (blocked once published)
 *   POST   /api/social-posts/:id/approve     pending/draft → approved
 *   POST   /api/social-posts/:id/reject      → rejected (+ reason)
 *   POST   /api/social-posts/:id/regenerate  re-run caption (+ optional hashtags)
 *   POST   /api/social-posts/:id/generate-image  Gemini Imagen image (gated on key)
 *   GET    /api/social-posts/:id/image       stream the generated image from R2
 *
 * Soft vs. hard delete: `social_posts` has NO is_active column (confirmed in
 * Step 0), so un-published posts are hard-deleted; a `published` post is never
 * deletable (or editable) — both return a clear 409. Every state transition is
 * audit-logged.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { generateAndStoreImage, streamSocialImage } from "../lib/image-gen.js";
import {
  generateCaptions,
  generateHashtags,
  generateImageSubjectPrompt,
  type CaptionContext,
} from "../lib/social-ai.js";
import {
  err,
  json,
  logSocialAudit,
  parseJsonArray,
  PLATFORMS,
  POST_TYPES,
  readJson,
  resolvePhotoRefs,
  shapeSocialPost,
  str,
  type Platform,
  type PostType,
  type SocialPostRow,
} from "../lib/social.js";
import { imageGenConfigured } from "../lib/image-gen.js";

const WRITE_ROLES = ["owner", "office_admin"] as const;
const OWNER_ONLY = ["owner"] as const;

const POST_TYPE_SET = new Set<string>(POST_TYPES);
const PLATFORM_SET = new Set<string>(PLATFORMS);

/** Store scheduled_date as UTC ISO for cron comparisons. */
function normalizeScheduledDate(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? raw : d.toISOString();
}

const SELECT = "SELECT * FROM social_posts";

async function loadRow(env: Env, id: string): Promise<SocialPostRow | null> {
  return env.DB.prepare("SELECT * FROM social_posts WHERE id = ?").bind(id).first<SocialPostRow>();
}

// ─── GET /api/social-posts ──────────────────────────────────────────────────

export async function handleSocialPostList(env: Env, url: URL): Promise<Response> {
  const status = url.searchParams.get("status");
  const type = url.searchParams.get("type");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const where: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    where.push("status = ?");
    binds.push(status);
  }
  if (type) {
    where.push("post_type = ?");
    binds.push(type);
  }
  if (from) {
    where.push("scheduled_date >= ?");
    binds.push(from);
  }
  if (to) {
    where.push("scheduled_date <= ?");
    binds.push(to);
  }

  const sql = `${SELECT}${where.length ? " WHERE " + where.join(" AND ") : ""}
     ORDER BY COALESCE(scheduled_date, created_at) DESC`;
  const rows = (await env.DB.prepare(sql).bind(...binds).all<SocialPostRow>()).results ?? [];
  return json({ as_of: new Date().toISOString(), total: rows.length, posts: rows.map(shapeSocialPost) });
}

// ─── GET /api/social-posts/queue ────────────────────────────────────────────

export async function handleSocialQueue(env: Env): Promise<Response> {
  const rows =
    (
      await env.DB.prepare(
        `${SELECT} WHERE status = 'pending_approval' ORDER BY COALESCE(scheduled_date, created_at) ASC`,
      ).all<SocialPostRow>()
    ).results ?? [];

  // Hydrate photo refs so the queue can render previews without N calls.
  const posts = [];
  for (const row of rows) {
    const shaped = shapeSocialPost(row);
    const photos = await resolvePhotoRefs(env, shaped.photo_ids);
    posts.push({ ...shaped, photos });
  }
  return json({ as_of: new Date().toISOString(), total: posts.length, posts });
}

// ─── GET /api/social-posts/:id ──────────────────────────────────────────────

export async function handleSocialPostGet(env: Env, id: string): Promise<Response> {
  const row = await loadRow(env, id);
  if (!row) return err(404, "not_found", "Post not found.");
  const shaped = shapeSocialPost(row);
  const photos = await resolvePhotoRefs(env, shaped.photo_ids);

  // Activity (audit trail) for the editor's history tab.
  const activity =
    (
      await env.DB.prepare(
        `SELECT id, user_email, action, details, created_at FROM audit_logs
          WHERE entity_type = 'social_post' AND entity_id = ?
          ORDER BY created_at DESC LIMIT 50`,
      )
        .bind(id)
        .all<Record<string, unknown>>()
    ).results ?? [];

  return json({ post: { ...shaped, photos }, activity });
}

// ─── POST /api/social-posts (manual create) ─────────────────────────────────

export async function handleSocialPostCreate(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  // A manually created post starts as a draft and may have an empty caption —
  // the owner writes or AI-generates it in the editor. Approval enforces a
  // non-empty caption (see approveOne), so an empty draft can never publish.
  const caption = str(body.caption) ?? "";

  const postType = (str(body.post_type) ?? "manual") as PostType;
  if (!POST_TYPE_SET.has(postType)) {
    return err(400, "bad_request", `post_type must be one of: ${POST_TYPES.join(", ")}`);
  }
  const platform = (str(body.platform) ?? "both") as Platform;
  if (!PLATFORM_SET.has(platform)) {
    return err(400, "bad_request", `platform must be one of: ${PLATFORMS.join(", ")}`);
  }
  const status = str(body.status) === "pending_approval" ? "pending_approval" : "draft";
  const hashtags = Array.isArray(body.hashtags)
    ? JSON.stringify(body.hashtags.map(String))
    : str(body.hashtags)
      ? JSON.stringify(parseJsonArray(str(body.hashtags)))
      : null;
  const photoIds = Array.isArray(body.photo_ids) ? JSON.stringify(body.photo_ids.map(String)) : null;

  const id = crypto.randomUUID();
  const scheduledDate = normalizeScheduledDate(body.scheduled_date);
  const insert = await env.DB.prepare(
    `INSERT INTO social_posts
       (id, post_type, status, caption, hashtags, platform, scheduled_date,
        job_id, photo_ids, generated_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', datetime('now'))`,
  )
    .bind(
      id,
      postType,
      status,
      caption,
      hashtags,
      platform,
      scheduledDate,
      str(body.job_id),
      photoIds,
    )
    .run();

  if (!insert.success) {
    console.error("[social-posts] create insert failed:", insert.error);
    return err(500, "insert_failed", insert.error ?? "Failed to create post.");
  }

  await logSocialAudit(env, user.email, "social_post_created", id, { post_type: postType, status });
  const row = await loadRow(env, id);
  return json({ post: shapeSocialPost(row as SocialPostRow) }, { status: 201 });
}

// ─── PUT /api/social-posts/:id ──────────────────────────────────────────────

export async function handleSocialPostUpdate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...WRITE_ROLES]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const row = await loadRow(env, id);
  if (!row) return err(404, "not_found", "Post not found.");
  if (row.status === "published") {
    return err(409, "already_published", "A published post cannot be edited.");
  }

  const body = await readJson(request);
  if (!body) return err(400, "bad_request", "Body must be JSON");

  const sets: string[] = [];
  const binds: unknown[] = [];
  if ("caption" in body) {
    const c = str(body.caption);
    if (!c) return err(400, "bad_request", "caption cannot be empty.");
    sets.push("caption = ?");
    binds.push(c);
  }
  if ("hashtags" in body) {
    const tags = Array.isArray(body.hashtags)
      ? body.hashtags.map(String)
      : parseJsonArray(str(body.hashtags));
    sets.push("hashtags = ?");
    binds.push(JSON.stringify(tags));
  }
  if ("scheduled_date" in body) {
    sets.push("scheduled_date = ?");
    binds.push(normalizeScheduledDate(body.scheduled_date));
  }
  if ("platform" in body) {
    const p = str(body.platform);
    if (!p || !PLATFORM_SET.has(p)) return err(400, "bad_request", "Invalid platform.");
    sets.push("platform = ?");
    binds.push(p);
  }
  if ("photo_ids" in body) {
    const ids = Array.isArray(body.photo_ids) ? body.photo_ids.map(String) : [];
    sets.push("photo_ids = ?");
    binds.push(JSON.stringify(ids));
  }
  if ("post_type" in body) {
    const t = str(body.post_type);
    if (!t || !POST_TYPE_SET.has(t)) return err(400, "bad_request", "Invalid post_type.");
    sets.push("post_type = ?");
    binds.push(t);
  }
  if (sets.length === 0) return err(400, "bad_request", "No editable fields provided.");

  binds.push(id);
  await env.DB.prepare(`UPDATE social_posts SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  await logSocialAudit(env, user.email, "social_post_updated", id, {
    fields: Object.keys(body).filter((k) =>
      ["caption", "hashtags", "scheduled_date", "platform", "photo_ids", "post_type"].includes(k),
    ),
  });
  return handleSocialPostGet(env, id);
}

// ─── POST /api/social-posts/:id/approve ─────────────────────────────────────

export async function handleSocialPostApprove(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const outcome = await approveOne(env, id, user.email);
  if (!outcome.ok) return err(outcome.status, outcome.error, outcome.details);
  return handleSocialPostGet(env, id);
}

// ─── POST /api/social-posts/approve-batch ───────────────────────────────────
// Batch approve: accepts { ids: [...] } and loops server-side (kept simple).

export async function handleSocialPostApproveBatch(request: Request, env: Env): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const body = await readJson(request);
  const ids = Array.isArray(body?.ids) ? body!.ids.map(String) : [];
  if (ids.length === 0) return err(400, "bad_request", "Provide a non-empty ids[] array.");

  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const pid of ids) {
    const r = await approveOne(env, pid, user.email);
    results.push({ id: pid, ok: r.ok, error: r.ok ? undefined : r.error });
  }
  const approved = results.filter((r) => r.ok).length;
  return json({ approved, total: ids.length, results });
}

type ApproveOutcome =
  | { ok: true }
  | { ok: false; status: number; error: string; details?: string };

async function approveOne(env: Env, id: string, actor: string): Promise<ApproveOutcome> {
  const row = await loadRow(env, id);
  if (!row) return { ok: false, status: 404, error: "not_found", details: "Post not found." };
  if (!(row.status === "pending_approval" || row.status === "draft" || row.status === "rejected")) {
    return {
      ok: false,
      status: 409,
      error: "invalid_state",
      details: `Cannot approve a post in '${row.status}'.`,
    };
  }
  if (!str(row.caption)) {
    return { ok: false, status: 400, error: "empty_caption", details: "Add a caption before approving." };
  }
  await env.DB.prepare(
    "UPDATE social_posts SET status = 'approved', approved_by = ?, approved_date = datetime('now'), rejection_reason = NULL WHERE id = ?",
  )
    .bind(actor, id)
    .run();
  await logSocialAudit(env, actor, "social_post_approved", id, { from: row.status });
  return { ok: true };
}

// ─── POST /api/social-posts/:id/reject ──────────────────────────────────────

export async function handleSocialPostReject(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const row = await loadRow(env, id);
  if (!row) return err(404, "not_found", "Post not found.");
  if (row.status === "published") return err(409, "already_published", "Cannot reject a published post.");

  const body = await readJson(request);
  const reason = str(body?.rejection_reason) ?? str(body?.reason);
  await env.DB.prepare("UPDATE social_posts SET status = 'rejected', rejection_reason = ? WHERE id = ?")
    .bind(reason, id)
    .run();
  await logSocialAudit(env, user.email, "social_post_rejected", id, { reason });
  return handleSocialPostGet(env, id);
}

// ─── DELETE /api/social-posts/:id ───────────────────────────────────────────

export async function handleSocialPostDelete(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const row = await loadRow(env, id);
  if (!row) return err(404, "not_found", "Post not found.");
  // Never hard-delete a published post (it represents a real, live post).
  if (row.status === "published") {
    return err(409, "already_published", "A published post cannot be deleted.");
  }
  await env.DB.prepare("DELETE FROM social_posts WHERE id = ?").bind(id).run();
  await logSocialAudit(env, user.email, "social_post_deleted", id, { post_type: row.post_type });
  return json({ ok: true, deleted: true, id });
}

// ─── POST /api/social-posts/:id/regenerate ──────────────────────────────────

export async function handleSocialPostRegenerate(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const row = await loadRow(env, id);
  if (!row) return err(404, "not_found", "Post not found.");
  if (row.status === "published") return err(409, "already_published", "Cannot regenerate a published post.");

  const body = await readJson(request);
  const hashtagsOnly = body?.hashtags_only === true;
  const alsoHashtags =
    hashtagsOnly || body?.hashtags === true || body?.regenerate_hashtags === true;

  const ctx = await buildContextForPost(env, row);

  let newCaption: string | null = null;
  if (!hashtagsOnly) {
    const captionRes = await generateCaptions(env, ctx);
    if (!captionRes.ok) {
      return json({
        ok: false,
        unavailable: true,
        message: "AI is unavailable right now — edit the caption manually.",
        error: captionRes.error,
      });
    }
    newCaption = captionRes.options[0] ?? null;
  }

  let hashtags: string[] | null = null;
  if (alsoHashtags) {
    const h = await generateHashtags(env, ctx, `${id}:${Date.now()}`, row.platform as Platform);
    hashtags = h.hashtags;
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (newCaption != null) {
    sets.push("caption = ?");
    binds.push(newCaption);
  }
  if (hashtags) {
    sets.push("hashtags = ?");
    binds.push(JSON.stringify(hashtags));
  }
  if (sets.length === 0) {
    return json({ ok: false, unavailable: true, message: "Nothing to regenerate." });
  }
  binds.push(id);
  await env.DB.prepare(`UPDATE social_posts SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  await logSocialAudit(env, user.email, "social_post_regenerated", id, {
    options: newCaption ? 1 : 0,
    hashtags: Boolean(hashtags),
    hashtags_only: hashtagsOnly,
  });

  return json({ ok: true, hashtags, applied: newCaption, hashtags_only: hashtagsOnly });
}

// ─── POST /api/social-posts/:id/generate-image ──────────────────────────────

export async function handleSocialPostGenerateImage(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const row = await loadRow(env, id);
  if (!row) return err(404, "not_found", "Post not found.");
  if (row.status === "published") return err(409, "already_published", "Cannot regenerate a published image.");

  if (!(await imageGenConfigured(env))) {
    // Gate: no key → labeled "configure image API" state; post still flows.
    return json({
      ok: false,
      unconfigured: true,
      message: "Image generation isn't configured — set Google Imagen credentials or attach a photo manually.",
    });
  }

  const ctx = await buildContextForPost(env, row);
  const variationIndex = row.image_variation_index ?? 0;

  await env.DB.prepare("UPDATE social_posts SET image_variation_index = ? WHERE id = ?")
    .bind(variationIndex + 1, id)
    .run();

  const prompt = await generateImageSubjectPrompt(env, ctx, variationIndex);

  const result = await generateAndStoreImage(env, id, prompt);
  if (!result.ok) {
    const message = result.unconfigured
      ? "Image generation isn't configured — set Google Imagen credentials or attach a photo manually."
      : result.error ?? "Image generation failed.";
    return json({ ok: false, unconfigured: result.unconfigured, error: result.error, message });
  }
  await logSocialAudit(env, user.email, "social_post_image_generated", id, {
    monthly_count: result.monthly_count,
  });
  return json({ ok: true, ai_generated_image_url: result.url, monthly_count: result.monthly_count });
}

// ─── GET /api/social-posts/:id/image ────────────────────────────────────────

export async function handleSocialImage(env: Env, id: string): Promise<Response> {
  const res = await streamSocialImage(env, id);
  if (!res) return err(404, "object_missing", "No generated image for this post.");
  return res;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Reconstruct a caption context from a stored post (for regenerate/image). */
async function buildContextForPost(env: Env, row: SocialPostRow): Promise<CaptionContext> {
  if (row.post_type === "job_completion" && row.job_id) {
    const job = await env.DB.prepare(
      "SELECT job_type, property_city, estimate_id FROM jobs WHERE id = ?",
    )
      .bind(row.job_id)
      .first<{ job_type: string | null; property_city: string | null; estimate_id: string | null }>();
    let scope: string | null = null;
    if (job?.estimate_id) {
      const { results } = await env.DB.prepare(
        "SELECT product_service FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order ASC LIMIT 6",
      )
        .bind(job.estimate_id)
        .all<{ product_service: string | null }>();
      const names = (results ?? []).map((i) => i.product_service).filter(Boolean) as string[];
      if (names.length) scope = names.join(", ");
    }
    return {
      kind: "job_completion",
      jobType: job?.job_type ?? null,
      scope,
      city: job?.property_city ?? null, // city only — never the street (rule #9)
      beforeDescription: null,
      afterDescription: null,
    };
  }

  // Non-job post: derive a topic from the existing caption's first line, fold a
  // rejection reason into the supporting detail so the new draft addresses it.
  const firstLine = (row.caption ?? "").split("\n")[0].slice(0, 120) || "home improvement tips";
  const kind =
    row.post_type === "seasonal_tips" ||
    row.post_type === "tips_tricks" ||
    row.post_type === "promotion" ||
    row.post_type === "review_highlight"
      ? row.post_type
      : "manual";
  return {
    kind,
    topic: firstLine,
    detail: row.rejection_reason
      ? `Previous draft was rejected for: ${row.rejection_reason}. Address that.`
      : null,
  };
}

/**
 * Social publish route (Sprint 16, Deliverable F) — manual "publish now".
 *
 *   POST /api/social-posts/:id/publish  (O) — publish an approved post now.
 *
 * The state machine, IG two-step, retry/backoff, idempotency, and the
 * SOCIAL_PUBLISH_MODE SIMULATE gate all live in src/lib/social-publish.ts.
 * The cron path (publishDuePosts) is folded into the existing 15-minute handler
 * in src/index.ts — no new cron trigger (5-cap full).
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { publishPost, resolvePublishMode } from "../lib/social-publish.js";
import { err, json } from "../lib/social.js";

const OWNER_ONLY = ["owner"] as const;

export async function handleSocialPostPublish(request: Request, env: Env, id: string): Promise<Response> {
  const guarded = await guard(request, env, [...OWNER_ONLY]);
  if (guarded instanceof Response) return guarded;
  const { user } = guarded;

  const post = await env.DB.prepare("SELECT id, status FROM social_posts WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!post) return err(404, "not_found", "Post not found.");
  if (post.status === "published") {
    return json({ ok: true, status: "published", reason: "already_published" });
  }
  if (!(post.status === "approved" || post.status === "failed")) {
    return err(409, "invalid_state", `Only an approved post can be published (got '${post.status}').`);
  }

  const mode = await resolvePublishMode(env);
  const result = await publishPost(env, id, user.email);
  return json({ ...result, mode }, { status: result.ok ? 200 : 202 });
}

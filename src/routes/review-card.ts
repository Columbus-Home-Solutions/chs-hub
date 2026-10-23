/**
 * POST /api/ops/review-card
 *
 * Secret-gated child request for review-card rasterizing. The GBP sync calls
 * this through the SELF binding so the PNG work has its own CPU budget.
 * Not a user-facing route. Gemini is not involved.
 */

import type { Env } from "../env.js";
import { attachReviewCard } from "../lib/review-card-render.js";

function forbidden(): Response {
  return new Response("Forbidden", { status: 403 });
}

export async function handleReviewCardRender(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") ?? request.headers.get("x-sync-token") ?? "";
  if (!env.SYNC_TRIGGER_SECRET || secret !== env.SYNC_TRIGGER_SECRET) return forbidden();

  let postId = "";
  try {
    const body = (await request.json()) as { post_id?: unknown };
    postId = typeof body.post_id === "string" ? body.post_id.trim() : "";
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (!postId) return new Response("Bad Request", { status: 400 });

  const result = await attachReviewCard(env, postId);
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 500,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

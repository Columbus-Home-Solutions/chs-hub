/**
 * Rasterize a review card to PNG and store it on the post.
 *
 * The 30-minute sync must not rasterize in-process. On Workers Free a 1080px
 * render blows the 10ms CPU cap, and that kill is not a catchable exception —
 * it would abort the rest of the tick. When the SELF service binding is
 * present, rendering is a separate request with its own CPU budget. A failure
 * there is an HTTP error the sync can record. Tests and local runs without
 * SELF render in-process, and a thrown error is caught.
 *
 * One attempt. The editor's Re-render review card action is the retry.
 * Gemini is never called from this file.
 */

import type { Env } from "../env.js";
import { socialImageKey } from "./image-gen.js";
import { putImage } from "./r2.js";
import {
  buildReviewCardSvg,
  loadableReviewText,
  measurerFromFonts,
  planReviewCard,
  type ReviewCardPlan,
  type TextMeasurer,
} from "./review-card.js";

export interface ReviewCardAssets {
  logo: Uint8Array;
  outfit: Uint8Array;
  dm: Uint8Array;
}

export interface ReviewCardAttachResult {
  ok: boolean;
  skipped: boolean;
  url: string | null;
  message: string;
}

interface PostImageRow {
  id: string;
  post_type: string;
  status: string;
  scheduled_date: string | null;
  ai_generated_image_url: string | null;
  engagement_data: string | null;
}

interface ReviewRow {
  id: string;
  reviewer_name: string;
  comment_text: string | null;
  star_rating: number;
}

let assetCache: Promise<ReviewCardAssets> | null = null;
let measurerCache: TextMeasurer | null = null;
let wasmReady: Promise<void> | null = null;

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function asBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

export function loadReviewCardAssets(): Promise<ReviewCardAssets> {
  if (!assetCache) {
    assetCache = loadReviewCardAssetsUncached().catch((err) => {
      assetCache = null;
      throw err;
    });
  }
  return assetCache;
}

async function loadReviewCardAssetsUncached(): Promise<ReviewCardAssets> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const root = process.cwd();
    const [logo, outfit, dm] = await Promise.all([
      readFile(resolve(root, "frontend/src/assets/chs-logo.png")),
      readFile(resolve(root, "src/assets/fonts/Outfit-Medium.ttf")),
      readFile(resolve(root, "src/assets/fonts/DMSans-Regular.ttf")),
    ]);
    return { logo, outfit, dm };
  } catch {
    const [logo, outfit, dm] = await Promise.all([
      import("../../frontend/src/assets/chs-logo.png"),
      import("../assets/fonts/Outfit-Medium.ttf"),
      import("../assets/fonts/DMSans-Regular.ttf"),
    ]);
    return {
      logo: asBytes(logo.default),
      outfit: asBytes(outfit.default),
      dm: asBytes(dm.default),
    };
  }
}

export async function reviewCardMeasurer(): Promise<TextMeasurer> {
  if (measurerCache) return measurerCache;
  const assets = await loadReviewCardAssets();
  measurerCache = measurerFromFonts(assets.dm, assets.outfit);
  return measurerCache;
}

function initReviewCardWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const { initWasm } = await import("@resvg/resvg-wasm");
      try {
        const { readFile } = await import("node:fs/promises");
        const { createRequire } = await import("node:module");
        const require = createRequire(`${process.cwd()}/package.json`);
        const wasmPath = require.resolve("@resvg/resvg-wasm/index_bg.wasm");
        await initWasm(await readFile(wasmPath));
      } catch {
        const wasm = await import("@resvg/resvg-wasm/index_bg.wasm");
        await initWasm(wasm.default);
      }
    })().catch((err) => {
      wasmReady = null;
      throw err;
    });
  }
  return wasmReady;
}

export async function renderReviewCardPng(plan: ReviewCardPlan, measure: TextMeasurer): Promise<Uint8Array> {
  const assets = await loadReviewCardAssets();
  const svg = buildReviewCardSvg(plan, assets.logo, measure);
  await initReviewCardWasm();
  const { Resvg } = await import("@resvg/resvg-wasm");
  const resvg = new Resvg(svg, {
    fitTo: { mode: "original" },
    font: {
      fontBuffers: [assets.dm, assets.outfit],
      defaultFontFamily: measure.bodyFamily,
      sansSerifFamily: measure.bodyFamily,
      loadSystemFonts: false,
    },
    shapeRendering: 2,
    textRendering: 2,
    imageRendering: 0,
  });
  const pending = (resvg.imagesToResolve() ?? []) as unknown[];
  for (const image of pending) {
    const href =
      typeof image === "string"
        ? image
        : String((image as { href?: string; url?: string }).href ?? (image as { url?: string }).url ?? "");
    const marker = "data:image/png;base64,";
    if (!href.startsWith(marker)) continue;
    const bytes = base64ToBytes(href.slice(marker.length));
    resvg.resolveImage(href, bytes);
  }
  const rendered = resvg.render();
  const png = rendered.asPng();
  rendered.free();
  resvg.free();
  return png;
}

function parseEngagement(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function loadPost(env: Env, postId: string): Promise<PostImageRow | null> {
  return env.DB.prepare(
    `SELECT id, post_type, status, scheduled_date, ai_generated_image_url, engagement_data
       FROM social_posts WHERE id = ?`,
  )
    .bind(postId)
    .first<PostImageRow>();
}

async function writeEngagement(
  env: Env,
  postId: string,
  patch: Record<string, unknown>,
  imageUrl?: string,
): Promise<void> {
  const row = await loadPost(env, postId);
  if (!row) return;
  const next = { ...parseEngagement(row.engagement_data), ...patch };
  if (imageUrl !== undefined) {
    await env.DB.prepare(
      "UPDATE social_posts SET ai_generated_image_url = ?, engagement_data = ? WHERE id = ?",
    )
      .bind(imageUrl, JSON.stringify(next), postId)
      .run();
    return;
  }
  await env.DB.prepare("UPDATE social_posts SET engagement_data = ? WHERE id = ?")
    .bind(JSON.stringify(next), postId)
    .run();
}

async function markMissing(env: Env, postId: string, reason: string): Promise<void> {
  try {
    const row = await loadPost(env, postId);
    if (!row || row.ai_generated_image_url) return;
    await writeEngagement(env, postId, {
      card_image: "missing",
      card_error: reason.slice(0, 180),
    });
  } catch (err) {
    console.error("[review-card] could not flag missing image:", (err as Error).message);
  }
}

/**
 * Render and attach one card. Never throws. Does not change status or scheduled_date.
 * Does not call Gemini.
 */
export async function attachReviewCard(env: Env, postId: string): Promise<ReviewCardAttachResult> {
  const kept = "The review card could not be rendered. The post was kept. Use Re-render review card to try again.";
  if (!env.FILES) {
    await markMissing(env, postId, "no_files_bucket");
    return { ok: false, skipped: false, url: null, message: kept };
  }

  const post = await loadPost(env, postId);
  if (!post) return { ok: false, skipped: false, url: null, message: "Post not found." };
  if (post.post_type !== "review_highlight") {
    return { ok: false, skipped: false, url: post.ai_generated_image_url, message: "Not a review highlight." };
  }

  const engagement = parseEngagement(post.engagement_data);
  const reviewId = typeof engagement.google_review_id === "string" ? engagement.google_review_id : "";
  const review = reviewId
    ? await env.DB.prepare(
        "SELECT id, reviewer_name, comment_text, star_rating FROM google_reviews WHERE id = ?",
      )
        .bind(reviewId)
        .first<ReviewRow>()
    : null;

  if (!review) {
    await markMissing(env, postId, "review_missing");
    return { ok: false, skipped: false, url: post.ai_generated_image_url, message: kept };
  }

  if (!loadableReviewText(review.comment_text)) {
    await writeEngagement(env, postId, { card_image: "skipped" });
    return {
      ok: true,
      skipped: true,
      url: null,
      message: "This review has a star rating and no written comment, so no card was rendered.",
    };
  }

  try {
    const measure = await reviewCardMeasurer();
    const plan = planReviewCard(
      {
        reviewerName: review.reviewer_name,
        commentText: review.comment_text,
        starRating: review.star_rating,
      },
      measure,
    );
    if (!plan) {
      await writeEngagement(env, postId, { card_image: "skipped" });
      return {
        ok: true,
        skipped: true,
        url: null,
        message: "This review has a star rating and no written comment, so no card was rendered.",
      };
    }
    const png = await renderReviewCardPng(plan, measure);
    const key = socialImageKey(postId);
    await putImage(env, key, png, "image/png");
    const url = `/api/social-posts/${postId}/image`;
    await writeEngagement(env, postId, { card_image: "ready", card_error: null }, url);
    return {
      ok: true,
      skipped: false,
      url,
      message: "Re-rendered the review card. The post status and scheduled time were not changed.",
    };
  } catch (err) {
    const reason = (err as Error).message || "render_failed";
    console.error("[review-card] render failed:", reason);
    await markMissing(env, postId, reason);
    return { ok: false, skipped: false, url: post.ai_generated_image_url, message: kept };
  }
}

/**
 * One render attempt. With SELF, the work runs in a child request so a CPU
 * limit there cannot take down the caller (the GBP sync). Without SELF, render
 * in-process and swallow the error.
 */
export async function scheduleReviewCard(env: Env, postId: string): Promise<void> {
  if (env.SELF && env.SYNC_TRIGGER_SECRET) {
    try {
      const res = await env.SELF.fetch("https://chs-hub.internal/api/ops/review-card", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sync-token": env.SYNC_TRIGGER_SECRET,
        },
        body: JSON.stringify({ post_id: postId }),
      });
      if (!res.ok) await markMissing(env, postId, `render_status_${res.status}`);
    } catch (err) {
      console.error("[review-card] child render failed:", (err as Error).message);
      await markMissing(env, postId, (err as Error).message || "child_render_failed");
    }
    return;
  }
  await attachReviewCard(env, postId);
}

/** Used by caption layout. Same words the card will draw. */
export async function planReviewCardForPost(input: {
  reviewerName: string;
  commentText: string | null;
  starRating: number;
}): Promise<ReviewCardPlan | null> {
  if (!loadableReviewText(input.commentText)) return null;
  const measure = await reviewCardMeasurer();
  return planReviewCard(input, measure);
}

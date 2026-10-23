/**
 * Branded review cards: exact customer words, short names, and a PNG
 * on the same image field other social posts already use.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { Env } from "../src/env.js";
import {
  INSTAGRAM_CAPTION_LIMIT,
  buildReviewCardSvg,
  captionExceedsInstagram,
  composedCaptionLength,
  measurerFromFonts,
  normalizeReviewText,
  planReviewCard,
  REVIEW_CARD_FONT_STEPS,
  reviewBodyFromSvg,
  reviewDisplayName,
  type TextMeasurer,
} from "../src/lib/review-card.js";
import { loadReviewCardAssets } from "../src/lib/review-card-render.js";
import { createReviewHighlightPost } from "../src/lib/social-review-post.js";
import { handleSocialPostGenerateImage } from "../src/routes/social-posts.js";
import { handleReviewCardRender } from "../src/routes/review-card.js";
import { publicImageUrl } from "../src/lib/social-publish.js";
import type { SocialPostRow } from "../src/lib/social.js";

const OSCAR =
  "Very good remolded my kitchen and loved how it turned out";
const GARY =
  "Tony Columbus came out, developed a design from our requests. Sent a reasonable quote. For the workman ship and quality of the final product, we paid more than a fair price. Our pool walk up, landing deck and pool ladder are of excellent quality.";
const SEAN =
  "I recently hired Tony for several projects around my property, including repairs around the house and improvements to our backyard pool area, and I couldn't be happier with the results. From the beginning, Tony was professional, responsive, and easy to work with. He took the time to listen to what we wanted, offered helpful suggestions, and communicated clearly throughout the entire process. It's refreshing to work with someone who takes pride in their craftsmanship and genuinely cares about customer satisfaction. The work completed around our pool area completely transformed the space. Everything was done with great attention to detail, creating a clean, polished, and functional outdoor area that our family can enjoy for years to come. The finished product exceeded our expectations and significantly improved both the appearance and usability of our backyard. In addition to the outdoor work, Tony handled several repairs and improvements around our home. Every project was completed efficiently and to a high standard. He showed up when he said he would, kept the work area organized, and treated our property with respect throughout the job. What stood out most was Tony's commitment to quality. He doesn't cut corners and takes the time to make sure the job is done right. His workmanship, professionalism, and reliability make him someone I would confidently recommend to friends, family, and anyone looking for a trustworthy contractor. If you're looking for someone who delivers excellent results, communicates well, and stands behind his work, Tony is the contractor to call. We will absolutely be using him again for future projects.";

class MemoryBucket {
  objects = new Map<string, Uint8Array>();
  puts = 0;
  fail = false;
  async put(key: string, body: ArrayBuffer | Uint8Array): Promise<void> {
    if (this.fail) throw new Error("r2 down");
    this.puts += 1;
    this.objects.set(key, body instanceof Uint8Array ? body : new Uint8Array(body));
  }
  async get(): Promise<null> {
    return null;
  }
}

let mf: Miniflare;
let env: Env;
let files: MemoryBucket;
let measure: TextMeasurer;
let originalFetch: typeof fetch;

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function filledStars(svg: string): number {
  return [...svg.matchAll(/data-fill="1"/g)].length;
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { async fetch() { return new Response(null, { status: 404 }); } }",
    d1Databases: { DB: "review-card" },
    d1Persist: false,
  });
  const bindings = await mf.getBindings<{ DB: Env["DB"] }>();
  files = new MemoryBucket();
  env = {
    DB: bindings.DB,
    FILES: files as unknown as Env["FILES"],
    ANTHROPIC_API_KEY: "",
    NOTIFICATIONS_DISPATCH_MODE: "simulate",
    APP_PUBLIC_ORIGIN: "https://client.homesolutionsar.com",
    SYNC_TRIGGER_SECRET: "test-secret",
  } as Env;
  await env.DB.prepare(
    `CREATE TABLE social_posts (
      id TEXT PRIMARY KEY,
      post_type TEXT NOT NULL,
      status TEXT NOT NULL,
      caption TEXT NOT NULL,
      hashtags TEXT,
      platform TEXT NOT NULL,
      scheduled_date TEXT,
      ai_generated_image_url TEXT,
      engagement_data TEXT,
      rejection_reason TEXT,
      generated_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE google_reviews (
      id TEXT PRIMARY KEY,
      reviewer_name TEXT,
      comment_text TEXT,
      star_rating INTEGER
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      user_email TEXT,
      action TEXT,
      entity_type TEXT,
      entity_id TEXT,
      details TEXT,
      created_at TEXT
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT,
      first_name TEXT,
      last_name TEXT,
      role TEXT,
      is_active INTEGER
    )`,
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, email, first_name, last_name, role, is_active) VALUES (?, ?, ?, ?, ?, 1)",
  )
    .bind("user-1", "tony@example.com", "Tony", "Columbus", "owner")
    .run();
  const assets = await loadReviewCardAssets();
  measure = measurerFromFonts(assets.dm, assets.outfit);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
}, 30000);

afterAll(() => {
  globalThis.fetch = originalFetch;
});

async function insertReview(id: string, name: string, stars: number, comment: string | null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO google_reviews (id, reviewer_name, comment_text, star_rating) VALUES (?, ?, ?, ?)",
  )
    .bind(id, name, comment, stars)
    .run();
}

describe("review display names", () => {
  it("uses first name and last initial, and leaves names that do not split", () => {
    expect(reviewDisplayName("Sean Murphy")).toBe("Sean M.");
    expect(reviewDisplayName("Oscar Linares")).toBe("Oscar L.");
    expect(reviewDisplayName("Brooke")).toBe("Brooke");
    expect(reviewDisplayName("Ron")).toBe("Ron");
    expect(reviewDisplayName("ABC Roofing LLC")).toBe("ABC Roofing LLC");
    expect(reviewDisplayName("Columbus Home Solutions")).toBe("Columbus Home Solutions");
    expect(reviewDisplayName("Sean Murphy Jr")).toBe("Sean Murphy Jr");
    expect(reviewDisplayName("Sean Murphy")).not.toContain("Murphy");
  });
});

describe("review card layout", () => {
  it("keeps short and medium real reviews whole, and steps the type down", () => {
    const oscar = planReviewCard(
      { reviewerName: "Oscar Linares", commentText: OSCAR, starRating: 5 },
      measure,
    );
    const gary = planReviewCard(
      { reviewerName: "Gary Jechorek", commentText: GARY, starRating: 5 },
      measure,
    );
    expect(oscar).not.toBeNull();
    expect(gary).not.toBeNull();
    expect(oscar!.truncated).toBe(false);
    expect(oscar!.cardText).toBe(normalizeReviewText(OSCAR));
    expect(gary!.truncated).toBe(false);
    expect(gary!.cardText).toBe(normalizeReviewText(GARY));
    expect(oscar!.fontSize).toBe(46);
    expect(gary!.fontSize).toBe(46);
    const medium = "home ".repeat(80).trim();
    const stepped = planReviewCard({ reviewerName: "Brooke", commentText: medium, starRating: 5 }, measure);
    expect(stepped!.truncated).toBe(false);
    expect(stepped!.fontSize).toBe(34);
    expect(oscar!.displayName).toBe("Oscar L.");
    expect(gary!.displayName).toBe("Gary J.");
  });

  it("truncates a long real review on a sentence boundary and keeps the full text for the caption", () => {
    const sean = planReviewCard(
      { reviewerName: "Sean Murphy", commentText: SEAN, starRating: 5 },
      measure,
    );
    expect(sean).not.toBeNull();
    expect(sean!.truncated).toBe(true);
    expect(sean!.fontSize).toBe(REVIEW_CARD_FONT_STEPS[REVIEW_CARD_FONT_STEPS.length - 1]);
    expect(sean!.cardText.endsWith("…")).toBe(true);
    const prefix = sean!.cardText.slice(0, -1);
    expect(sean!.fullText.startsWith(prefix)).toBe(true);
    expect(prefix.endsWith(".") || prefix.endsWith("!") || prefix.endsWith("?")).toBe(true);
    expect(sean!.cardText).not.toContain("Murphy");
    const caption = `${sean!.displayName} left a 5-star Google review.\n\n“${sean!.fullText}”`;
    expect(caption).toContain(sean!.fullText);
    expect(composedCaptionLength(caption, ["#HomeSolutionsAR", "#littlerock", "#littlerockarkansas", "#homerenovation", "#beforeandafter"])).toBeLessThanOrEqual(INSTAGRAM_CAPTION_LIMIT);
  });

  it("cuts a single over-long sentence on a whole word", () => {
    const words = Array.from({ length: 420 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    const plan = planReviewCard({ reviewerName: "Brooke", commentText: text, starRating: 5 }, measure);
    expect(plan!.truncated).toBe(true);
    expect(plan!.cardText.endsWith("…")).toBe(true);
    const prefix = plan!.cardText.slice(0, -1).trim();
    expect(text.startsWith(prefix)).toBe(true);
    expect(text.slice(prefix.length).startsWith(" ") || text.length === prefix.length).toBe(true);
    expect(prefix.endsWith("word")).toBe(false);
    const last = prefix.split(" ").at(-1)!;
    expect(words).toContain(last);
  });

  it("truncates after the last complete sentence that fits", () => {
    const first = "The crew showed up on time.";
    const rest = Array.from({ length: 420 }, (_, i) => `extra${i}`).join(" ");
    const plan = planReviewCard(
      { reviewerName: "Ron", commentText: `${first} ${rest}`, starRating: 4 },
      measure,
    );
    expect(plan!.cardText).toBe(`${first}…`);
    expect(plan!.starRating).toBe(4);
  });

  it("draws filled and outlined stars for 5, 4, and 3", async () => {
    const assets = await loadReviewCardAssets();
    mkdirSync("/tmp/chs-review-cards", { recursive: true });
    for (const [name, reviewer, stars, text] of [
      ["oscar", "Oscar Linares", 5, OSCAR],
      ["gary", "Gary Jechorek", 5, GARY],
      ["sean", "Sean Murphy", 5, SEAN],
      ["four", "Ron", 4, "Solid work and a fair price."],
      ["three", "Brooke", 3, "They finished the punch list."],
    ] as const) {
      const plan = planReviewCard({ reviewerName: reviewer, commentText: text, starRating: stars }, measure)!;
      if (name === "oscar") expect(plan.displayName).toBe("Oscar L.");
      if (name === "gary") expect(plan.displayName).toBe("Gary J.");
      if (name === "four" || name === "three") expect(plan.displayName).toBe(reviewer);
      const svg = buildReviewCardSvg(plan, assets.logo, measure);
      expect(filledStars(svg)).toBe(stars);
      expect(svg.match(/data-fill="0"/g)?.length ?? 0).toBe(5 - stars);
      expect(svg).toContain(">Google Review<");
      expect(svg).toContain('id="chs-logo"');
      expect(svg.match(/<image /g)?.length).toBe(1);
      expect(reviewBodyFromSvg(svg)).toBe(plan.cardText);
      if (name === "oscar" || name === "gary" || name === "sean") {
        const { renderReviewCardPng } = await import("../src/lib/review-card-render.js");
        const png = await renderReviewCardPng(plan, measure);
        expect(png[0]).toBe(0x89);
        expect(pngSize(png)).toEqual({ width: 1080, height: 1080 });
        writeFileSync(`/tmp/chs-review-cards/${name}.png`, png);
        console.log(
          `[review-card] ${name} font=${plan.fontSize} lines=${plan.lines.length} truncated=${plan.truncated} chars=${plan.cardText.length}/${plan.fullText.length}`,
        );
      }
    }
  }, 30000);

  it("does not plan a card for a rating with no text", () => {
    expect(planReviewCard({ reviewerName: "Sarosh Fazlani", commentText: null, starRating: 5 }, measure)).toBeNull();
    expect(planReviewCard({ reviewerName: "Sarosh Fazlani", commentText: "   \n", starRating: 5 }, measure)).toBeNull();
  });

  it("reports when the full review cannot fit in an Instagram caption", () => {
    const huge = "word ".repeat(600).trim();
    expect(huge.length).toBeGreaterThan(INSTAGRAM_CAPTION_LIMIT);
    const caption = `Mike T. left a 5-star Google review.\n\n“${huge}”`;
    expect(captionExceedsInstagram(caption, ["#HomeSolutionsAR"])).toBe(true);
    expect(caption.length).toBeLessThan(63206);
  });
});

describe("review highlight posts", () => {
  it("auto-drafts one card and does not render again for the same review", async () => {
    await insertReview("rev-oscar", "Oscar Linares", 5, OSCAR);
    const before = files.puts;
    const first = await createReviewHighlightPost(
      env,
      { id: "rev-oscar", reviewer_name: "Oscar Linares", comment_text: OSCAR, star_rating: 5 },
      "ai_schedule",
    );
    const second = await createReviewHighlightPost(
      env,
      { id: "rev-oscar", reviewer_name: "Oscar Linares", comment_text: OSCAR, star_rating: 5 },
      "ai_schedule",
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(files.puts).toBe(before + 1);
    const row = await env.DB.prepare(
      "SELECT status, caption, ai_generated_image_url, engagement_data FROM social_posts WHERE id = ?",
    )
      .bind(first.id)
      .first<{ status: string; caption: string; ai_generated_image_url: string; engagement_data: string }>();
    expect(row!.status).toBe("pending_approval");
    expect(row!.ai_generated_image_url).toBe(`/api/social-posts/${first.id}/image`);
    expect(row!.caption).not.toContain("Linares");
    expect(JSON.parse(row!.engagement_data).card_image).toBe("ready");
    const png = files.objects.get(`social-images/${first.id}.png`)!;
    expect(pngSize(png)).toEqual({ width: 1080, height: 1080 });
    const published = publicImageUrl(env, {
      id: first.id,
      ai_generated_image_url: row!.ai_generated_image_url,
      photo_ids: null,
    } as SocialPostRow);
    expect(published).toBe(`https://client.homesolutionsar.com/api/public/social-posts/${first.id}/image`);
  }, 30000);

  it("keeps a rating-only review as a post with no card", async () => {
    await insertReview("rev-stars", "Sarosh Fazlani", 5, null);
    const before = files.puts;
    const created = await createReviewHighlightPost(
      env,
      { id: "rev-stars", reviewer_name: "Sarosh Fazlani", comment_text: null, star_rating: 5 },
      "ai_schedule",
    );
    expect(created.created).toBe(true);
    expect(files.puts).toBe(before);
    const row = await env.DB.prepare(
      "SELECT ai_generated_image_url, engagement_data, caption FROM social_posts WHERE id = ?",
    )
      .bind(created.id)
      .first<{ ai_generated_image_url: string | null; engagement_data: string; caption: string }>();
    expect(row!.ai_generated_image_url).toBeNull();
    expect(JSON.parse(row!.engagement_data).card_image).toBe("skipped");
    expect(row!.caption.length).toBeGreaterThan(0);
  });

  it("still creates the post when the card render fails, and flags the image missing", async () => {
    await insertReview("rev-fail", "Nancee Roberson", 5, "Great price and cleaned up the project.");
    files.fail = true;
    try {
      const created = await createReviewHighlightPost(
        env,
        {
          id: "rev-fail",
          reviewer_name: "Nancee Roberson",
          comment_text: "Great price and cleaned up the project.",
          star_rating: 5,
        },
        "ai_schedule",
      );
      expect(created.created).toBe(true);
      const row = await env.DB.prepare(
        "SELECT status, ai_generated_image_url, engagement_data FROM social_posts WHERE id = ?",
      )
        .bind(created.id)
        .first<{ status: string; ai_generated_image_url: string | null; engagement_data: string }>();
      expect(row!.status).toBe("pending_approval");
      expect(row!.ai_generated_image_url).toBeNull();
      expect(JSON.parse(row!.engagement_data).card_image).toBe("missing");
    } finally {
      files.fail = false;
    }
  });

  it("re-renders an approved or scheduled review card without changing status or time", async () => {
    await insertReview("rev-edit", "Haley Killion", 5, "Tony completely redid our deck from start to finish.");
    const when = "2026-11-02T15:00:00.000Z";
    for (const status of ["approved", "scheduled"] as const) {
      const id = `post-${status}`;
      await env.DB.prepare(
        `INSERT INTO social_posts
           (id, post_type, status, caption, hashtags, platform, scheduled_date, engagement_data, generated_by, created_at)
         VALUES (?, 'review_highlight', ?, 'Thanks Haley.', '[]', 'both', ?, ?, 'manual', datetime('now'))`,
      )
        .bind(id, status, when, JSON.stringify({ google_review_id: "rev-edit" }))
        .run();
      const request = new Request("https://dashboard.example/api/social-posts/" + id + "/generate-image", {
        method: "POST",
        headers: { "Cf-Access-Authenticated-User-Email": "tony@example.com" },
      });
      const res = await handleSocialPostGenerateImage(request, env, id);
      const body = (await res.json()) as { ok: boolean; message?: string };
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.message).toContain("Re-rendered the review card");
      expect(body.message).toContain("not changed");
      const row = await env.DB.prepare(
        "SELECT status, scheduled_date, ai_generated_image_url FROM social_posts WHERE id = ?",
      )
        .bind(id)
        .first<{ status: string; scheduled_date: string; ai_generated_image_url: string }>();
      expect(row!.status).toBe(status);
      expect(row!.scheduled_date).toBe(when);
      expect(row!.ai_generated_image_url).toBe(`/api/social-posts/${id}/image`);
    }
  }, 30000);

  it("leaves Gemini behavior in place for a non-review post", async () => {
    await env.DB.prepare(
      `INSERT INTO social_posts
         (id, post_type, status, caption, hashtags, platform, scheduled_date, engagement_data, generated_by, created_at)
       VALUES ('post-tip', 'tips_tricks', 'pending_approval', 'Seal the attic.', '[]', 'both', NULL, NULL, 'manual', datetime('now'))`,
    ).run();
    const before = files.puts;
    const request = new Request("https://dashboard.example/api/social-posts/post-tip/generate-image", {
      method: "POST",
      headers: { "Cf-Access-Authenticated-User-Email": "tony@example.com" },
    });
    const res = await handleSocialPostGenerateImage(request, env, "post-tip");
    const body = (await res.json()) as { ok: boolean; unconfigured?: boolean; message?: string };
    expect(body.ok).toBe(false);
    expect(body.unconfigured).toBe(true);
    expect(body.message).toContain("Vertex");
    expect(files.puts).toBe(before);
    const row = await env.DB.prepare("SELECT ai_generated_image_url, status FROM social_posts WHERE id = ?")
      .bind("post-tip")
      .first<{ ai_generated_image_url: string | null; status: string }>();
    expect(row!.ai_generated_image_url).toBeNull();
    expect(row!.status).toBe("pending_approval");
  });

  it("refuses to regenerate a published review image", async () => {
    await env.DB.prepare(
      `INSERT INTO social_posts
         (id, post_type, status, caption, hashtags, platform, scheduled_date, engagement_data, generated_by, created_at)
       VALUES ('post-live', 'review_highlight', 'published', 'Live.', '[]', 'both', NULL, '{}', 'manual', datetime('now'))`,
    ).run();
    const request = new Request("https://dashboard.example/api/social-posts/post-live/generate-image", {
      method: "POST",
      headers: { "Cf-Access-Authenticated-User-Email": "tony@example.com" },
    });
    const res = await handleSocialPostGenerateImage(request, env, "post-live");
    expect(res.status).toBe(409);
  });

  it("rejects an internal render call without the sync secret", async () => {
    const res = await handleReviewCardRender(
      new Request("https://chs-hub.internal/api/ops/review-card", {
        method: "POST",
        body: JSON.stringify({ post_id: "nope" }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });
});

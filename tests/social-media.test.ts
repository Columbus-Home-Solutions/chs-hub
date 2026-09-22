import { describe, it, expect } from "vitest";
import {
  buildCaptionSystemPrompt,
  buildCaptionUserPrompt,
  buildHashtagPrompt,
  parseCaptions,
  parseGeneratedCopy,
  parseHashtags,
  parseHashtagsForPlatform,
  buildImagePrompt,
  fallbackHashtags,
  assembleHashtags,
  locationHashtags,
  captionWithHeadline,
} from "../src/lib/social-ai";
import { shouldRegenerateOnReject } from "../src/routes/social-posts";
import { createReviewHighlightPost, shouldAutoDraftReview } from "../src/lib/social-review-post";
import { postTypeUsesAiImage } from "../src/lib/social-image-attach";
import type { Env } from "../src/env";
import { DEFAULT_BRAND_VOICE } from "../src/lib/social";
import { planSchedule, seasonForMonth } from "../src/lib/content-schedule";
import {
  normalizePublishMode,
  platformTargets,
  canAttemptPublish,
  nextBackoffMs,
  decidePublishOutcome,
  composePublishText,
  pickHashtagsForPlatform,
  buildFacebookPhotoRequest,
  buildInstagramContainerRequest,
  buildInstagramPublishRequest,
  buildInstagramMediaLookupUrl,
  buildFacebookPageFeedUrl,
  parseInstagramMediaLookup,
  matchFacebookFeedPostByTimestamp,
  FB_CROSSPOST_TIMESTAMP_WINDOW_MS,
  simulatedFacebook,
  simulatedInstagram,
  simulatedInstagramPublish,
  parseInstagramPublishResponse,
  DEFAULT_IG_BUSINESS_ACCOUNT_ID,
  publicImageUrl,
  publicPublishOrigin,
  isScheduledDateDue,
  scheduledDateForCompare,
  MAX_PUBLISH_ATTEMPTS,
  type PlatformOutcome,
} from "../src/lib/social-publish";
import type { SocialPostRow } from "../src/lib/social.js";

// ─── Deliverable B: caption + hashtag generation ──────────────────────────────

describe("social-ai caption generation (Sprint 16)", () => {
  it("never leaks a street address — city/neighborhood only (business rule #9)", () => {
    const sys = buildCaptionSystemPrompt(DEFAULT_BRAND_VOICE);
    expect(sys).toContain("NEVER include a client's street address");

    const userPrompt = buildCaptionUserPrompt({
      kind: "job_completion",
      jobType: "Garage Conversion",
      scope: "framing, drywall, electrical",
      city: "North Little Rock",
      beforeDescription: "bare garage",
      afterDescription: "finished living space",
    });
    // The context shape can only carry a city — assert no street pattern leaks.
    expect(userPrompt).toContain("North Little Rock");
    expect(userPrompt).not.toMatch(/\d{2,5}\s+\w+\s+(St|Street|Ave|Avenue|Rd|Road|Ln|Lane|Dr|Drive)/i);
  });

  it("parses 2–3 caption options from a JSON reply", () => {
    const text = '```json\n{"captions": ["Option one here.", "Option two here.", "Option three."]}\n```';
    const opts = parseCaptions(text);
    expect(opts.length).toBe(3);
    expect(opts[0]).toBe("Option one here.");
  });

  it("repairs a missing quote on a trade tag instead of storing the raw JSON", () => {
    const text =
      '{"captions":["Hello from the crew."],"headline":"Five stars","trade_tags":["#generalcontractor", #homerenovation"]}';
    const parsed = parseGeneratedCopy(text);
    expect(parsed.captions[0]).toBe("Hello from the crew.");
    expect(parsed.headline).toBe("Five stars");
    expect(parsed.tradeTags).toEqual(["#generalcontractor", "#homerenovation"]);
  });

  it("falls back to line-splitting when JSON is absent", () => {
    const text =
      "Here is a great caption about your new kitchen remodel project.\n\nAnother distinct caption option for the same project here.";
    const opts = parseCaptions(text);
    expect(opts.length).toBeGreaterThanOrEqual(1);
  });

  it("hashtag prompt asks for exactly two trade tags and not the brand tag", () => {
    const p = buildHashtagPrompt({ kind: "tips_tricks", topic: "budgeting a remodel" });
    expect(p).toContain("exactly 2");
    expect(p).toContain("#homerenovation");
    expect(p).not.toContain("#HomeSolutionsAR");
  });

  it("parseHashtagsForPlatform keeps only vetted trade tags", () => {
    const text = '{"trade_tags":["#homerenovation","#homeimprovement","#contractorlife"]}';
    const tags = parseHashtagsForPlatform(text, "both");
    expect(tags).toEqual(["#homerenovation", "#contractorlife"]);
  });

  it("assembleHashtags is exactly 5, with Sherwood mapped to north little rock", () => {
    const seasonal = assembleHashtags(null, ["#homerenovation", "#beforeandafter"], "seed-a");
    expect(seasonal).toEqual([
      "#HomeSolutionsAR",
      "#littlerock",
      "#littlerockarkansas",
      "#homerenovation",
      "#beforeandafter",
    ]);
    expect(locationHashtags("Sherwood")).toEqual(["#littlerock", "#northlittlerock"]);
    expect(locationHashtags("Jacksonville, AR")).toEqual(["#littlerock", "#northlittlerock"]);
    expect(locationHashtags("North Little Rock")).toEqual(["#littlerock", "#northlittlerock"]);
    expect(locationHashtags("Little Rock")).toEqual(["#littlerock", "#littlerockarkansas"]);
    const job = assembleHashtags("Sherwood", ["#generalcontractor", "#arkansas"], "job-1");
    expect(job.slice(0, 4)).toEqual([
      "#HomeSolutionsAR",
      "#littlerock",
      "#northlittlerock",
      "#generalcontractor",
    ]);
    expect(job).toHaveLength(5);
    expect(job).not.toContain("#sherwood");
    expect(job).not.toContain("#arkansas");
  });

  it("reject regenerates job and seasonal posts, and clears a review highlight", () => {
    expect(shouldRegenerateOnReject("job_completion")).toBe(true);
    expect(shouldRegenerateOnReject("seasonal_tips")).toBe(true);
    expect(shouldRegenerateOnReject("tips_tricks")).toBe(true);
    expect(shouldRegenerateOnReject("promotion")).toBe(true);
    expect(shouldRegenerateOnReject("review_highlight")).toBe(false);
    expect(shouldRegenerateOnReject("manual")).toBe(false);
  });

  it("only seasonal, tips, and promotion posts get an AI image", () => {
    expect(postTypeUsesAiImage("seasonal_tips")).toBe(true);
    expect(postTypeUsesAiImage("tips_tricks")).toBe(true);
    expect(postTypeUsesAiImage("promotion")).toBe(true);
    expect(postTypeUsesAiImage("job_completion")).toBe(false);
    expect(postTypeUsesAiImage("review_highlight")).toBe(false);
  });

  it("a 5-star review auto-drafts one pending review-highlight post", async () => {
    expect(shouldAutoDraftReview(5)).toBe(true);
    expect(shouldAutoDraftReview(4)).toBe(false);
    const posts: { id: string; hashtags: string; generatedBy: string; engagement: string }[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes("social_posts")) {
                  const needle = String(args[0]).replace(/%/g, "");
                  const hit = posts.find((p) => p.engagement.includes(needle));
                  return hit ? { id: hit.id } : null;
                }
                return null;
              },
              async run() {
                if (sql.includes("INSERT INTO social_posts")) {
                  posts.push({
                    id: String(args[0]),
                    hashtags: String(args[2]),
                    engagement: String(args[3]),
                    generatedBy: String(args[4]),
                  });
                }
              },
            };
          },
        };
      },
    };
    const env = { DB: db, ANTHROPIC_API_KEY: "" } as unknown as Env;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    const review = {
      id: "rev-5-star",
      reviewer_name: "Ada Homeowner",
      comment_text: "They rebuilt our kitchen and left the place cleaner than they found it.",
      star_rating: 5,
    };
    try {
      const first = await createReviewHighlightPost(env, review, "ai_schedule");
      const second = await createReviewHighlightPost(env, review, "ai_schedule");
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.generatedBy).toBe("ai_schedule");
      const tags = JSON.parse(posts[0]!.hashtags) as string[];
      expect(tags).toHaveLength(5);
      expect(tags[0]).toBe("#HomeSolutionsAR");
      expect(tags.slice(1, 3)).toEqual(["#littlerock", "#littlerockarkansas"]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("caption headline is a short first line, not a second copy of the body", () => {
    expect(captionWithHeadline("Beat the heat", "Seal the attic before August.")).toBe(
      "Beat the heat\n\nSeal the attic before August.",
    );
  });

  it("image prompt includes subject angle by variation index", () => {
    const a = buildImagePrompt({ kind: "manual", topic: "deck staining" }, 0);
    const b = buildImagePrompt({ kind: "manual", topic: "deck staining" }, 1);
    expect(a).not.toBe(b);
    expect(a).toContain("homeowner");
  });

  it("parses hashtags and normalizes a missing leading #", () => {
    const tags = parseHashtags('{"hashtags": ["LittleRock", "#HomeRemodel", "#ContractorLife"]}');
    expect(tags).toContain("#LittleRock");
    expect(tags).toContain("#HomeRemodel");
  });

  it("fallback hashtags are exactly 5 vetted tags and vary the trade pair by seed", () => {
    const a = fallbackHashtags("post-a", "Sherwood");
    const b = fallbackHashtags("post-b", "Little Rock");
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
    expect(a[0]).toBe("#HomeSolutionsAR");
    expect(a.slice(1, 3)).toEqual(["#littlerock", "#northlittlerock"]);
    expect(b.slice(1, 3)).toEqual(["#littlerock", "#littlerockarkansas"]);
    expect(a.every((t) => t.startsWith("#"))).toBe(true);
    expect(new Set(a).size).toBe(a.length);
  });
});

// ─── Deliverable C: monthly schedule generator ────────────────────────────────

describe("content-schedule planner (Sprint 16)", () => {
  it("maps months to seasons", () => {
    expect(seasonForMonth(1)).toBe("winter");
    expect(seasonForMonth(4)).toBe("spring");
    expect(seasonForMonth(7)).toBe("summer");
    expect(seasonForMonth(10)).toBe("fall");
  });

  it("aligns job-completion posts to completing jobs WITH social-ready photos; skips the rest", () => {
    const plan = planSchedule({
      month: 6,
      year: 2026,
      jobs: [
        { id: "job-1", jobType: "Kitchen", completionDate: "2026-06-05", hasSocialReady: true },
        { id: "job-2", jobType: "Bath", completionDate: "2026-06-20", hasSocialReady: true },
        { id: "job-3", jobType: "Deck", completionDate: "2026-06-12", hasSocialReady: false },
      ],
    });
    const jobPosts = plan.posts.filter((p) => p.post_type === "job_completion");
    expect(jobPosts.map((p) => p.job_id).sort()).toEqual(["job-1", "job-2"]);
    expect(plan.skippedJobs).toEqual(["job-3"]);
    // Job-completion posts sit on the job's real completion date.
    expect(jobPosts.find((p) => p.job_id === "job-1")!.scheduled_date.startsWith("2026-06-05")).toBe(true);
  });

  it("produces a balanced batch: ~3–4 posts/week, no week is all job-completions", () => {
    const plan = planSchedule({
      month: 6,
      year: 2026,
      jobs: [
        { id: "job-1", jobType: "Kitchen", completionDate: "2026-06-02", hasSocialReady: true },
        { id: "job-2", jobType: "Bath", completionDate: "2026-06-03", hasSocialReady: true },
      ],
    });
    // Bucket posts by week-of-month.
    const byWeek = new Map<number, typeof plan.posts>();
    for (const p of plan.posts) {
      const day = Number(p.scheduled_date.slice(8, 10));
      const w = Math.floor((day - 1) / 7);
      byWeek.set(w, [...(byWeek.get(w) ?? []), p]);
    }
    for (const [, posts] of byWeek) {
      expect(posts.length).toBeLessThanOrEqual(4);
      // If a week has >1 post, it must not be exclusively job-completions when
      // non-job content exists in the plan.
      if (posts.length > 1) {
        const allJob = posts.every((p) => p.post_type === "job_completion");
        expect(allJob).toBe(false);
      }
    }
    // Has seasonal + tips spread in.
    expect(plan.posts.some((p) => p.post_type === "seasonal_tips")).toBe(true);
    expect(plan.posts.some((p) => p.post_type === "tips_tricks")).toBe(true);
    // All dates land in the target month.
    expect(plan.posts.every((p) => p.scheduled_date.startsWith("2026-06"))).toBe(true);
  });

  it("seasonal posts carry the month's season; non-job posts are flagged for image gen", () => {
    const plan = planSchedule({ month: 1, year: 2026, jobs: [] });
    const seasonal = plan.posts.filter((p) => p.post_type === "seasonal_tips");
    expect(seasonal.length).toBeGreaterThanOrEqual(2);
    expect(seasonal.every((p) => p.season === "winter")).toBe(true);
    expect(seasonal.every((p) => p.wants_image)).toBe(true);
  });
});

// ─── Deliverable F: publishing state machine (SIMULATE) ───────────────────────

describe("social-publish state machine (Sprint 16)", () => {
  it("only the exact value 'live' goes live; everything else simulates", () => {
    expect(normalizePublishMode("live")).toBe("live");
    expect(normalizePublishMode("LIVE")).toBe("live");
    expect(normalizePublishMode("simulate")).toBe("simulate");
    expect(normalizePublishMode("")).toBe("simulate");
    expect(normalizePublishMode(undefined)).toBe("simulate");
    expect(normalizePublishMode("yes")).toBe("simulate");
  });

  it("branches platform targets", () => {
    expect(platformTargets("both")).toEqual({ facebook: true, instagram: true });
    expect(platformTargets("facebook_only")).toEqual({ facebook: true, instagram: false });
    expect(platformTargets("instagram_only")).toEqual({ facebook: false, instagram: true });
  });

  it("a published post is terminal (never re-attempted)", () => {
    expect(canAttemptPublish("approved")).toBe(true);
    expect(canAttemptPublish("failed")).toBe(true);
    expect(canAttemptPublish("published")).toBe(false);
    expect(canAttemptPublish("pending_approval")).toBe(false);
  });

  it("uses exponential backoff 1m / 5m / 30m", () => {
    expect(nextBackoffMs(0)).toBe(60_000);
    expect(nextBackoffMs(1)).toBe(5 * 60_000);
    expect(nextBackoffMs(2)).toBe(30 * 60_000);
    expect(nextBackoffMs(9)).toBe(30 * 60_000);
  });

  it("full success → published; partial/failure → retry; 3rd failure → failed", () => {
    const ok: PlatformOutcome[] = [
      { platform: "facebook", ok: true, postId: "x" },
      { platform: "instagram", ok: true, postId: "y" },
    ];
    expect(decidePublishOutcome(ok, 0).finalStatus).toBe("published");

    const partial: PlatformOutcome[] = [
      { platform: "facebook", ok: true, postId: "x" },
      { platform: "instagram", ok: false, error: "boom" },
    ];
    const d1 = decidePublishOutcome(partial, 0);
    expect(d1.finalStatus).toBe("approved");
    expect(d1.dlqStatus).toBe("pending");
    expect(d1.nextRetryAt).toBeTruthy();

    // After 2 prior retries, the 3rd attempt failing exhausts → failed.
    const d3 = decidePublishOutcome(partial, MAX_PUBLISH_ATTEMPTS - 1);
    expect(d3.finalStatus).toBe("failed");
    expect(d3.exhausted).toBe(true);
    expect(d3.dlqStatus).toBe("dismissed");
  });

  it("simulated ids carry synthetic FB/IG markers + urls", () => {
    const fb = simulatedFacebook("abcdef1234");
    expect(fb.ok).toBe(true);
    expect(fb.postId).toMatch(/^SIMFB-/);
    expect(fb.url).toContain("facebook.com");
    const ig = simulatedInstagram("abcdef1234");
    expect(ig.postId).toMatch(/^SIMIG-/);
    expect(ig.url).toContain("instagram.com");
    const cross = simulatedInstagramPublish("abcdef1234", true);
    expect(cross.instagramPostId).toMatch(/^SIMIG-/);
    expect(cross.facebookPostId).toMatch(/^SIMFB-/);
    expect(simulatedInstagramPublish("abcdef1234", false).facebookPostId).toBeUndefined();
  });

  it("parseInstagramPublishResponse extracts IG and FB ids from Graph payloads", () => {
    expect(
      parseInstagramPublishResponse({ id: "1789", facebook_post_id: "101_202" }),
    ).toEqual({ instagramPostId: "1789", facebookPostId: "101_202" });
    expect(
      parseInstagramPublishResponse({ crossposted_facebook_post_id: "101_303" }),
    ).toEqual({ instagramPostId: null, facebookPostId: "101_303" });
  });

  it("matches facebook feed posts to instagram publish time within 60s", () => {
    const igTs = Date.parse("2026-06-05T18:00:00.000Z");
    const feed = [
      { id: "old", created_time: "2026-06-05T17:00:00+0000" },
      { id: "match", created_time: "2026-06-05T18:00:30+0000", permalink_url: "https://fb.com/match" },
      { id: "far", created_time: "2026-06-05T18:02:00+0000" },
    ];
    expect(matchFacebookFeedPostByTimestamp(igTs, feed)).toEqual({
      postId: "match",
      url: "https://fb.com/match",
    });
    expect(matchFacebookFeedPostByTimestamp(igTs, feed, 10_000)).toBeNull();
    expect(FB_CROSSPOST_TIMESTAMP_WINDOW_MS).toBe(60_000);
  });

  it("parseInstagramMediaLookup reads timestamp and shared-to-feed flag", () => {
    expect(
      parseInstagramMediaLookup({
        id: "1789",
        timestamp: "2026-06-05T18:00:00+0000",
        permalink: "https://instagram.com/p/abc",
        is_shared_to_feed: true,
      }),
    ).toMatchObject({
      id: "1789",
      permalink: "https://instagram.com/p/abc",
      isSharedToFeed: true,
    });
    expect(parseInstagramMediaLookup({ id: "1789", timestamp: "2026-06-05T18:00:00+0000" }).timestampMs).toBe(
      Date.parse("2026-06-05T18:00:00+0000"),
    );
  });

  it("instagram-only success publishes even when facebook cross-post id is absent", () => {
    const outcomes: PlatformOutcome[] = [
      { platform: "instagram", ok: true, postId: "1789" },
    ];
    expect(decidePublishOutcome(outcomes, 0).finalStatus).toBe("published");
    expect(decidePublishOutcome([], 2).finalStatus).toBe("published");
  });

  it("composes caption + hashtags into the publish text", () => {
    expect(composePublishText("Hello", ["#A", "#B"])).toBe("Hello\n\n#A #B");
    expect(composePublishText("Hello", [])).toBe("Hello");
  });

  it("compares legacy sqlite datetime vs ISO scheduled_date reliably", () => {
    const now = "2026-06-05T23:00:00.000Z";
    expect(isScheduledDateDue("2026-06-05 22:35:40", now)).toBe(true);
    expect(isScheduledDateDue("2026-06-05T22:35:40.000Z", now)).toBe(true);
    expect(isScheduledDateDue("2026-06-06 08:00:00", now)).toBe(false);
    expect(scheduledDateForCompare("2026-06-05 22:35:40")).toBe("2026-06-05T22:35:40Z");
  });

  it("pickHashtagsForPlatform caps facebook and instagram at 5", () => {
    const tags = Array.from({ length: 20 }, (_, i) => `#Tag${i}`);
    expect(pickHashtagsForPlatform(tags, "facebook").length).toBe(5);
    expect(pickHashtagsForPlatform(tags, "instagram").length).toBe(5);
  });

  it("builds the documented Graph request shapes (IG two-step + FB cross-post flag)", () => {
    const fb = buildFacebookPhotoRequest({
      pageId: "PAGE",
      accessToken: "TOK",
      imageUrl: "https://x/img.jpg",
      caption: "hi",
    });
    expect(fb.url).toContain("/PAGE/photos");
    expect(fb.body).toMatchObject({ url: "https://x/img.jpg", caption: "hi", access_token: "TOK" });

    const c = buildInstagramContainerRequest({
      igAccountId: "IG",
      accessToken: "TOK",
      imageUrl: "https://x/img.jpg",
      caption: "hi",
      alsoShareToFacebook: true,
      facebookPageId: "PAGE123",
    });
    expect(c.url).toBe("https://graph.instagram.com/v25.0/IG/media");
    expect(c.body).toMatchObject({
      image_url: "https://x/img.jpg",
      also_share_to_facebook: true,
      page_id: "PAGE123",
    });
    expect(DEFAULT_IG_BUSINESS_ACCOUNT_ID).toBe("17841451185371306");

    const p = buildInstagramPublishRequest({ igAccountId: "IG", accessToken: "TOK", creationId: "CID" });
    expect(p.url).toBe("https://graph.instagram.com/v25.0/IG/media_publish");
    expect(p.body).toMatchObject({ creation_id: "CID" });

    const lookup = buildInstagramMediaLookupUrl({ instagramPostId: "MEDIA123", accessToken: "TOK" });
    expect(lookup).toBe(
      "https://graph.instagram.com/v25.0/MEDIA123?fields=id%2Ctimestamp%2Cpermalink%2Cis_shared_to_feed&access_token=TOK",
    );

    const feed = buildFacebookPageFeedUrl({ pageId: "PAGE123", accessToken: "PTOK", limit: 5 });
    expect(feed).toBe(
      "https://graph.facebook.com/v25.0/PAGE123/feed?access_token=PTOK&limit=5&fields=id%2Ccreated_time%2Cpermalink_url",
    );
  });

  it("publicImageUrl uses client host + /api/public paths for Graph fetches", () => {
    const env = { APP_PUBLIC_ORIGIN: "https://client.homesolutionsar.com" } as import("../src/env.js").Env;
    expect(publicPublishOrigin(env)).toBe("https://client.homesolutionsar.com");
    const post = {
      id: "post-1",
      ai_generated_image_url: "/api/social-posts/post-1/image",
      photo_ids: '["ph-1","ph-2"]',
    } as SocialPostRow;
    expect(publicImageUrl(env, post)).toBe(
      "https://client.homesolutionsar.com/api/public/social-posts/post-1/image",
    );
    const photoPost = { id: "p2", ai_generated_image_url: null, photo_ids: '["ph-9"]' } as SocialPostRow;
    expect(publicImageUrl(env, photoPost)).toBe(
      "https://client.homesolutionsar.com/api/public/social/photos/ph-9",
    );
  });
});

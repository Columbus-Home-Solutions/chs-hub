import { describe, it, expect } from "vitest";
import {
  buildCaptionSystemPrompt,
  buildCaptionUserPrompt,
  buildHashtagPrompt,
  parseCaptions,
  parseHashtags,
  parseHashtagsForPlatform,
  buildImagePrompt,
  fallbackHashtags,
} from "../src/lib/social-ai";
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
  simulatedFacebook,
  simulatedInstagram,
  publicImageUrl,
  publicPublishOrigin,
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

  it("falls back to line-splitting when JSON is absent", () => {
    const text =
      "Here is a great caption about your new kitchen remodel project.\n\nAnother distinct caption option for the same project here.";
    const opts = parseCaptions(text);
    expect(opts.length).toBeGreaterThanOrEqual(1);
  });

  it("hashtag prompt without pool instructs variety + mix of local/trade/general", () => {
    const p = buildHashtagPrompt({ kind: "tips_tricks", topic: "budgeting a remodel" });
    expect(p).toMatch(/VARY/);
    expect(p).toContain("#LittleRock");
  });

  it("hashtag prompt with pool instructs brand + local picks", () => {
    const pool = {
      brand: ["#ColumbusHomeSolutions"],
      local: ["#LittleRock"],
      general: ["#HomeRemodel"],
    };
    const p = buildHashtagPrompt(
      { kind: "tips_tricks", topic: "budgeting a remodel" },
      "both",
      pool,
    );
    expect(p).toContain("2-3 brand tags");
    expect(p).toContain("ColumbusHomeSolutions");
    expect(p).toContain("facebook_hashtags");
  });

  it("parseHashtagsForPlatform prefers instagram set for both", () => {
    const text =
      '{"facebook_hashtags":["#A","#B","#C"],"instagram_hashtags":["#A","#B","#C","#D","#E","#F","#G","#H","#I"]}';
    const tags = parseHashtagsForPlatform(text, "both");
    expect(tags.length).toBe(9);
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

  it("fallback hashtags return 10–15 varied tags that differ per seed (#8)", () => {
    const a = fallbackHashtags("post-a", "garage_conversion");
    const b = fallbackHashtags("post-b", "garage_conversion");
    expect(a.length).toBeGreaterThanOrEqual(10);
    expect(a.length).toBeLessThanOrEqual(15);
    // Different seeds vary the selection so the feed isn't spammy.
    expect(a.join(",")).not.toBe(b.join(","));
    // All start with '#' and are unique.
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
  });

  it("composes caption + hashtags into the publish text", () => {
    expect(composePublishText("Hello", ["#A", "#B"])).toBe("Hello\n\n#A #B");
    expect(composePublishText("Hello", [])).toBe("Hello");
  });

  it("pickHashtagsForPlatform caps facebook at 5 and instagram at 15", () => {
    const tags = Array.from({ length: 20 }, (_, i) => `#Tag${i}`);
    expect(pickHashtagsForPlatform(tags, "facebook").length).toBe(5);
    expect(pickHashtagsForPlatform(tags, "instagram").length).toBe(15);
  });

  it("builds the documented Graph request shapes (IG two-step)", () => {
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
    });
    expect(c.url).toContain("/IG/media");
    expect(c.body).toMatchObject({ image_url: "https://x/img.jpg" });

    const p = buildInstagramPublishRequest({ igAccountId: "IG", accessToken: "TOK", creationId: "CID" });
    expect(p.url).toContain("/IG/media_publish");
    expect(p.body).toMatchObject({ creation_id: "CID" });
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

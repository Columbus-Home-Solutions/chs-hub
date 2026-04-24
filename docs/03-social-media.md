# Social Media Automation — Build Plan

**Status:** Draft v0.1 — companion to REBUILD-ARCHITECTURE.md
**Spec source:** Tony's existing `CHS_ProjectInstructions_and_SOP` Google Doc + `ColumbusHomeSolutions_SocialMedia_System` spreadsheet

---

## 1. What we're building

Tony's existing social media system is already well-designed. This plan **automates the tedious parts of executing it**, not the strategy.

**What stays the same:**
- The 3 posts/week cadence (Mon Project Spotlight / Wed Seasonal Tips / Fri Rotating)
- The content pillars + voice guide
- The Brand Profile + Content Pillars Tony already defined
- Metricool as the scheduler (manual paste — no API integration)
- Tony's approval as the final gate

**What we automate:**
- Monthly plan generation (today: manual Claude session + copy to sheet)
- AI image generation for non-job posts (today: manual ChatGPT/Gemini + manual Drive upload)
- Approval queue surfacing (today: manual filtering on Monthly Plan tab)
- Photo picker from "Ready for Social" (today: manual browse in Drive)

**What we DO NOT build:**
- Auto-posting to FB/IG/LinkedIn/etc. (Metricool handles that)
- Meta Graph API integration (not needed since Metricool is the scheduler)
- Engagement analytics (Metricool + platform native tools already provide)

---

## 2. Where this fits in the hub

Dashboard section: `/social`

Subpages:
- `/social/plan` — this month's calendar, generated or manual
- `/social/queue` — this week's 3 posts awaiting approval
- `/social/library` — job photos marked "Ready for Social," filterable by job/type
- `/social/performance` — monthly performance log (optional, Session 14+)

Data model:
- `social_posts` table (pillar, day, caption, image URL, hashtags, status)
- `social_plans` table (monthly plans, one-to-many with posts)
- File system: photos live in R2 (see REBUILD-ARCHITECTURE.md file schema), AI-generated images tagged `category='ai_generated'`

---

## 3. Milestones

### Session 8a — Monthly plan generator (1-2 hrs)

**Goal:** Tony clicks "Generate Plan for May," picks 4 featured jobs, gets a 12-13 post monthly calendar in the dashboard.

1. Port Tony's Claude Project custom instructions into the Worker's prompt template (the full instruction block lives in `CHS_ProjectInstructions_and_SOP`)
2. `POST /api/social/monthly-plan` endpoint:
   - Input: month (YYYY-MM), list of 4 featured job IDs with stage (Start/Progress/Finished)
   - Worker builds prompt: instructions + featured jobs + season context
   - Calls Claude with multi-step structured output (one post at a time)
   - Returns 12-13 post objects with: pillar, suggested date, caption draft, image source (AI or job photo), image prompt (if AI), hashtag set
3. Dashboard `/social/plan`:
   - Month picker
   - Featured job picker (pulls from active jobs in D1)
   - "Generate Plan" button
   - Editable calendar view of proposed posts
   - Save to D1 as a `social_plans` record
4. Export options:
   - Copy plan to clipboard (tab-separated, pastes into Tony's existing sheet)
   - Export as CSV
   - In Session 14+: direct "Add to approval queue" button

**Shippable as:** Tony's 15-min monthly planning becomes a 2-min button click.

### Session 8b — (estimating milestone — interleaved, see ESTIMATING-APP-PLAN.md)

### Session 14 — AI image generation + approval queue polish (2 hrs)

**Goal:** Wed/Fri AI-image posts generate automatically; approval queue is a real dashboard workflow.

1. Image generation provider (decided before session — Flux Pro recommended):
   - Worker endpoint: `POST /api/social/posts/:id/generate-image`
   - Takes the post's image prompt (already generated in 8a) + brand style suffix
   - Calls Replicate API (Flux Pro) or OpenAI (DALL-E 3) depending on Tony's choice
   - Downloads result, uploads to R2 with `category='ai_generated'`
   - Associates with the post
2. Dashboard `/social/queue`:
   - Shows this week's 3 posts (Mon/Wed/Fri)
   - For Mon (job photo): photo picker from Ready-for-Social files in R2, filterable by job
   - For Wed (AI image): shows prompt, "Generate Image" button, displays result, regenerate if needed
   - For Fri: rotates based on week of month (handled by the generator in 8a)
   - Inline caption editor
   - Hashtag set dropdown (pick from Hashtag Bank stored in D1)
   - "Approve" button → marks post status = approved, copies caption + hashtag set to clipboard, opens image for download
3. Workflow: Tony clicks Approve, clipboard has the caption, download opens the image — one drag to Metricool

**Shippable as:** Tony's 15-min weekly approval becomes ~5 min (mostly reviewing, not gathering).

### Session 15+ (optional) — Performance tracking

**Goal:** Learn what works without manual performance logs.

Tony currently fills out the Performance Log tab manually. If he hates this (most do), Session 15+ adds:

1. Scrape Metricool's analytics API (if his plan supports it) or paste engagement numbers once a month
2. Dashboard `/social/performance` visualizes: which pillar performs best, which hashtag sets, which post times
3. Feeds back into the monthly plan generator: "Last month's winners used the Myth-Busting pillar — generate 2 of those this month"

Low priority. Only build if Tony actually wants it.

---

## 4. Photo "Ready for Social" workflow

One specific detail worth calling out, since Tony's SOP references it but the Drive structure didn't define it explicitly:

**In the new hub model:**
- Crew uploads photos via PWA with `category='progress'` or `'before'` or `'final'`
- Tony (or crew leader) reviews photos in the dashboard and can toggle a "Ready for Social" flag on any photo → sets `category='social_ready'` additionally (via a `file_tags` entry)
- When the approval queue needs a photo for a Monday post, it filters `files` where `job_id=X AND 'social_ready' IN tags`
- Tony picks from that filtered set

This eliminates the manual "browse to Ready for Social folder in Drive" step.

---

## 5. AI image prompts — how they get good

Tony's `Brand Style Suffix` (appended to every AI image prompt) is:

> "Photorealistic, warm natural lighting, soft shadows, modern farmhouse aesthetic, lived-in and welcoming, Central Arkansas setting, clean composition, 4:5 vertical for Instagram or 1:1 square for Facebook, no visible text, no people's faces in focus unless specified, avoid: over-saturated colors, fantasy elements, stock-photo feel, visible AI artifacts."

The Worker always appends this before calling the image gen API. Tony can tweak the suffix anytime from `/social/settings` — changes take effect next generation.

Recommended model: **Flux Pro 1.1** via Replicate. Reasons:
- Best photorealism in the "warm natural light, real interior" space
- Strong at architectural subjects (decks, kitchens, bathrooms)
- Handles brand style prompts well vs. DALL-E 3 which sometimes ignores negative prompts
- ~$0.055/image vs DALL-E 3 at $0.04

Monthly cost math:
- 4-8 AI images per month (Wed posts mostly, some Fri rotations)
- 2 regenerations on average per image = ~16 generations/month
- 16 × $0.055 = **~$0.90/month**

Negligible.

---

## 6. Hashtag Bank + Caption Templates

Tony's spreadsheet has `Hashtag Bank` and `Caption Templates` tabs. In the hub:

- `hashtag_sets` table in D1 — each row: name, platform, list of hashtags
- `caption_templates` table in D1 — each row: pillar, template body with {placeholders}
- Seed data in Session 8a — port from Tony's existing sheet once
- Tony edits them from `/social/settings` without needing to touch the sheet

---

## 7. What this replaces

**Today's monthly rhythm:**
- Last Friday of month: 30 min (planning + sheet copy)
- Each Sunday/Monday: 15 min (approval + image gathering + Metricool paste)
- End of month: 10 min (performance log)
- **Total: ~95 min/month**

**With the hub:**
- Last Friday: 5 min (click generate, review, commit)
- Each Sunday/Monday: 5 min (review, approve, paste to Metricool)
- End of month: 0-10 min (auto or manual, Tony's call)
- **Total: ~30 min/month**

~65 min/month saved. Not huge in hours, but the cognitive load is dramatically lower — no "where's that AI image, where's the job photo, what was the prompt again" friction.

---

## 8. Open questions

1. **Image gen provider:** Flux Pro (recommended), DALL-E 3, or Gemini Imagen? Test in Session 14 if undecided.
2. **Frequency of planning:** stay monthly, or move to bi-weekly now that generation is cheap? Likely stay monthly for predictability.
3. **Multi-platform caption variants:** Tony's instructions mention platform-specific tweaks (GBP keyword-rich, TikTok short hook, etc.). Worth auto-generating 5 variants per post, or keep the "one core caption + manual tweak" pattern? Recommend one-core-caption to start; add variants later if useful.
4. **Employee role in social:** Tony currently does it all. Future employee handling social? Permission system in the hub supports it (role = 'office' can access social, 'crew' cannot).

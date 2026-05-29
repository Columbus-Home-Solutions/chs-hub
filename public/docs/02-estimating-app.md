# Estimating App — Build Plan

**Status:** Draft v0.1 — companion to REBUILD-ARCHITECTURE.md
**Scope:** AI-powered estimate generation from uploaded blueprints, photos, documents, and video, pushed to Jobber as client + quote

---

## 1. What we're building

A workflow inside the CHS Hub that lets Tony (or eventually any employee) do this:

1. Open the hub → "New Estimate"
2. Upload anything relevant: blueprint PDFs, phone photos of the space, measurements scribbled on paper, video walkthroughs, reference photos
3. Fill in minimal context: client name, property address, type of work
4. Click "Analyze"
5. AI extracts scope, dimensions, materials noted, room counts
6. System composes a draft estimate using the existing CHS pricebook + local market rates
7. Tony reviews in the dashboard, tweaks line items, adjusts margin
8. Click "Send to Jobber" — creates new client + quote in Jobber automatically
9. Estimate PDF generated and saved to the associated lead/job folder in R2

The target: a 30-minute estimate becomes a 5-minute estimate. Not a replacement for Tony's judgment — a force multiplier for it.

---

## 2. Where this fits in the hub

The estimating app isn't a separate system — it's a first-class feature of `chs-hub` that:
- Uses the same R2 bucket for file storage
- Uses the same D1 database (see `estimates` + `files` tables in architecture doc)
- Uses the same Claude API client as smart notes + social media generation
- Uses the same Jobber API integration as the sync, but adds write mutations
- Lives in the same Worker as everything else

One codebase, one deploy, one audit log.

---

## 3. Data inputs (what the AI sees)

### 3.1 Pricebook (already exists)

`chs-estimator-seeder/data/jobber_products_services.csv` — Tony's authoritative pricebook, synced quarterly to Jobber's Products & Services catalog. 92 items covering:
- Labor categories (rough carpentry, finish carpentry, plumbing, electrical, HVAC)
- Common materials (lumber by type, drywall, tile, fixtures)
- Bundled packages (bathroom remodel basic, kitchen demo, deck build)

The AI is instructed to **use these line items first**, falling back to custom entries only when no pricebook item fits.

### 3.2 Local market rates

The existing `market-rates-workflow.md` defines how market rate data gets updated quarterly. We overlay pricebook costs with recent market shifts ("lumber up 12% vs last quarter") so estimates stay current without rewriting the pricebook every month.

**Session 12** integrates this — until then, the estimating app uses pricebook rates as-is.

### 3.3 Uploaded files

Per estimate, the system accepts:

| Type | AI treatment | Notes |
|---|---|---|
| Blueprint PDF | Claude Vision extracts rooms, dimensions, features, notes | Primary source of scope |
| Photos (before/walkthrough) | Claude Vision identifies conditions, existing materials, scope hints | Fills in details blueprints don't show |
| Paper notes (phone photo of a notebook page) | OCR + Claude interpretation | Tony's quick measurements + specs |
| Video walkthrough | Frame-sample every 3 sec → Claude Vision | Catches things photos miss |
| Client messages / emails | Pasted text → Claude parses requirements | "Client wants a tile backsplash and pendant lights" |

### 3.4 Tony's knowledge (system prompt)

The Worker's estimating prompt includes Tony's expertise baked in:
- "Columbus Home Solutions does remodeling, additions, decks, fences"
- "We have in-house plumbing, electrical, HVAC — include them as line items when applicable"
- "Central Arkansas market — typical job sizes, common material availability"
- "Tony's margin targets by category (labor vs materials)"
- "Always include line items for permits, cleanup, and dumpster when scope requires"
- "Always include a contingency line"

This prompt evolves as we learn what Tony corrects when reviewing drafts — Session 16's polish includes a feedback loop that teaches the system which line items it misses.

---

## 4. Milestones

Each milestone is 1-3 hours of build time and produces something shippable (even if not polished).

### M1 — File upload → R2 (90 min)
**Prerequisite for everything else.** Just the plumbing.

- `POST /api/estimates` creates a draft estimate record
- `POST /api/files/upload-url` returns pre-signed R2 URL tied to the estimate
- Browser uploads file directly to R2 (no Worker bandwidth)
- `POST /api/files/:id/finalize` records metadata
- Dashboard `/estimates/new` shows uploaded files

**Shippable as:** a clean file uploader, standalone. Already useful without AI.

### M2 — Claude Vision on a single photo (90 min)

- Worker reads a single uploaded file from R2
- Sends to Claude Vision with a structured-extraction prompt
- Stores result as JSON in `estimates.extracted_scope`
- Dashboard shows: "AI detected: a kitchen approximately 12x14 ft, existing cabinets look mid-grade oak, no visible damage, good natural light"

**Shippable as:** "AI looks at my photo and describes it." Fun. Useful for note-taking even beyond estimating.

### M3 — Multi-file extraction (2 hrs)

- Worker fetches all files attached to an estimate
- Builds a single multi-modal Claude prompt (all files → one combined extraction)
- Handles blueprints differently from photos differently from videos
- Merges extracted data: "kitchen 12x14, existing cabinets, client wants shaker style, needs new electrical for island, pendant lights × 3"

**Shippable as:** you upload a handful of files for a real job, you get a structured read of what's involved.

### M4 — Pricebook composition (2 hrs)

- Extracted data → Claude composes a proposed line-item list using pricebook
- Worker queries pricebook (stored in D1 after a sync from the seeder CSV)
- Each proposed line: pricebook item ID or "custom" + quantity + unit price + total
- Dashboard `/estimates/:id` shows proposed items in an editable table
- Subtotal, margin, grand total calculated live

**Shippable as:** first real draft estimate from an upload. You review, tweak, nothing sent yet.

**At this milestone, Tony can use the system for real.** He uploads a job, gets a draft, manually creates the Jobber quote from the draft. Half-automation, but already saves time.

### M5 — Market rate overlay (2 hrs)

- Integrate `market-rates-workflow.md` data source
- Each pricebook item shows "current rate vs. last-updated pricebook rate"
- Dashboard can toggle "use pricebook rates" vs "use market rates"
- Flag items where market rate differs >10% from pricebook for review

**Shippable as:** estimates reflect current market pricing, not last quarter's.

### M6 — Review/edit UI polish (2 hrs)

- Inline editable line items (change qty, unit price, swap pricebook item)
- Add custom line items from a search-as-you-type picker
- Drag to reorder
- Group by section (Demo, Rough-In, Finishes, Cleanup)
- Client-facing preview (what the Jobber quote will look like)
- Markdown-style notes per line item (for Tony's internal reference)

**Shippable as:** production-ready UX. Tony can spend 5 min on a draft instead of 30 min in Jobber.

### M7 — Jobber write: createClient (90 min)

- Jobber GraphQL mutation: `clientCreate` with name, phone, email, address
- Handle: client already exists (search first, reuse if found)
- Handle: property already exists (search + reuse)
- Test in Jobber sandbox if available, then production

**Shippable as:** one-click "Push client to Jobber" button on the lead record.

### M8 — Jobber write: createQuote (2 hrs)

- Jobber GraphQL mutation: `quoteCreate` linked to client + property
- Line items mapped from D1 `estimates.line_items` → Jobber `lineItemsInputs`
- Quote status set to DRAFT (Tony reviews in Jobber before sending)
- `estimates.jobber_quote_id` recorded for traceability
- Dashboard shows "View in Jobber" link after push

**Shippable as:** end-to-end workflow. Upload blueprint → Jobber quote in 5 min.

### M9 — Polish, observability, error handling (2 hrs)

- Graceful failure: "AI couldn't read blueprint clearly — try a different angle or add more context"
- Partial success: if Jobber push fails, retain local draft and allow retry
- Cost tracking: show AI cost per estimate in dashboard (so Tony can see if it's sustainable)
- Feedback loop: when Tony edits a proposed line item, log the edit so we can improve the prompt
- Rate limiting: don't let one giant estimate exhaust Claude quota for other features

**Shippable as:** v1.0 — confident to put in daily use and eventually hand to an employee.

---

## 5. Expected accuracy progression

Honest expectations about how well this works over time:

| After session | Expected hit rate |
|---|---|
| M4 (first draft) | 40-60% of line items correct, 20-30% missing, 10-20% wrong items |
| M6 (with UI polish) | Same accuracy but much faster to correct |
| M9 + 1 month of use | 70-80% of line items correct (Tony's edits train the prompt) |
| 3-6 months of use | 85-90% — system learns Tony's patterns, common packages |

Estimating is fundamentally judgment work. AI gives you the first 80%; you apply experience to the last 20%. The value isn't replacing Tony's expertise — it's letting him spend his time on the 20% that matters instead of typing out 80 line items.

---

## 6. What it costs to run

Per estimate, rough numbers:

| Step | API | Cost |
|---|---|---|
| File upload to R2 | Cloudflare R2 | ~$0.000 (free tier) |
| Claude Vision extraction (multi-file) | Claude Sonnet 4.5 | $0.03 - $0.15 depending on file count + sizes |
| Line-item composition | Claude Sonnet 4.5 | $0.01 - $0.03 |
| Jobber mutations | Jobber API | $0 (included in Jobber subscription) |

**Per estimate: ~$0.10 - $0.25.**

If Tony produces 40 estimates a month, AI costs are $4-$10/mo. If he wins 25% of them at an average $15K job size, that's $150K of won work/month sourced from $10 of AI cost.

The ROI isn't in winning more — it's in winning the same proportion with less Tony-time per quote.

---

## 7. What this replaces in Tony's current workflow

Today (approximate time per estimate):
- Review walkthrough notes / photos: 5 min
- Sketch scope in Jobber quote builder: 10-15 min
- Add 30-80 line items manually: 15-25 min
- Apply margin, check totals: 5 min
- Review + send: 5 min
**Total: 40-55 min per estimate**

With the hub (projected after M9 + a few weeks of use):
- Upload files from phone or desktop: 2 min
- Review AI draft, tweak 10-15 items: 5-8 min
- Click send to Jobber: instant
**Total: 7-10 min per estimate**

That's 4-6x faster with equal or better accuracy.

At current Tony-volume of ~40 estimates/month, that's 20+ hours saved per month — time that goes into actually running the business instead of typing line items.

---

## 8. Open questions — to resolve before or during build

1. **Video handling:** Claude Vision works on frames, not video directly. Do we sample every 3 sec, 5 sec, 10 sec? Cost vs. accuracy tradeoff. Test in M3.
2. **Blueprint scale detection:** blueprints have a scale legend (1/4"=1'). We need to prompt the AI to look for this. If missing, flag for human confirmation.
3. **Margin policy:** fixed margin % per category? Per-job toggle? Always show both cost and price? Decide in M4.
4. **PDF generation:** do we generate our own estimate PDF (for client records in R2) or rely on Jobber's? Recommendation: rely on Jobber's to start — they're already generating them for quotes. Our R2 just stores the input files, not the final document. Can revisit.
5. **Multi-trade jobs:** when a job spans remodeling + plumbing + electrical, does the system produce one estimate or three linked ones? Start with one; split only if Tony finds it necessary.
6. **Client-side review:** eventually, clients could get a shareable link to review/accept the estimate digitally. Out of scope for v1.0, but the schema supports it (`file_shares` table).

---

## 9. What I need from Tony during build

Minimal, but real:

- **3-5 past estimates** (as PDFs or Jobber exports) to use as training examples. I'll show Claude what "a good Tony estimate" looks like in the prompt.
- **2-3 test jobs** to run end-to-end in the sandbox phase: upload their files, review output, correct errors. This trains the prompt.
- **~15 min feedback** after M4, M6, and M9: "here's what the AI missed, here's what it got wrong, here's what it nailed." Each session, the prompt improves.

Everything else I handle in the build sessions.

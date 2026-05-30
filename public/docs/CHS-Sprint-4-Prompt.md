# Sprint 4: Estimate Builder
## Cursor Prompt — CHS Construction Management Platform

---

## Context

You are continuing the CHS construction management platform build. This is a Cloudflare Workers + D1 + R2 backend with a Preact + Vite frontend. No React, no Tailwind, no ORM.

**Current state:**
- Sprint 1 ✅ deployed, tagged `v0.1.0-sprint1` — schema, auth, settings, heartbeat
- Sprint 2 ✅ deployed, tagged `v0.2.0-sprint2` — Preact frontend, app shell, Client/Properties/Comms/Subs CRUD, repeat-client detection, `/api/me`
- Sprint 3 ✅ committed + pushed to GitHub, tagged `v0.3.0-sprint3`, NOT yet deployed remotely — Estimating Pipeline (request intake, Kanban board, WC hooks, audit logging)

Sprint 4 builds the **Estimate Builder** — the engine that turns a pipeline request into a complete, priced estimate. This is the heart of the estimating workflow: parent line items (what the client sees), sub-items (internal cost breakdown), payment schedules, templates, and the live client-facing preview. It does NOT send the estimate to the client or take payment — that is Sprint 5.

**Sprint 4 is local-only.** Do not deploy to remote. Do not touch the remote D1. Do not run any remote wrangler commands.

---

## Step 0: Explore Current State

Before writing any code, understand where Sprint 3 left things:

1. **Read `src/index.ts`** — the route dispatcher. Sprint 3 wired in `estimate-requests`. Follow the same pattern to wire in the new `estimates` routes.

2. **Read `src/routes/estimate-requests.ts`** — the most recent reference pattern: `WRITE_ROLES`, auth guard, validation, D1 queries, audit logging, the forward-only status guard, and the WC trigger hooks. The new `estimates.ts` follows this structure exactly.

3. **Read `src/lib/wc/triggers.ts`** — the WC hook pattern from Sprint 3 (`triggerLeadCreated`, `triggerAppointmentSet`). Sprint 4 adds `triggerQuoteSent`.

4. **Read the estimating views from Sprint 3** — `frontend/src/views/estimating/EstimateRequestDetail.tsx` has the "Build Estimate" stub button that currently routes to `/app/estimating/:id/estimate` and lands on Not Found. Sprint 4 makes that route real.

5. **Read `frontend/src/views/clients/ClientForm.tsx`** — reference for complex multi-field forms with the `useForm` hook and validation.

6. **Read the existing UI primitives** in `frontend/src/components/ui/` — Card, Button, FormField, Select, Modal, Badge, Table, Toast, Spinner. The builder reuses these. Do not create new primitives unless genuinely needed.

7. **Check `.gitignore`** — confirm `scripts/dev-seed-sprint3.local.sql` is listed. The new `scripts/dev-seed-sprint4.local.sql` must be added before committing.

---

## Before Writing Any Code

Read these documents from the project knowledge in this order:

1. **cursorrules.md** — coding conventions, patterns, naming, architecture. This is law.
2. **CHS-Database-Schema.md** — table definitions for `estimates`, `estimate_line_items` (parent), `estimate_sub_items`, `payment_schedules`, `estimate_templates`, `saved_reviews`, `vendor_materials`. Confirm which already exist from Sprint 1's `0016_estimating_tables.sql`.
3. **Module-Spec-Estimating-Quoting.md** — record definitions (section 3), estimate builder screens (sections 6.4, 6.5), material cost integration (section 5), business rules (section 7), WC data points (section 9)
4. **CHS-API-Route-Map.md** — Section 3 (Estimating & Quoting → Estimates, Line Items, Payment Schedules, Templates)
5. **CHS-Design-System.md** — tokens, component patterns (frontend matches Sprint 2/3 exactly)
6. **CHS-Build-Order-Plan.md** — Sprint 4 scope (you are here), and a glance at Sprint 5 so you build the right seams
7. **Module-Spec-WC-Spreadsheet.md** — how the "quotes sent" count and dollar value sync works

---

## Important: Schema Already May Exist

Like Sprint 3, the estimating tables were likely created back in `0016_estimating_tables.sql`. Before writing a migration:

```bash
npx wrangler d1 execute chs-hub-db --local --command="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('estimates','estimate_line_items','estimate_sub_items','payment_schedules','estimate_templates','saved_reviews','vendor_materials');"
```

For each table that already exists, confirm its columns match the schema doc:
```bash
npx wrangler d1 execute chs-hub-db --local --command="PRAGMA table_info(estimates);"
```

Create `migrations/0027_estimate_builder.sql` that:
- `CREATE TABLE IF NOT EXISTS` for any of the seven tables not already present
- `ALTER TABLE ... ADD COLUMN` for any missing columns on existing tables (one ALTER per statement, only for genuinely missing columns)

This is the Sprint 4 migration of record even if it ends up a near no-op.

Run it locally and verify:
```bash
npx wrangler d1 execute chs-hub-db --local --file=migrations/0027_estimate_builder.sql
```

---

## Sprint 4 Deliverables

### Backend

#### New route file: `src/routes/estimates.ts`

Follow the `estimate-requests.ts` pattern. `WRITE_ROLES = ["owner", "project_manager", "office_admin"]`.

**Estimate endpoints:**

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/estimates` | List estimates. Filters: `?status=xxx&request_id=xxx&client_id=xxx` |
| GET | `/api/estimates/:id` | Full estimate with line items, sub-items, and payment schedule nested |
| POST | `/api/estimates` | Create estimate. Requires `estimate_request_id`. Pre-fills client/property/job_type from the request. |
| PUT | `/api/estimates/:id` | Update estimate header (mode, billing model, validity, notes, review/contract toggles) |
| POST | `/api/estimates/:id/send` | Mark estimate as sent. Sets `sent_date`, computes `expiration_date`, fires `triggerQuoteSent` WC hook. Validation gate (see business rules). Stub the actual client delivery — Sprint 5 wires Stripe + portal. This endpoint only flips status and logs. |
| POST | `/api/estimates/:id/revise` | Create a new version, preserve original, set original status to `revised` |

**Line item endpoints (parent — client-facing):**

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/estimates/:id/line-items` | List parent line items for an estimate, with sub-items nested |
| POST | `/api/estimates/:id/line-items` | Add a parent line item |
| PUT | `/api/line-items/:id` | Update a parent line item |
| DELETE | `/api/line-items/:id` | Remove a parent line item (and cascade its sub-items) |
| PUT | `/api/estimates/:id/line-items/reorder` | Bulk update `sort_order` from an array of IDs |

**Sub-item endpoints (internal cost — never client-visible):**

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/line-items/:id/sub-items` | Add a sub-item under a parent |
| PUT | `/api/sub-items/:id` | Update a sub-item |
| DELETE | `/api/sub-items/:id` | Remove a sub-item |

**Payment schedule endpoints:**

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/estimates/:id/payment-schedule` | List payment milestones for the estimate |
| PUT | `/api/estimates/:id/payment-schedule` | Replace the full payment schedule (array of milestones) |

**Template endpoints:**

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/estimate-templates` | List active templates. Filter: `?job_type=xxx` |
| GET | `/api/estimate-templates/:id` | Full template with line items JSON |
| POST | `/api/estimate-templates` | Save a new template (optionally from an existing estimate) |
| PUT | `/api/estimate-templates/:id` | Update template, including `is_active` toggle |
| POST | `/api/estimates/:id/apply-template/:templateId` | Pre-populate an estimate's line items from a template |

**Saved reviews endpoints:**

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/reviews` | List saved reviews. Filter: `?active=true` |
| POST | `/api/reviews` | Add a review |
| PUT | `/api/reviews/:id` | Update a review (including `is_active`) |
| DELETE | `/api/reviews/:id` | Remove a review |

**Material/vendor search endpoint:**

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/materials/search` | Search `vendor_materials` by name. `?q=2x4`. Returns last known price, preferred vendor, avg price. Read-only this sprint — the table is populated by the Financial module later (Sprint 10). If empty, return an empty array gracefully. |

All write operations log to `audit_logs`. Auth guard on all routes. Wire everything into `src/index.ts` following the existing dispatch pattern.

#### Computed totals

The API is the source of truth for math. On any read of an estimate:
- Each parent line item `total` = `quantity × unit_price`
- Each sub-item `total_cost` = `quantity × unit_cost`
- Estimate `subtotal` / `total` = sum of parent line item totals
- Internal cost total = sum of all sub-item `total_cost`
- Margin = `(total − internal_cost) / total` as a percentage

Return these computed values in the estimate payload so the frontend never has to recompute authoritative numbers. The frontend may compute optimistic previews while editing, but the API value wins on save.

#### WC hook: `triggerQuoteSent`

Add to `src/lib/wc/triggers.ts`, matching the Sprint 3 hooks. Called from `POST /api/estimates/:id/send`. Logs intent for:
- Quotes sent count (KBPI weekly)
- Quotes sent dollar value (Weekly Marketing Tallies → New Sales)

Same "log intent, cron recomputes from D1" pattern as Sprint 3 — do not reinvent the sync mechanism.

#### Deposit calculation

On estimate create and on billing-model change, set the default deposit:
- **Fixed Price:** 33% of total
- **Trade-by-Trade:** configurable, default to first milestone
- **Cost-Plus:** flat $1,000 (pull the default from `system_settings` if a key exists; otherwise hardcode $1,000 with a TODO comment)

The user can override the deposit. Store it on the estimate.

---

### Frontend

#### New view: `frontend/src/views/estimating/EstimateBuilder.tsx`

Route: `/app/estimating/:requestId/estimate` (creates a new estimate if none exists for the request, otherwise opens the existing one).

**Desktop — two-panel layout:**

*Top bar:*
- Estimate mode selector: Lump Sum / Trade-by-Trade (segmented control)
- Billing model selector: Fixed Price / Trade-by-Trade / Cost-Plus (dropdown)
- Template selector: dropdown of active templates → "Apply Template" with confirmation if line items already exist
- Margin summary: total client price, total internal cost, margin % (live, color-coded — red if margin < 15%)
- Save Draft / Preview buttons

*Left panel — line item editor:*
- Each parent line item is a collapsible Card
- Fields: product/service name, description (multiline), quantity, unit, unit price, computed total
- Expand to reveal sub-items: description, category (material/labor/subcontractor/permit/equipment/other), vendor, quantity, unit, unit cost, computed total cost
- "Add Sub-Item" button under each parent
- "Search Materials" button on a sub-item → opens a Modal that calls `/api/materials/search`, inserts the selected price (gracefully handles empty DB)
- Drag handle to reorder parent items (reuse the Sprint 3 native HTML5 drag pattern)
- "Add Line Item" button at the bottom

*Right panel — live client preview:*
- Renders exactly what the client will see: line items with descriptions, quantities, prices, subtotal, total
- Sub-items NEVER appear here (internal only)
- Payment schedule
- Reviews (if toggle on)
- Contract notice (if toggle on)
- This is a faithful preview of the Sprint 5 client-facing page

*Bottom section:*
- Subtotal and total
- Payment schedule builder: add/edit/remove milestones (description, percentage OR fixed amount, deposit flag, trigger). Live-validates that percentages sum to 100% if using percentages.
- Contract selector: standard service agreement (default) or cost-plus billing agreement
- Include Reviews toggle + which reviews
- Include Contract toggle
- Validity period (days, default 7)
- "Save Draft" and "Send Estimate" buttons

**Mobile — single column (`EstimateBuilder` responsive, or a sibling layout):**
- Stacked line item cards, tap to expand/edit
- Quick-add buttons for line items and sub-items
- Template selector at top
- Toggle button to switch between Edit and Preview (not side-by-side)
- Designed for review and minor edits, not full construction (desktop is primary)

#### New view: `frontend/src/views/estimating/EstimateTemplates.tsx`

Route: `/app/estimating/templates`
- List active and inactive templates
- Create / edit / deactivate
- "Save current estimate as template" entry point lives in the builder; this view manages the library

#### Settings additions

In `frontend/src/views/settings/Settings.tsx`, add a "Reviews" section that manages saved reviews (CRUD against `/api/reviews`) — these feed the quote page in Sprint 5. Keep it simple: list, add, edit, toggle active.

#### Wire up the Sprint 3 stub

In `EstimateRequestDetail.tsx`, the "Build Estimate" button currently routes to a dead `/app/estimating/:id/estimate`. Make it functional:
- If no estimate exists for this request → "Build Estimate" creates one and opens the builder
- If an estimate exists → button reads "Open Estimate" (and show estimate status + total on the detail view)

#### Routing additions in `frontend/src/router.tsx`

```
/app/estimating/:requestId/estimate   → EstimateBuilder
/app/estimating/templates             → EstimateTemplates
```

---

### Dev Seed Data

**`scripts/dev-seed-sprint4.local.sql`** — LOCAL ONLY, gitignored before committing

- 2 complete estimates linked to existing Sprint 3 seed requests: one Lump Sum (fixed price), one Trade-by-Trade — each with parent line items, sub-items, and a payment schedule
- 2 estimate templates (e.g., "Bathroom Remodel", "Garage Conversion") with line items JSON
- 3 saved reviews (the placeholder reviews from CHS-Seed-Data.md if present)
- A handful of `vendor_materials` rows so "Search Materials" returns something during testing

Add to `.gitignore` immediately:
```bash
echo "scripts/dev-seed-sprint4.local.sql" >> .gitignore
grep "dev-seed-sprint4" .gitignore
```

---

## Business Rules to Enforce

1. An estimate can only be **sent** when it has at least one parent line item AND a deposit amount configured. `POST /:id/send` returns 400 otherwise.
2. **Sub-items are never returned in any client-facing payload.** The preview endpoint/data path must exclude them. Only the internal builder view sees sub-items.
3. **Billing model carries to the job** on conversion (Sprint 6) and cannot change after the first invoice — so store it firmly on the estimate now. No special handling needed this sprint beyond persisting it.
4. **Revisions create new versions.** `POST /:id/revise` clones the estimate + line items + sub-items + payment schedule into a new version, preserves the original, sets original status to `revised`. Follow-up timers (Sprint 5) reset on the new version.
5. **Material prices are snapshots.** When a sub-item pulls from `vendor_materials`, copy the price into the sub-item. Later DB price changes never alter existing estimates. Store `material_id` as a reference only.
6. **Deactivated templates** are hidden from the builder's selector but preserved in history (`is_active = false`, never deleted).
7. **Validity period** default 7 days, configurable per estimate. `expiration_date = sent_date + valid_days`, computed on send.
8. **Payment schedule validation:** if milestones use percentages, they must sum to 100% before the estimate can be sent. Fixed amounts are allowed to coexist; if mixing, validate the math is coherent (fixed + percentage-of-remainder).

---

## Tests to Run Before Marking Done

```bash
# Create an estimate from a seed request
curl -X POST http://localhost:8787/api/estimates \
  -H "Content-Type: application/json" \
  -d '{"estimate_request_id":"<seed-request-id>","mode":"trade_by_trade","billing_model":"fixed_price"}'

# Add a parent line item
curl -X POST http://localhost:8787/api/estimates/<id>/line-items \
  -H "Content-Type: application/json" \
  -d '{"product_service":"Framing","description":"Frame garage conversion","quantity":1,"unit_price":13904}'

# Add a sub-item under it
curl -X POST http://localhost:8787/api/line-items/<lineItemId>/sub-items \
  -H "Content-Type: application/json" \
  -d '{"description":"2x4 studs","category":"material","quantity":120,"unit":"each","unit_cost":4.25}'

# Read the full estimate — confirm computed totals + margin, confirm sub-items present here
curl http://localhost:8787/api/estimates/<id>

# Try to send without a deposit configured (should 400)
curl -X POST http://localhost:8787/api/estimates/<id>/send

# Apply a template
curl -X POST http://localhost:8787/api/estimates/<id>/apply-template/<templateId>

# Search materials
curl "http://localhost:8787/api/materials/search?q=2x4"
```

---

## Done Criteria

Sprint 4 is complete when:

- [ ] `migrations/0027_estimate_builder.sql` runs clean on local D1 (no-op safe if tables exist)
- [ ] All estimate, line-item, sub-item, payment-schedule, template, review, and material endpoints respond correctly
- [ ] `GET /api/estimates/:id` returns nested line items + sub-items + payment schedule with correct computed totals and margin
- [ ] Builder renders at `/app/estimating/:requestId/estimate` with two-panel desktop layout
- [ ] Live preview updates as line items change and NEVER shows sub-items
- [ ] Parent line items: add, edit, delete, reorder (drag) all work and persist
- [ ] Sub-items: add, edit, delete work and persist
- [ ] "Search Materials" modal works and gracefully handles an empty `vendor_materials` table
- [ ] Mode selector (Lump Sum / Trade-by-Trade) and billing model selector persist
- [ ] Deposit auto-calculates per billing model and is overridable
- [ ] Payment schedule builder works; percentage milestones validate to 100% before send
- [ ] Template: save current estimate as template, apply template to pre-populate
- [ ] Templates management view works; deactivated templates hidden from selector
- [ ] Saved reviews CRUD works from Settings
- [ ] `POST /:id/send` enforces the send-gate (≥1 line item + deposit), flips status, computes expiration, fires `triggerQuoteSent` (visible in wrangler logs)
- [ ] `POST /:id/revise` creates a new version and preserves the original
- [ ] "Build Estimate" / "Open Estimate" button on the request detail is wired up
- [ ] Mobile builder: stacked cards, edit/preview toggle, quick-add all work
- [ ] Audit log entries created for all write operations
- [ ] `scripts/dev-seed-sprint4.local.sql` is gitignored
- [ ] Margin summary shows live and color-codes under 15%
- [ ] All existing functionality untouched: pipeline board, clients, subs, settings, dashboard, HL Kanban, WC sync

---

## What NOT to Do

- Do not deploy to remote — local only this sprint
- Do not build the client-facing portal page, Stripe, digital signature, or the actual send/delivery mechanics — that is **Sprint 5**. `POST /:id/send` only flips status and logs this sprint.
- Do not build quote follow-up automation (Day 3/5/7 reminders) — that is Sprint 5/7
- Do not build quote-to-job conversion — that is Sprint 6
- Do not build expense tracking or populate `vendor_materials` from receipts — that is Sprint 10. Materials search reads whatever is there (seed rows for now).
- Do not implement the KBPI cutover (estimate_requests vs Jobber quotes double-count question carried over from Sprint 3) unless it's trivial — flag it in the report instead. (See open question below.)
- Do not use any drag library not already in the project — carry forward the Sprint 3 native HTML5 drag pattern
- Do not gold-plate: clean empty states, no lorem ipsum, no fake data in the UI

---

## Carried-Over Open Question (decide during this sprint)

From Sprint 3: the WC "quotes sent" count now has a clean native trigger (`triggerQuoteSent`). The KBPI sync historically counted Jobber `quotes`. **When the estimate is sent natively, the count must come from native estimates and STOP counting the Jobber quotes table for that column — not sum both.** If the WC sync's recompute logic can be pointed at native estimates for "quotes sent" cleanly in this sprint, do it. If it risks double-counting or touching too much, leave the Jobber path as-is and flag it for Sprint 5. Report which path you took.

---

## When Done

Stop and report back with:
1. Confirmation of all done criteria checked off
2. Whether `0027` was a real migration or a no-op (which tables/columns already existed)
3. Which path you took on the KBPI quotes-sent cutover
4. Any deviations from the spec and why
5. Any open questions for Sprint 5 (quote delivery, Stripe, signature, portal)

Do not start Sprint 5 without explicit instruction.

---

## Reference Documents

All in project knowledge:

1. **cursorrules.md** — conventions, patterns, architecture
2. **CHS-Database-Schema.md** — all table definitions
3. **CHS-API-Route-Map.md** — all API endpoints
4. **CHS-Build-Order-Plan.md** — full sprint plan
5. **Module-Spec-Estimating-Quoting.md** — estimating + builder spec (primary reference)
6. **Module-Spec-Client-Management-Portal.md** — client-facing estimate page (section 4, for preview fidelity)
7. **CHS-Design-System.md** — CSS tokens and component specs
8. **Module-Spec-WC-Spreadsheet.md** — WC sync patterns
9. **CHS-Schema-Bridge.md** — existing → new table mapping
10. **CHS-Seed-Data.md** — placeholder reviews and seed values

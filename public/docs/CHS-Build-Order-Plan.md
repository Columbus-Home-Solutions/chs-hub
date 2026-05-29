# Build Order Plan
## CHS Construction Management Platform
### Version 1.0 — May 28, 2026

---

## Overview

This document defines the implementation sequence for Cursor. Each step builds on the previous one — dependencies are explicit. The plan is organized into sprints (roughly 1-2 weeks each) with clear deliverables, tests, and done criteria.

**Guiding principles:**
- Ship vertical slices, not horizontal layers. Each sprint produces something usable.
- Carry forward working chs-hub patterns wherever possible.
- The system must function with a single user (Owner) at all times.
- Mobile-first — every screen works on a phone first, then scales up.
- Offline-capable capture functions (photos, notes, expenses) use existing IndexedDB + Background Sync.

---

## Phase 1 — Foundation (Sprints 1-8)

The core loop: leads come in → estimates go out → jobs get created → work gets tracked → invoices get paid.

---

### Sprint 1: Schema & Auth Foundation
**Duration:** ~1 week
**Dependencies:** Existing chs-hub codebase

**Deliverables:**
1. Run D1 migrations 0012-0022 (full schema from Database Schema doc).
2. Verify all tables, indexes, views created successfully.
3. Confirm Cloudflare Access auth still works (carry forward).
4. Seed system_settings with default values (labor rates, fee percentages, company info).
5. Seed notification_templates with the full catalog from the Notifications spec.
6. Create the `users` table entry for Tony (Owner role).
7. Implement the auth middleware that reads `Cf-Access-Authenticated-User-Email` and resolves to a user record with role.

**Tests:**
- All 40 tables exist and accept inserts.
- Auth middleware returns user object with role on every API request.
- System settings are readable via `GET /api/settings`.

**Done when:** Schema is live, auth works, settings are populated.

---

### Sprint 2: Client Database & Subcontractor CRUD
**Duration:** ~1 week
**Dependencies:** Sprint 1

**Deliverables:**
1. Client CRUD API: `POST/GET/PUT /api/clients`, `GET /api/clients/:id`.
2. Client list page with search (name, phone, email, address).
3. Client detail page showing all info, properties, communication timeline (empty for now).
4. Property CRUD under clients: `POST/GET/PUT /api/clients/:id/properties`.
5. Repeat client detection on client creation (name + phone match check).
6. Subcontractor CRUD API (carry forward & extend from chs-hub): `POST/GET/PUT /api/subcontractors`.
7. Subcontractor list page with trade filter.
8. Migrate existing Jobber-imported client data into the new schema (add missing columns, preserve existing records).

**Tests:**
- Create, read, update clients and properties.
- Repeat client detection fires on duplicate phone/name.
- Subcontractor CRUD works, existing subs preserved.

**Done when:** Client database is the single source of truth. Existing Jobber data migrated.

---

### Sprint 3: Estimating Pipeline — Request Intake & Pipeline Board
**Duration:** ~1.5 weeks
**Dependencies:** Sprint 2 (clients)

**Deliverables:**
1. Estimate Request CRUD API: `POST/GET/PUT /api/estimate-requests`.
2. Pipeline Kanban board (desktop): columns for each status stage.
3. Pipeline board (mobile): horizontal swipe between columns.
4. Drag-to-update status changes on the board.
5. New Request form: client lookup/create, property address, job type, lead source.
6. Lead intake from High Level: "Create Estimate Request" from HL Kanban card (carry forward PIT proxy pattern).
7. Appointment scheduling on request detail: set date/time, mark complete.
8. WC Spreadsheet auto-sync: lead count, appointment count trigger on status changes (carry forward existing sync pattern).
9. Audit logging for all estimate request actions.

**Tests:**
- Full pipeline flow: New Request → Appointment Set → Visit Done.
- HL lead creates estimate request with pre-filled client data.
- WC Spreadsheet receives lead and appointment counts.
- Drag-to-update works on desktop and mobile.

**Done when:** Leads flow into the system from all sources. Pipeline board is operational.

---

### Sprint 4: Estimate Builder
**Duration:** ~2 weeks
**Dependencies:** Sprint 3 (requests), Sprint 2 (clients)

**Deliverables:**
1. Estimate CRUD API: `POST/GET/PUT /api/estimates`.
2. Estimate Line Item CRUD: parent items (client-facing) and sub-items (internal costs).
3. Payment Schedule CRUD per estimate.
4. Estimate Builder UI (desktop): two-panel layout — line item editor left, live preview right.
5. Estimate Builder UI (mobile): stacked layout with toggle between edit and preview.
6. Estimate mode selector: Lump Sum vs. Trade-by-Trade.
7. Billing model selector: Fixed Price, Trade-by-Trade, Cost-Plus.
8. Deposit calculation based on billing model (33% for fixed, custom for trade, $1,000 for cost-plus).
9. Estimate Template system: save/load templates, pre-populate from template.
10. Material/vendor database search integration: search existing prices when building sub-items.
11. Saved Reviews CRUD for quote page display.
12. WC Spreadsheet: quotes sent count triggers when estimate is sent.

**Tests:**
- Build a complete estimate with parent items, sub-items, and payment schedule.
- Template saves and loads correctly.
- Material prices auto-suggest from vendor_materials.
- Preview renders what client will see.

**Done when:** Complete estimates can be built, saved, and templated.

---

### Sprint 5: Quote Delivery & Client Approval
**Duration:** ~1.5 weeks
**Dependencies:** Sprint 4 (estimates), Document Templates (Service Agreement + Cost-Plus Agreement already designed)

**Deliverables:**
1. Estimate portal page (secure link, no auth required): branded quote with line items, payment schedule, reviews, service agreement.
2. Digital signature capture on the quote page.
3. Stripe integration for deposit payment collection (CC + ACH with 3.5% convenience fee).
4. "Pay by check" option with instructions (no fee).
5. Contract document generation from template with merge fields auto-populated.
6. Estimate status tracking: sent → viewed → approved.
7. Quote follow-up automation: Day 3, Day 5, Day 7 reminders (notification engine, see Sprint 7).
8. Quote expiration handling (7-day default).
9. Lost quote tracking: mark as lost with reason.
10. Estimate revision flow: revise → re-send → new version.

**Tests:**
- Client receives estimate link, views quote page, signs, and pays deposit via Stripe.
- Convenience fee calculated and disclosed correctly.
- Contract generated with correct client/job data.
- Quote follow-up reminders fire at configured intervals.

**Done when:** The full estimate-to-signed-contract flow works end to end.

---

### Sprint 6: Quote-to-Job Conversion & Job Pipeline
**Duration:** ~1.5 weeks
**Dependencies:** Sprint 5 (quote approval triggers job creation)

**Deliverables:**
1. Quote-to-job conversion engine: when deposit is paid, auto-create job record.
   - Job created at "Deposit Paid" status.
   - Task groups auto-generated from estimate parent line items.
   - Budget baseline set from estimate sub-items.
   - Billing schedule configured from payment schedule.
   - Client portal activated (secure token generated).
   - Portal type set based on billing model.
2. Job CRUD API: `GET/PUT /api/jobs`, `GET /api/jobs/:id` (no POST — jobs only created via conversion).
3. Job Pipeline Board (desktop/mobile): Kanban columns for each status.
4. Job Detail View with tabbed interface: Overview, Tasks, Schedule, Photos (stub), Notes (stub), Financial (stub), Documents (stub), Daily Logs, Change Orders, Permits, Activity.
5. Job status workflow: forward-only progression with allowed exceptions (In Progress → Scheduled, Complete → Punch List).
6. Task CRUD per job: `POST/GET/PUT /api/jobs/:id/tasks`.
7. Task board per job grouped by trade/phase.
8. WC Spreadsheet: closed deal count and sales value sync.

**Tests:**
- Approved estimate with deposit auto-creates job with correct data.
- Task groups match estimate line items.
- Job pipeline board shows all jobs by status.
- Status transitions enforce business rules (no backward movement except allowed).

**Done when:** Jobs flow automatically from approved estimates. Pipeline board is operational.

---

### Sprint 7: Notification Engine & Communications
**Duration:** ~1.5 weeks
**Dependencies:** Sprint 6 (jobs), Sprint 3 (estimates), Sprint 2 (clients)

**Deliverables:**
1. Notification engine: trigger → template lookup → merge → queue → send.
2. Twilio SMS integration: outbound and inbound via webhook.
3. Resend email integration (carry forward from chs-hub, extend with HTML templates).
4. Notification template rendering with merge fields.
5. Notification log with delivery tracking.
6. Communication timeline on client detail: auto-logged notifications, manual entries, Twilio messages.
7. Manual communication logging: phone calls, in-person notes.
8. Scheduled notification processor (Worker cron, 15-minute interval).
9. Quote follow-up automation (wired to estimating pipeline).
10. Deposit received / welcome portal / work starting notifications.
11. In-app notification center (bell icon, unread count).

**Tests:**
- Lead acknowledgment SMS fires on new request.
- Quote sent notification delivers email + SMS with correct link.
- Follow-up reminders fire at Day 3/5/7.
- Communication timeline shows all interactions chronologically.
- Inbound Twilio SMS auto-logs to correct client.

**Done when:** Automated notifications work across the estimating and job pipelines. Communication history is unified.

---

### Sprint 8: Photo Capture & Smart Notes
**Duration:** ~1.5 weeks
**Dependencies:** Sprint 6 (jobs)

**Deliverables:**
1. Photo CRUD API: `POST/GET /api/photos`, `GET /api/jobs/:id/photos`.
2. CHS Capture PWA updates (carry forward): camera capture, offline queue, Background Sync, GPS tagging.
3. Photo timeline per job (chronological grid, grouped by date).
4. Photo detail view with type selector (progress, before, after, receipt, punch list).
5. Receipt capture with AI processing (carry forward Claude API integration): snap → extract vendor/amount → suggest expense.
6. Receipt confirmation flow: user confirms or edits AI suggestions → expense record created.
7. Quick Capture Bar on mobile job detail: camera, voice note, quick task, log expense, daily log.
8. Smart Notes API (carry forward from chs-hub): voice/text → Claude processing → categorization, task extraction, expense routing, change order detection.
9. Daily log CRUD: `POST/GET /api/jobs/:id/daily-logs`.
10. Photo linking to tasks and daily logs.

**Tests:**
- Photo captured on mobile auto-links to job with GPS and timestamp.
- Offline capture queues in IndexedDB, syncs when online.
- Receipt AI extracts vendor, amount, category with reasonable accuracy.
- Smart Note categorized correctly creates task/expense/CO suggestions.
- Daily logs capture with photo links.

**Done when:** Field capture works: photos, receipts, notes, daily logs — online and offline.

---

## Phase 2 — Financial & Client Portal (Sprints 9-13)

Money flows: invoicing, payments, job costing, client portal, and the cost-plus billing engine.

---

### Sprint 9: Invoice Generation & Basic Payments
**Duration:** ~1.5 weeks
**Dependencies:** Sprint 6 (jobs with billing model), Sprint 5 (Stripe integration)

**Deliverables:**
1. Invoice CRUD API: `POST/GET/PUT /api/invoices`.
2. Fixed-price milestone invoice generation (auto from payment schedule).
3. Trade-by-trade invoice generation (triggered by task group completion).
4. Invoice detail page: line items, status, payment link.
5. Invoice delivery: send via email with branded payment link.
6. Payment collection page (secure link): invoice details, check vs. electronic, 3.5% convenience fee disclosure.
7. Stripe payment processing: webhooks for payment confirmation.
8. Payment record creation on successful charge.
9. Invoice status updates: sent → viewed → paid/partial/past_due.
10. Payment receipt notification on every payment.
11. Invoice due reminders (2 days before) and past due notices (daily after grace period).
12. Late fee calculation: $50/day after due date per contract terms.

**Tests:**
- Milestone invoice auto-generates at correct amounts (33/33/34 split).
- Client pays via Stripe, convenience fee calculated correctly.
- Check payment recorded manually, no convenience fee.
- Past due invoices accrue late fees.
- Payment receipt notification fires.

**Done when:** Invoices generate, payments collect, late fees accrue. Basic billing loop works.

---

### Sprint 10: Expense Tracking & Job Costing
**Duration:** ~1.5 weeks
**Dependencies:** Sprint 9 (invoices), Sprint 8 (receipt capture)

**Deliverables:**
1. Expense CRUD API: `POST/GET/PUT /api/expenses`.
2. Expense entry form: vendor, description, amount, date, category, job, estimate line item alignment.
3. Receipt-to-expense flow (from Sprint 8 receipt capture → confirmed expense).
4. Time entry CRUD: `POST/GET/PUT /api/time-entries`. Clock in/out with role-based rate ($90/$105).
5. Job costing view on job detail: budget (from estimate sub-items) vs. actual (expenses + time + subs) per line item.
6. Vendor/material database: auto-populated from expense history, searchable during estimating.
7. Mileage tracking CRUD: `POST/GET /api/mileage`.
8. Subcontractor expense tracking with 1099 flag.
9. Expense categorization for tax purposes.

**Tests:**
- Expense logged against job aligns to correct estimate line item.
- Job costing shows budget vs. actual with variance per trade.
- Time entry calculates labor cost correctly at configured rate.
- Vendor/material prices update from expense history.
- Mileage deduction calculates using IRS rate from system settings.

**Done when:** Full expense tracking is live. Job costing shows real-time budget vs. actual.

---

### Sprint 11: Cost-Plus Billing Engine
**Duration:** ~2 weeks
**Dependencies:** Sprint 10 (expenses/time), Sprint 9 (invoices)

**Deliverables:**
1. Billing cycle CRUD: `POST/GET/PUT /api/jobs/:id/billing-cycles`.
2. Mini-budget builder: projected materials, labor, subs for two-week period.
3. Auto-calculate PM fee (10%) and contractor fee (20%) on projected costs.
4. Upfront invoice generation from mini-budget (minus prior credits).
5. Cycle reconciliation: actual vs. projected comparison at cycle end.
6. Credit/overage carry-forward logic.
7. Final cycle handling: 50% upfront, 50% at completion.
8. Cost-plus financial view on job detail: all cycles with projections, actuals, reconciliation.
9. Cycle report generation for client delivery.

**Tests:**
- Complete billing cycle: create mini-budget → generate invoice → track actuals → reconcile.
- Under-budget credit carries to next cycle.
- Over-budget generates supplemental invoice.
- Final cycle splits 50/50 correctly.
- Cycle report shows full breakdown.

**Done when:** The full cost-plus billing loop works — the most complex financial workflow in the system.

---

### Sprint 12: Client Portal
**Duration:** ~2 weeks
**Dependencies:** Sprint 9 (invoices/payments), Sprint 8 (photos), Sprint 6 (jobs)

**Deliverables:**
1. Portal routing: `https://portal.homesolutionsar.com/p/{portal_token}`.
2. Portal landing page: CHS branding, project overview, quick stats (contract total, paid, remaining, next payment).
3. Standard portal tabs: Photos, Schedule, Invoices & Payments, Change Orders, Documents, Messages.
4. Photos tab: chronological timeline from photo capture, tap to enlarge.
5. Schedule tab: upcoming/completed work.
6. Invoices tab: all invoices with status, pay now button, payment history.
7. Payment page in portal: check vs. electronic, 3.5% convenience fee, Stripe form.
8. Change Orders tab: view, sign digitally.
9. Documents tab: contracts, permits, plans.
10. Messages tab: threaded messaging between client and contractor.
11. Cost-plus portal enhancements: Budget & Costs tab with mini-budget breakdown, real-time actuals, cycle reconciliation.
12. Mobile-responsive: portal works perfectly on phone (primary client access method).

**Tests:**
- Client accesses portal via secure link, sees correct project data.
- Photo timeline updates as new photos are captured.
- Client pays invoice through portal with correct fee.
- Client signs change order digitally.
- Cost-plus client sees full financial transparency.
- Portal messaging creates communication records.

**Done when:** Clients can access their project portal, view everything, pay invoices, and sign documents.

---

### Sprint 13: Change Orders, Permits, Scheduling & Warranty
**Duration:** ~1.5 weeks
**Dependencies:** Sprint 12 (portal for signatures), Sprint 6 (jobs)

**Deliverables:**
1. Change order CRUD: `POST/GET/PUT /api/jobs/:id/change-orders`.
2. Change order creation from mobile (on-site).
3. Change order delivery and digital signature flow (client portal).
4. Auto-update job budget, tasks, and billing on CO approval.
5. Change order generation from Smart Notes ("client wants ceiling fan added").
6. Permit CRUD: `POST/GET/PUT /api/jobs/:id/permits`. Inspection tracking and reminders.
7. Schedule entry CRUD: `POST/GET/PUT /api/jobs/:id/schedule`. Day-by-day trade scheduling.
8. Calendar view across all jobs (day/week/month).
9. Sub scheduling notifications via Twilio (auto-text when scheduled).
10. Warranty CRUD: `POST/GET/PUT /api/jobs/:id/warranties`. Claim tracking and resolution.
11. Warranty certificate generation from template.
12. 11-month warranty reminder notification.

**Tests:**
- Change order created on mobile → sent → signed → budget updated.
- Smart Note triggers CO creation with pre-filled data.
- Permit inspection reminder fires correctly.
- Sub receives schedule notification with job details.
- 11-month warranty reminder fires at correct date.

**Done when:** All job lifecycle features work: change orders, permits, scheduling, warranties.

---

## Phase 3 — Integrations & Advanced (Sprints 14-18)

External integrations, document management, social media, and polish.

---

### Sprint 14: QuickBooks Online & WC Spreadsheet Enhancements
**Duration:** ~1.5 weeks
**Dependencies:** Sprint 10 (financial data complete)

**Deliverables:**
1. QuickBooks Online OAuth flow in system settings.
2. QBO two-way sync: invoices, payments, expenses push to QBO.
3. QBO category mapping configuration.
4. QBO sync failure handling (dead-letter queue).
5. WC Spreadsheet full integration: all data points from Estimating + Job Management + Financial.
6. CPA-ready annual tax export (CSV/PDF with IRS categories, 1099 flagging, mileage totals).
7. Lien waiver CRUD with document generation from template.

**Tests:**
- Invoice created in CHS appears in QBO.
- Payment in CHS updates QBO invoice status.
- Expense in CHS creates QBO transaction.
- WC Spreadsheet reflects all metrics within 30-minute sync window.
- CPA export includes all tax-relevant data.

**Done when:** Accounting is automated. QBO is in sync. Tax prep is one-click.

---

### Sprint 15: Document Management & Templates
**Duration:** ~1 week
**Dependencies:** Sprint 6 (jobs), Sprint 12 (portal)

**Deliverables:**
1. Document CRUD: `POST/GET/PUT /api/documents`.
2. Job file organization (virtual folders by category).
3. Document template manager in settings: create, edit, version, activate/deactivate.
4. Template auto-population with merge fields from job/client/estimate data.
5. Google Drive mirror (carry forward from chs-hub, extend to new document types).
6. Shareable file links with time-limited tokens.
7. Company document storage (SOPs, insurance, licenses, W-9s).
8. Hub Files browser with search across all documents.
9. Job completion package auto-compilation.

**Tests:**
- Document uploads to R2, mirrors to Google Drive.
- Template generates document with all merge fields populated.
- Shareable link works for 7 days then expires.
- Completion package compiles correct documents, photos, and financials.

**Done when:** All files are organized, templated, searchable, and shareable.

---

### Sprint 16: Social Media Engine
**Duration:** ~1.5 weeks
**Dependencies:** Sprint 8 (photos with social-ready flagging)

**Deliverables:**
1. Social post CRUD: `POST/GET/PUT /api/social-posts`.
2. Monthly content schedule generator (Claude AI).
3. Job completion post auto-generation with before/after photos.
4. AI caption and hashtag generation (Claude API).
5. AI image generation for non-job posts (Replicate/Flux Pro).
6. Approval queue with swipe-to-approve on mobile.
7. Content calendar view (month view, color-coded by type).
8. Facebook and Instagram publishing via Graph API.
9. Published post history with platform links.
10. Post editor: edit caption, regenerate, change timing.

**Tests:**
- Monthly schedule generates appropriate mix of content.
- Job completion post uses social-ready photos with AI caption.
- Approval → publish flow works for both platforms.
- Failed publish retries 3x then marks as failed.

**Done when:** Social media runs semi-autonomously: AI generates, user approves, system publishes.

---

### Sprint 17: System Admin & Multi-User Foundation
**Duration:** ~1 week
**Dependencies:** Sprint 1 (auth), all other sprints stable

**Deliverables:**
1. System settings page (Owner only): Company, Financial, Integrations, Notifications, Users, Backup, Health.
2. Integration connection cards with connect/disconnect/test.
3. User management: add user → assign role → send invite → onboard.
4. Role-based access control enforcement on all API routes and UI elements.
5. Audit log viewer with filters and CSV export.
6. Dead-letter queue viewer with retry/dismiss.
7. Notification preference management (per-user, per-client opt-outs).
8. Backup status dashboard and manual backup trigger.
9. System health: heartbeat status, cron job status, integration sync status.

**Tests:**
- Non-owner roles see only permitted data (PM can't see profit margins, field crew can't see financials).
- New user receives invite, logs in, sees role-appropriate UI.
- Audit log captures all CRUD operations with user and timestamp.
- DLQ items can be retried and dismissed.

**Done when:** The platform is ready for multiple users with proper access control.

---

### Sprint 18: Capacitor App & Polish
**Duration:** ~2 weeks
**Dependencies:** All features stable

**Deliverables:**
1. Capacitor project setup (iOS + Android).
2. Native camera plugin integration.
3. Native GPS plugin integration.
4. Push notifications (FCM for Android, APNS for iOS).
5. App Store submission (iOS TestFlight + Google Play internal testing).
6. Before/after photo comparison view (slider).
7. Photo annotations and markup tools.
8. Photo report PDF generation.
9. Project packet generation.
10. Performance optimization and load testing.
11. End-to-end testing of full lifecycle: lead → estimate → job → invoice → payment → completion → social post.

**Tests:**
- App installs from TestFlight / internal testing.
- Push notifications deliver on both platforms.
- Camera and GPS work via native plugins.
- Full lifecycle test passes with zero manual workarounds.

**Done when:** App Store ready. Full platform operational.

---

## Dependency Graph (Visual Summary)

```
Sprint 1: Schema + Auth
    │
    ├──► Sprint 2: Clients + Subs
    │       │
    │       ├──► Sprint 3: Estimate Pipeline + HL Integration
    │       │       │
    │       │       ├──► Sprint 4: Estimate Builder
    │       │       │       │
    │       │       │       ├──► Sprint 5: Quote Delivery + Stripe
    │       │       │       │       │
    │       │       │       │       ├──► Sprint 6: Quote-to-Job + Job Pipeline
    │       │       │       │       │       │
    │       │       │       │       │       ├──► Sprint 7: Notifications + Comms
    │       │       │       │       │       │
    │       │       │       │       │       ├──► Sprint 8: Photos + Smart Notes
    │       │       │       │       │       │       │
    │       │       │       │       │       │       ├──► Sprint 10: Expenses + Job Costing
    │       │       │       │       │       │       │       │
    │       │       │       │       │       │       │       ├──► Sprint 11: Cost-Plus Engine
    │       │       │       │       │       │       │       │
    │       │       │       │       │       │       │       └──► Sprint 14: QBO + WC Spreadsheet
    │       │       │       │       │       │       │
    │       │       │       │       │       │       └──► Sprint 16: Social Media
    │       │       │       │       │       │
    │       │       │       │       │       ├──► Sprint 9: Invoices + Payments
    │       │       │       │       │       │       │
    │       │       │       │       │       │       └──► Sprint 12: Client Portal
    │       │       │       │       │       │               │
    │       │       │       │       │       │               └──► Sprint 13: COs + Permits + Scheduling
    │       │       │       │       │       │
    │       │       │       │       │       └──► Sprint 15: Document Management
    │       │       │       │       │
    │       │       │       │       └──► Sprint 17: System Admin + RBAC
    │       │       │       │
    │       │       │       └──► Sprint 18: Capacitor App + Polish
```

---

## Timeline Estimate

| Phase | Sprints | Est. Duration | Cumulative |
|-------|---------|---------------|------------|
| Phase 1 — Foundation | 1-8 | 10-12 weeks | 12 weeks |
| Phase 2 — Financial & Portal | 9-13 | 8-10 weeks | 22 weeks |
| Phase 3 — Integrations & Advanced | 14-18 | 7-8 weeks | 30 weeks |

**Total estimated build: 25-30 weeks (~6-7 months)**

This assumes Cursor handles coding with Claude handling specs, docs, and SOPs. Parallel work is possible in some sprints (e.g., Sprint 8 and Sprint 9 can overlap since they share the job dependency but don't depend on each other).

---

## Risk Items & Notes

1. **Stripe integration** is the most critical external dependency. Test in Stripe Test Mode throughout development. Switch to live only after full lifecycle testing.
2. **Cost-plus billing engine** (Sprint 11) is the most complex single feature. No existing tool does this — it's entirely custom logic. Budget extra time.
3. **QuickBooks OAuth** (Sprint 14) has historically been finicky. Budget time for token refresh handling and sync edge cases.
4. **Capacitor app submission** (Sprint 18) has Apple review lead times. Submit to TestFlight early and iterate.
5. **Existing chs-hub data** must be preserved throughout all migrations. Every migration should be additive (new tables, new columns) — never destructive to existing data.
6. **WC Spreadsheet sync** is a carry-forward pattern. Maintain the existing 30-minute cycle and cell range targeting — never modify formulas or formatting in the sheet.

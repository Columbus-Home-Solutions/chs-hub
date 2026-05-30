# Module Spec: Job Management
## CHS Construction Management Platform
### Version 1.2 — May 29, 2026

---

## 1. Purpose

Job Management is the backbone of the CHS platform. Every other module connects to it. This module replaces Jobber entirely as the system of record for all active jobs — from the moment a client signs and pays their deposit through final closeout. It owns the job lifecycle, task tracking, scheduling, daily logging, change orders, and coordinates with Financial Management, Estimating, Photo Capture, Client Portal, and Notifications.

**Important boundary:** The pre-job pipeline (lead intake, estimate appointments, quote creation/delivery, quote follow-ups) lives in the **Estimating & Quoting** module. A job is only created in this module when the client has committed — contract signed, deposit paid. This keeps the job pipeline clean and focused on active work.

---

## 2. Job Lifecycle & Statuses

A job moves through these statuses in order. Each status change triggers downstream actions (notifications, WC spreadsheet updates, social media prompts, etc.).

```
Deposit Paid → Scheduled → In Progress → Punch List → Complete → Closed
```

**Note:** Everything before "Deposit Paid" — leads, estimate appointments, quote creation, quote delivery, and follow-ups — lives in the Estimating & Quoting module. When a client signs their contract and pays the deposit, the quote-to-job conversion fires and creates the job here.

### Status Definitions

**Deposit Paid**
The client has signed the contract and paid the required deposit. The job has just been created via quote-to-job conversion and is waiting to be scheduled.
- Trigger: Quote-to-job conversion from the Estimating module when deposit payment is received.
- WC Spreadsheet: Closed deal count increments. New Sales dollar value logged.
- Notification: Payment receipt sent to client.
- Auto: Budget is set from estimate, task groups auto-generate from estimate line items, billing schedule is configured based on selected billing model. Portal is activated with secure link.

**Scheduled**
The job has start and end dates assigned, with specific trades/work scheduled on specific days.
- Trigger: User assigns start date and populates the day-by-day schedule.
- Notification: "Welcome aboard — here's your project portal link" sent after scheduling is complete. "Work starts tomorrow" notification sent the night before the start date.
- Auto: Sub scheduling notifications sent to assigned subcontractors.

**In Progress**
Active construction is happening. Photos, notes, expenses, and time entries are being captured daily. Tasks are being completed. For cost-plus jobs, bi-weekly billing cycles are running.
- Trigger: Start date is reached, or user manually moves to In Progress.
- Notification: Weekly photo summaries sent to client. Cost-plus cycle reports sent bi-weekly.
- Auto: Daily log entries are expected. Photo capture is active.

**Punch List**
Primary construction is complete. Outstanding items need to be addressed before final closeout.
- Trigger: User moves job to Punch List status.
- Auto: Punch list checklist is generated (can be pre-populated from template or created manually). Each punch item supports photo attachment.

**Complete**
All work is finished and the final walkthrough is done.
- Trigger: All punch list items are checked off, or user manually moves to Complete.
- Notification: Final invoice sent. Job completion package auto-compiled and emailed to client. Google review request sent.
- Auto: Social media post prompt — system suggests before/after photos and drafts a caption for approval.
- WC Spreadsheet: Job revenue, expenses, and profit logged.

**Closed**
Final payment received. Job is fully settled and archived.
- Trigger: All invoices are paid in full.
- Notification: 30-day follow-up scheduled. 11-month warranty reminder scheduled.
- Auto: Job data feeds into profitability insights and historical cost analysis.

### Status Rules

- Jobs are only created via quote-to-job conversion. There is no manual job creation outside of the Estimating pipeline.
- Jobs can only move forward in the pipeline, not backward, except: In Progress can return to Scheduled (job paused/weather delay), and Complete can return to Punch List (new items found).
- Any status change is logged in the activity/audit trail with timestamp and user.
- Status changes trigger the WC Spreadsheet sync within the next sync cycle (currently 30 minutes, carry forward from chs-hub).

---

## 3. Data Model

### Job Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | Primary key |
| job_number | integer | auto | Auto-incrementing, human-readable (e.g., JOB-001) |
| title | text | yes | Short descriptive name (e.g., "Maxwell Garage Conversion") |
| status | enum | yes | "deposit_paid", "scheduled", "in_progress", "punch_list", "complete", "closed" |
| billing_model | enum | yes | "fixed_price", "trade_by_trade", or "cost_plus" |
| client_id | UUID | yes | FK to clients table |
| property_address | text | yes | Where the work happens (may differ from client mailing address) |
| property_city | text | yes | |
| property_state | text | yes | Default: "Arkansas" |
| property_zip | text | yes | |
| job_type | text | yes | Tag: new_build, addition, remodel, garage_conversion, deck, handyman, roofing, etc. |
| lead_source | text | no | How the lead came in: direct_call, google_lsa, thumbtack, website, referral, repeat_client |
| estimate_id | UUID | yes | FK to estimates table (linked at job creation via quote-to-job conversion) |
| start_date | date | no | When work begins |
| target_end_date | date | no | Projected completion |
| actual_end_date | date | no | When work actually finished |
| contract_total | decimal | no | Total contract value (from approved estimate) |
| total_invoiced | decimal | computed | Sum of all invoices |
| total_paid | decimal | computed | Sum of all payments received |
| total_expenses | decimal | computed | Sum of all logged expenses (materials + subs + labor) |
| profit | decimal | computed | total_paid - total_expenses |
| profit_margin | decimal | computed | profit / total_paid as percentage |
| deposit_amount | decimal | no | Required deposit amount |
| deposit_paid | boolean | no | Whether deposit has been received |
| portal_token | text | auto | Unique secure token for client portal access |
| portal_type | enum | auto | "standard" or "cost_plus" — derived from billing_model |
| notes | text | no | General notes about the job |
| warranty_expiration | date | computed | actual_end_date + 1 year |
| created_at | datetime | auto | |
| updated_at | datetime | auto | |
| created_by | text | auto | User who created the job |

### Task Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | |
| job_id | UUID | yes | FK to jobs table |
| task_group | text | yes | Trade/phase name matching estimate line item (e.g., "Framing", "Electrical") |
| task_group_order | integer | yes | Display order of the group (matches estimate line item order) |
| title | text | yes | Specific task description |
| status | enum | yes | "pending", "in_progress", "complete", "skipped" |
| assigned_to | text | no | Sub name or crew member |
| scheduled_date | date | no | What day this task is planned for |
| completed_date | datetime | no | When marked complete |
| completed_by | text | no | Who marked it complete |
| notes | text | no | |
| sort_order | integer | yes | Display order within the group |
| is_punch_list | boolean | no | Whether this is a punch list item |
| photo_ids | text | no | Comma-separated photo IDs attached to this task |
| created_at | datetime | auto | |

### Daily Log Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | |
| job_id | UUID | yes | FK to jobs table |
| log_date | date | yes | |
| weather | text | no | Weather conditions noted |
| work_performed | text | yes | What happened today |
| issues | text | no | Problems encountered |
| materials_used | text | no | Materials consumed |
| crew_on_site | text | no | Who was working |
| hours_worked | decimal | no | Total hours on site |
| photo_ids | text | no | Photos taken today |
| entered_via | enum | yes | "web", "mobile", "voice" |
| created_at | datetime | auto | |
| created_by | text | auto | |

### Change Order Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | |
| job_id | UUID | yes | FK to jobs table |
| change_order_number | integer | auto | Sequential per job (CO-1, CO-2, etc.) |
| title | text | yes | Short description |
| description | text | yes | Detailed scope of change |
| amount | decimal | yes | Cost impact (positive = addition, negative = credit) |
| status | enum | yes | "draft", "sent", "approved", "rejected" |
| requested_date | datetime | auto | When created |
| approved_date | datetime | no | When client signed |
| client_signature | text | no | Digital signature data |
| triggered_by_note_id | UUID | no | If created from a Smart Note |
| created_by | text | auto | |
| created_at | datetime | auto | |

### Schedule Entry Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | |
| job_id | UUID | yes | FK to jobs table |
| scheduled_date | date | yes | |
| trade_or_work | text | yes | What's happening (e.g., "Framing crew", "Electrician rough-in") |
| sub_id | UUID | no | FK to subcontractors table if a sub is assigned |
| start_time | time | no | Expected start |
| end_time | time | no | Expected end |
| notes | text | no | Special instructions |
| notification_sent | boolean | no | Whether sub was notified |
| status | enum | yes | "scheduled", "in_progress", "completed", "cancelled", "weather_delay" |
| created_at | datetime | auto | |

### Permit Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | |
| job_id | UUID | yes | FK to jobs table |
| permit_type | text | yes | "building", "electrical", "plumbing", "mechanical", "demo", etc. |
| permit_number | text | no | Issued permit number |
| status | enum | yes | "applied", "approved", "inspection_scheduled", "passed", "failed", "closed" |
| applied_date | date | no | |
| approved_date | date | no | |
| inspection_date | datetime | no | |
| inspection_result | text | no | Pass/fail + notes |
| cost | decimal | no | Permit fees |
| document_id | UUID | no | FK to stored permit document |
| notes | text | no | |
| created_at | datetime | auto | |

### Warranty Record

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| id | UUID | auto | |
| job_id | UUID | yes | FK to jobs table |
| claim_date | date | yes | When the client reported the issue |
| description | text | yes | What the warranty claim is about |
| status | enum | yes | "reported", "scheduled", "resolved" |
| resolution | text | no | How it was resolved |
| resolved_date | date | no | |
| cost | decimal | no | Cost to resolve (should be $0 if under warranty) |
| photo_ids | text | no | Photos of the issue |
| created_at | datetime | auto | |

---

## 4. Core Workflows

### 4.1 Job Creation Flow

Jobs are created exclusively through the **quote-to-job conversion** in the Estimating & Quoting module. There is no "New Job" button that creates a job directly. The pipeline works like this:

**The handoff from Estimating:**
1. A lead comes in (direct call, Google LSA/High Level, Thumbtack, website).
2. The lead is managed through the Estimating module's request pipeline — client created, estimate appointment set, on-site visit, estimate built and sent.
3. Client reviews the estimate + service agreement + payment schedule via secure link.
4. Client signs the contract and pays the deposit.
5. **Quote-to-job conversion fires automatically:**
   - A new job record is created in "Deposit Paid" status.
   - Client, property address, job type, and lead source carry over from the estimate request.
   - Budget baseline is set from the approved estimate (parent items = client price, sub-items = internal costs).
   - Task groups are auto-generated from estimate parent line items.
   - Billing schedule is configured based on the selected billing model.
   - Client portal is activated — secure link generated, portal type set based on billing model.
   - WC Spreadsheet: Closed deal count and New Sales dollar value update on next sync cycle.
6. The job now appears on the Job Pipeline Board in "Deposit Paid" status, ready to be scheduled.

**Why no direct job creation?**
- Every job should have an estimate behind it — this ensures budget tracking, job costing, and profitability analysis work correctly.
- The pre-job pipeline (leads, appointments, quotes) is a fundamentally different workflow than active job management. Keeping them separate keeps both clean.
- Lead/quote metrics for the WC Spreadsheet are tracked in the Estimating module, not here.

### 4.2 Quote-to-Job Conversion (Detail)

This is the bridge between the Estimating module and Job Management. When a client approves and pays the deposit, the system automatically:

1. Creates a new job record in "Deposit Paid" status.
2. Links the approved estimate to the job.
3. Auto-generates task groups from estimate parent line items:
   - Estimate line item "Framing — $13,904" becomes task group "Framing."
   - Each task group gets a default checklist that can be customized.
4. Sets budget baseline from estimate totals — each line item's sub-item costs become the job costing baseline.
5. Configures billing schedule based on the selected billing model:
   - **Fixed price:** Milestone invoice schedule created (e.g., 33/33/34).
   - **Trade-by-trade:** Invoice triggers linked to task group completion.
   - **Cost-plus:** First mini-budget period defined, first bi-weekly invoice generated.
6. Activates client portal — secure link generated, portal type set based on billing model.
7. Copies client, property, job type, and lead source data from the estimate request record.

**Implementation: one shared, idempotent function (Sprint 6 requirement).**

The conversion must be a single function — `convertEstimateToJob(estimateRequestId)` — called by **both** triggers that can mark a request Won:
- The **manual Won** path (drag/"Mark as Won" modal — built in Sprint 4, see Estimating §4.10).
- The **Stripe deposit** webhook (built in Sprint 5).

It must be **idempotent**: on entry, check whether a job already exists for the estimate request and no-op (return the existing job) if so. This is required because the manual Won path in Sprint 4/5 already writes the job row + `portal_token` ahead of the full engine. Without the guard, a request manually won before Sprint 6 would get a second job when any later path runs. One source of truth, two callers, safe to call more than once.

**Sprint 4 partial-write reality (close the gap in Sprint 6):**
As of Sprint 4, the manual Won path writes only the `job` row + `portal_token` so the handoff is a pure read — it does NOT yet do steps 3–6 (task-group generation, budget baseline, billing schedule, portal activation). Sprint 6's `convertEstimateToJob()` owns the full sequence. When it runs against a request that was manually won earlier, the idempotency check should detect the bare job row and **complete** the deferred steps rather than skip entirely or duplicate — i.e. "job exists but is unconverted" is a distinct state from "fully converted." Decide the exact flag/state during Sprint 6 build (e.g. a `conversion_complete` boolean on the job).

### 4.3 Task Management

Tasks are organized by trade/phase groups that mirror the estimate structure.

**Task group hierarchy:**
```
Job: Maxwell Garage Conversion
├── Task Group: Garage Conversion (from estimate line item)
│   ├── Demo existing garage door ☐
│   ├── Demo drywall on adjacent walls ☐
│   ├── Frame new exterior wall ☐
│   ├── Install windows ☐
│   ├── Rough-in electrical ☐
│   └── ... (more tasks)
└── Task Group: Attic Insulation (from estimate line item)
    ├── Prep attic space ☐
    └── Blow in insulation ☐
```

**Task operations:**
- Add tasks to any group at any time.
- Reorder tasks within a group via drag-and-drop.
- Mark tasks complete with one tap (mobile-optimized).
- Attach photos to specific tasks.
- Add notes to tasks.
- Assign tasks to specific subs or crew members.
- Schedule tasks to specific dates.
- Bulk-complete all tasks in a group.

**Punch list tasks:**
- Created when job moves to "Punch List" status.
- Same task structure but flagged as `is_punch_list = true`.
- Each punch item must have at least one photo attached.
- All punch items must be complete before job can move to "Complete."

### 4.4 Smart Notes Integration

Carried forward from chs-hub. Notes captured via voice or text are processed by Claude for:
- **Categorization:** general, task, expense, change_order, scheduling, client_communication.
- **Task extraction:** "need to add outlets in bedroom 2" → creates a task suggestion.
- **Change order detection:** "client wants ceiling fan added, about $350" → prompts change order creation with pre-filled details.
- **Expense routing:** "picked up drywall screws at Lowe's, $47" → creates expense entry suggestion linked to the job.
- **Summarization:** Long voice notes are summarized for quick review.

Notes are linked to jobs via `job_id`. General notes (no job context) remain as standalone entries.

### 4.5 Change Order Flow

1. **Create:** User creates change order from mobile (on site) or desktop. Can be triggered from a Smart Note. Enter title, description, and cost impact.
2. **Price:** System can suggest pricing based on material cost database and labor rates if available.
3. **Send:** Change order is sent to client via email or portal link with digital signature field.
4. **Approve:** Client signs digitally. Change order status moves to "approved."
5. **Auto-update:** Approved change order automatically:
   - Adds the dollar amount to the job's contract total.
   - Creates new task(s) in the appropriate task group.
   - Updates the billing schedule if applicable.
   - Logs in the activity trail.
   - Extends the target end date if specified.

### 4.6 Scheduling

**Day-by-day scheduling:**
- Each job has a schedule grid showing every day from start_date to target_end_date.
- User assigns trades/work to specific days: "Monday 6/2: Framing crew. Thursday 6/5: Electrician rough-in."
- Schedule entries link to subcontractors from the sub reference list.
- When a schedule entry is created or modified with a sub assigned, the system can auto-notify the sub via text/email with: job address, date, time, and any special notes.

**Calendar views:**
- Day view: What's happening today across all jobs.
- Week view: All jobs and scheduled work for the week.
- Month view: High-level overview of all active jobs.
- Per-job view: Timeline showing all scheduled work for a single job.

### 4.7 Daily Logs

Quick-capture for end-of-day field reporting:
- What work was performed today.
- Any issues or problems.
- Materials used.
- Crew/subs on site.
- Hours worked.
- Weather conditions.
- Link to photos taken that day (auto-populated from photo capture timestamps).

Entry methods:
- Manual text entry from mobile or desktop.
- Voice-to-text dictation.
- Smart Notes can auto-populate daily log fields based on note categorization throughout the day.

### 4.8 Sub Coordination

Extends the existing chs-hub subcontractor reference list:
- Assign subs to specific schedule entries.
- Auto-notify subs when scheduled: text/email with job address, date, time, notes.
- Track sub status per job: scheduled, confirmed, on_site, completed.
- Record sub costs per job for job costing.
- Flag sub payments for 1099 reporting in CPA export.

### 4.9 Repeat Client Detection

When creating a new job or client:
- System searches existing clients by name, phone number, email, and property address.
- If a match is found, display the full client history: past jobs, total revenue, photos, notes, last interaction date.
- User can select the existing client (linking the new job to their history) or confirm this is a new client.
- Repeat clients are flagged in reporting for referral and retention tracking.

---

## 5. Screen Descriptions

### 5.1 Job Pipeline Board (Desktop)

Visual Kanban-style board showing all jobs by status. Each column is a lifecycle stage. Job cards show:
- Job title and number
- Client name
- Property address
- Contract value
- Days in current status
- Photo count badge
- Overdue indicator (if applicable)

Drag-and-drop to move jobs between statuses (respecting status rules).
Filter by: job type, date range, billing model.
Sort by: date created, contract value, status age.

### 5.2 Job Pipeline Board (Mobile)

Horizontal swipe between status columns. Tap a job card to open the job detail view. Floating action button for "New Job" always accessible.

### 5.3 Job Detail View

Tabbed interface showing:
- **Overview:** Status, client info, property, dates, financials summary, billing model.
- **Tasks:** Task groups with checklists. Tap to complete. Add new tasks inline.
- **Schedule:** Day-by-day schedule grid. Add/edit schedule entries.
- **Photos:** Photo timeline (from Photo Capture module). Tap to enlarge.
- **Notes:** Smart Notes linked to this job. Voice capture button.
- **Financial:** Budget vs. actual by line item. Invoices, payments, expenses. (Pulls from Financial Management module.)
- **Documents:** Contracts, change orders, permits, plans. (Pulls from Document Management module.)
- **Daily Logs:** Chronological log entries.
- **Change Orders:** List of all change orders with status.
- **Permits:** Permit and inspection tracking.
- **Activity:** Full audit trail of all actions on this job.

### 5.4 Quick Capture Bar (Mobile)

Persistent bottom bar on mobile when viewing a job, with one-tap access to:
- 📷 Take Photo (opens camera, auto-links to current job)
- 🎤 Voice Note (opens Smart Notes voice capture)
- ✅ Quick Task (add a task to any group)
- 💵 Log Expense (open receipt capture)
- 📝 Daily Log (quick daily entry)

### 5.5 Schedule Calendar

Full calendar view across all jobs. Color-coded by job. Click a day to see all scheduled work. Click a schedule entry to edit. Drag to reschedule.

---

## 6. Business Rules

1. A job is only created via quote-to-job conversion from the Estimating module. Every job has an approved estimate behind it.
2. A job's billing model is set at creation (derived from the estimate) and cannot be changed after the first invoice is generated.
3. Task groups are auto-generated from estimate line items during quote-to-job conversion. Additional task groups can be added manually at any time.
4. Change orders require client digital signature before they affect the job budget or task list.
5. The deposit amount and payment schedule are derived from the billing model and estimate total.
6. For fixed price jobs: deposit = first milestone amount (typically 33% of total).
7. For cost-plus jobs: deposit = $1,000 (per billing agreement).
8. Portal type is automatically determined by billing model: cost_plus → "cost_plus" portal, all others → "standard" portal.
9. A job cannot move to "Complete" status while punch list items remain open.
10. A job cannot move to "Closed" status while unpaid invoices remain.
11. Every status change triggers a WC Spreadsheet data point update on the next sync cycle.
12. Late fees ($50/day) are auto-calculated on invoices past the due date per contract terms.
13. Warranty expiration is calculated as actual_end_date + 365 days. The 11-month reminder is triggered at actual_end_date + 335 days.

---

## 7. Inter-Module Connections

### → Financial Management
- Job costing: budget (from estimate) vs. actuals (from expenses, time entries, sub payments).
- Invoice generation tied to billing model and job status.
- Cost-plus billing engine runs against job data (mini-budgets, expense tracking, reconciliation).
- Expense receipts captured via Photo module are categorized and linked to job line items.
- Time entries generate labor costs at configured rates ($90/hr, $105/hr).
- WC Spreadsheet auto-sync reads job data for weekly/monthly reporting.

### → Estimating & Quoting
- The Estimating module owns the entire pre-job pipeline: lead intake, estimate appointments, quote creation/delivery, and follow-ups.
- Quote-to-job conversion is the single entry point for creating jobs in this module.
- Estimate structure (parent items + sub-items) defines the job's task groups and budget baseline.
- Historical job cost data feeds back into estimating for improved accuracy.
- WC Spreadsheet data for leads, appointments, and quotes sent are triggered from the Estimating module, not Job Management.

### → Client Management & Portal
- Each job links to a client record.
- Portal access is generated per job with a unique secure link.
- Portal view adapts based on billing model (standard vs. cost-plus).
- Client communication history is logged at the client level, visible from the job.

### → Photo Capture System
- Photos are linked to jobs, tasks, and daily logs.
- Photo timeline feeds the client portal.
- Before/after photos feed the social media module and job completion package.
- Receipt photos feed the expense tracking system.

### → Document Management
- Contracts, change orders, permits, and plans are stored per job.
- Document templates auto-populate with job and client data.
- Job completion package compiles all documents at closeout.

### → Social Media & Marketing
- Job completion triggers a social media post suggestion.
- Before/after photos are flagged as "social ready."
- Job type and scope feed into caption generation.

### → Automated Notifications
- Every status change can trigger one or more notifications.
- Notification recipients, channels (email, SMS, in-app, push), and timing are configurable.
- Sub scheduling notifications are triggered by schedule entry creation.

### → System & Administration
- All job actions are logged in the activity/audit trail.
- Role-based access determines what each user can see and do on a job.
- Data backup includes all job records.

---

## 8. Migration from chs-hub

### What carries forward as-is:
- Smart Notes API and Claude processing pipeline.
- HighLevel lead pipeline integration (PIT proxy, Kanban with drag-to-update write-back).
- WC Spreadsheet auto-sync pattern (30-minute cycle).
- Subcontractor reference list and CRUD.
- Photo capture PWA (CHS Capture) and R2 storage.
- Reliability subsystem (heartbeat, DLQ, nightly backup, daily summary).
- Cloudflare Access authentication.

### What changes:
- Jobber sync is removed entirely — no more GraphQL polling. The platform IS the data source.
- Job creation becomes native via quote-to-job conversion (not direct CRUD — all jobs flow from approved estimates).
- The pre-job pipeline (leads, appointments, quotes) is handled by the Estimating & Quoting module, not Job Management.
- Invoice creation becomes native instead of reading Jobber invoices.
- The D1 schema expands significantly (tasks, schedule entries, change orders, permits, warranties, daily logs).
- The dashboard frontend evolves from a read-mostly dashboard to a full CRUD application.

### Data migration:
- Existing job data in D1 (imported from Jobber) can be preserved as historical records.
- New jobs going forward are created natively.
- Historical Jobber data does not need to be re-imported — it exists in D1 already from the sync.
- Client data from Jobber imports remains and becomes the seed for the native client database.

---

## 9. Technical Notes for Cursor

### Stack (carry forward from chs-hub):
- Backend: Cloudflare Workers (TypeScript)
- Database: Cloudflare D1 (SQLite)
- File Storage: Cloudflare R2
- Frontend: HTML/CSS/JS served from Cloudflare Pages (vanilla, no framework — matches existing chs-hub pattern)
- PWA: Existing CHS Capture PWA pattern for mobile experience
- Native App: Capacitor wrapper for App Store deployment (iOS/Android)

### API patterns (match existing chs-hub conventions):
- RESTful routes under `/api/`
- JSON request/response
- Cloudflare Access for authentication
- `Cf-Access-Authenticated-User-Email` header for user identification
- Consistent error response format: `{ error: string, details?: string }`

### D1 migration naming:
- Continue the existing migration sequence (currently at 0011+).
- One migration file per logical change.
- Always test with `npm run db:migrate:remote` after deployment.

### Mobile-first design:
- All screens must work on phone, tablet, and desktop.
- Touch targets minimum 44x44px.
- Quick capture flows optimized for one-handed phone use.
- Offline capability for core capture functions (photos, notes, expenses) — existing IndexedDB + Background Sync pattern.

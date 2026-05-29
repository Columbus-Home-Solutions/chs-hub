# Module Spec: Dashboard & Home Screen
## CHS Construction Management Platform
### Version 1.0 — May 29, 2026

---

## 1. Purpose

The Dashboard is the first screen Tony sees when he opens the app. It answers the morning question: "What needs my attention today?" Everything on this screen is actionable or informational — no dead links, no decoration. It pulls real-time data from every module and presents it in a scannable layout that works equally well on a desktop monitor at the office and a phone screen on the job site.

**Design principle:** The current chs-hub dashboard is a link launcher with read-only KPI tiles and embedded external tools. The new dashboard is a command center — every widget connects to native functionality. Jobber is gone, so "Quick Launch" links to external tools are replaced by native module entry points in the sidebar navigation. The dashboard content area is reserved for data, alerts, and actions.

---

## 2. Layout Architecture

### 2.1 Desktop (1024px+)

The dashboard follows the standard App Shell from the Design System: sidebar nav on the left (240px), top nav bar (56px), and the main content area fills the remainder.

The dashboard content area uses a two-column layout:

```
┌──────────────────────────────────────────────────────────┐
│  Top Nav (56px)     [CHS Logo]    [🔔 3]  [Tony ▾]      │
├──────┬───────────────────────────────────────────────────┤
│      │  ┌─────────────────────────────────────────────┐  │
│ Side │  │  KPI Tiles (horizontal strip, full width)   │  │
│ Nav  │  └─────────────────────────────────────────────┘  │
│      │  ┌──────────────────────┐ ┌──────────────────┐   │
│  🏗️  │  │                      │ │                  │   │
│ Jobs │  │  Primary Column      │ │  Secondary Col   │   │
│      │  │  (~60% width)        │ │  (~40% width)    │   │
│  📋  │  │                      │ │                  │   │
│ Est  │  │  - Action Items      │ │  - Smart Notes   │   │
│      │  │  - Pipeline Summary  │ │  - Today Sched   │   │
│  💰  │  │  - Lead Pipeline     │ │  - Recent Act.   │   │
│ Fin  │  │                      │ │                  │   │
│      │  │                      │ │                  │   │
│  👥  │  └──────────────────────┘ └──────────────────┘   │
│ Cli  │                                                   │
│      │                                                   │
│  📸  │                                                   │
│Photo │                                                   │
│      │                                                   │
│  📄  │                                                   │
│ Docs │                                                   │
│      │                                                   │
│  📱  │                                                   │
│Social│                                                   │
│      │                                                   │
│  ⚙️  │                                                   │
│Admin │                                                   │
├──────┴───────────────────────────────────────────────────┤
```

### 2.2 Mobile (<768px)

No sidebar. Bottom tab navigation (5 tabs: Dashboard, Jobs, Estimates, Money, More). The dashboard content stacks vertically in a single scrollable column:

```
┌──────────────────────┐
│ Top Nav   [🔔] [≡]  │
├──────────────────────┤
│ KPI Tiles (2x2 grid) │
│ [swipe for more]     │
├──────────────────────┤
│ Action Items         │
├──────────────────────┤
│ Smart Notes          │
├──────────────────────┤
│ Today's Schedule     │
├──────────────────────┤
│ Pipeline Summary     │
├──────────────────────┤
│ Lead Pipeline (mini) │
├──────────────────────┤
│ Recent Activity      │
├──────────────────────┤
│                      │
├──────────────────────┤
│ 🏠  🏗️  📋  💰  ••• │
│ Home Jobs Est  Money More│
└──────────────────────┘
```

### 2.3 Tablet (768–1023px)

Collapsible sidebar (icon-only when collapsed). Dashboard content uses the same two-column layout as desktop but with narrower columns.

---

## 3. Sidebar Navigation

The sidebar replaces the old "Quick Launch" link grid. Every item navigates to a native module within the platform.

### Primary Navigation Items

| Icon | Label | Route | Description |
|------|-------|-------|-------------|
| 🏠 | Dashboard | `/` | Home screen (this spec) |
| 🏗️ | Jobs | `/jobs` | Job pipeline board + job list |
| 📋 | Estimates | `/estimates` | Estimate pipeline board + request list |
| 💰 | Financial | `/financial` | Financial dashboard, invoices, expenses |
| 👥 | Clients | `/clients` | Client list + detail views |
| 📸 | Photos | `/photos` | Photo library across all jobs |
| 📄 | Documents | `/documents` | Document library + templates |
| 📱 | Social | `/social` | Social media content calendar + queue |

### Utility Navigation (bottom of sidebar)

| Icon | Label | Route | Description |
|------|-------|-------|-------------|
| ⚙️ | Settings | `/settings` | System settings, integrations, user management |
| 🔗 | External Links | (expandable) | Quick links to High Level, Google Business, WC Spreadsheet, etc. |

### External Links (collapsed by default)

These are the surviving "Quick Launch" items — external tools that CHS integrates with but doesn't replace. They open in new tabs.

| Link | URL |
|------|-----|
| High Level CRM | HL dashboard URL |
| Google Business Profile | GBP dashboard |
| Google Local Services | LSA dashboard |
| WC Spreadsheet | Google Sheets link |
| QuickBooks Online | QBO dashboard |
| Facebook Business | Meta Business Suite |
| Instagram | Instagram business |

This list is configurable in system settings. Tony can add, remove, or reorder links.

### Mobile Bottom Tab Bar

Five tabs on mobile (matches the most-used navigation paths):

| Position | Icon | Label | Route |
|----------|------|-------|-------|
| 1 | 🏠 | Home | `/` |
| 2 | 🏗️ | Jobs | `/jobs` |
| 3 | 📋 | Estimates | `/estimates` |
| 4 | 💰 | Money | `/financial` |
| 5 | ••• | More | Slide-up menu with all other nav items |

---

## 4. KPI Tiles

A horizontal strip of key metrics across the top of the dashboard. These are the numbers Tony glances at to know how the business is doing.

### Desktop: 6 tiles in a row, full width

### Mobile: 2x2 grid with horizontal swipe for remaining tiles

### Tile Definitions

| # | Title | Value | Subtitle | Source | Tap Action |
|---|-------|-------|----------|--------|------------|
| 1 | Jobs In Progress | Count of jobs with status "in_progress" | Dollar value of those contracts | Job Management | Navigate to Jobs filtered by "In Progress" |
| 2 | Quotes Outstanding | Dollar sum of sent but unsigned estimates | Count of open estimates | Estimating | Navigate to Estimate Pipeline filtered by "Sent" |
| 3 | Unpaid Invoices | Dollar total of unpaid invoices | Count + aging indicator (e.g., "2 past due") | Financial | Navigate to Financial → Invoices filtered by unpaid |
| 4 | Cash This Week | Payments received this week (Sun–Sat) | vs. prior week (↑12% or ↓8%) | Financial | Navigate to Financial → Payments |
| 5 | YTD Revenue | Total payments received year-to-date | YTD Expenses below in muted text | Financial | Navigate to Financial Dashboard |
| 6 | YTD Profit | Revenue minus expenses year-to-date | Profit margin % | Financial | Navigate to Financial Dashboard |

### Tile Visual Design

Each tile follows the existing KPI card pattern from chs-hub (icon + big number + label + subtitle) but adapted to the new design system:

- Background: `var(--color-surface-raised)`
- Title: `var(--color-text-muted)`, small caps, `--font-size-xs`
- Value: `var(--color-text-primary)`, bold, `--font-size-xl`
- Subtitle: `var(--color-text-secondary)`, `--font-size-sm`
- Positive delta: `var(--color-success)` with ↑ arrow
- Negative delta: `var(--color-error)` with ↓ arrow
- Tap: entire tile is clickable, navigates to detail view

---

## 5. Dashboard Widgets

### 5.1 Action Items (Primary Column)

The most important widget. Shows things that need Tony's attention right now, sorted by urgency. Each item is tappable and navigates directly to where the action needs to happen.

**Action item sources:**

| Priority | Icon | Action Item | Trigger | Tap Destination |
|----------|------|------------|---------|-----------------|
| 🔴 High | 💰 | Invoice past due: {client} — {amount} ({days} days) | Invoice status = "past_due" | Invoice detail |
| 🔴 High | 📋 | Quote follow-up due: {client} | Follow-up reminder triggered, not yet acted on | Estimate request detail |
| 🟡 Medium | 💰 | Invoice due in 2 days: {client} — {amount} | Invoice due date is 2 days away | Invoice detail |
| 🟡 Medium | 🏗️ | Cost-plus cycle ending: {job} — reconcile by {date} | Billing cycle end date within 2 days | Job Financial tab → cycle |
| 🟡 Medium | 📋 | New lead: {name} — {source} | Estimate request created, not yet contacted | Request detail |
| 🟡 Medium | 🏗️ | Job budget alert: {job} — {line item} over by {%} | Actuals exceed budget by >10% on any line item | Job Financial tab |
| 🟢 Low | 📱 | Social post ready for approval: {caption preview} | Post generated, awaiting approval | Social post approval |
| 🟢 Low | 📄 | Change order pending signature: {job} — {title} | CO sent, not yet signed | Change order detail |
| 🟢 Low | 🏗️ | Warranty reminder: {job} — 11-month check-in | 335 days since job completion | Job detail |

**Display rules:**
- Maximum 8 items shown. "View all ({count})" link at the bottom if more exist.
- Red items always sort to top. Then yellow. Then green.
- Within each priority, sort by age (oldest first — longest unaddressed items surface).
- Items auto-clear when the triggering condition is resolved (e.g., invoice gets paid).
- Empty state: "All clear — nothing needs your attention right now." with a checkmark icon.

### 5.2 Pipeline Summary (Primary Column)

A compact snapshot of the full business pipeline from lead to cash. Shows counts at each stage so Tony can see bottlenecks at a glance.

```
Lead Pipeline                    Job Pipeline
───────────────                  ───────────────
New Leads        ██████  6       Deposit Paid     ██   2
Contacted        ███    3       Scheduled        ███  3
Appt Set         ██     2       In Progress      ██   2
Estimate Sent    ████   4       Punch List       █    1
                                 Complete         █    1
Conversion: 42%                  Unpaid: $12,400
```

**Desktop:** Two side-by-side mini pipeline visualizations (lead pipeline on left, job pipeline on right).

**Mobile:** Stacked vertically with horizontal bar indicators.

Each stage label is tappable — navigates to the relevant pipeline board filtered to that status.

### 5.3 Lead Pipeline (Primary Column — Desktop Only)

The HL Kanban board carried forward from chs-hub. On desktop, this shows a condensed version of the lead pipeline with the most recent leads visible. On mobile, this section is replaced by the Pipeline Summary (5.2) since the full Kanban doesn't work well on a narrow screen.

- Columns: New Lead → Contacted/Follow → Appointment Set → Create Estimate → Estimate Sent/FYP → Completed/Unpaid
- Lead cards show: phone number, source badge, age
- Drag-and-drop between columns with HL write-back
- "View Full Pipeline" link navigates to `/estimates`

### 5.4 Smart Notes (Secondary Column)

Carried forward from chs-hub. Text input field with category dropdown and action buttons.

- Text area: "Write your notes here. Claude will summarize, extract tasks, and save everything automatically."
- Category dropdown: Job-linked (select job), General, Meeting Notes
- Buttons: "Process with Claude" (primary), "Import Meeting" (secondary), "Save Only" (tertiary)
- Below the input: last 3 processed notes with timestamp, summary preview, and extracted task count

### 5.5 Today's Schedule (Secondary Column)

A compact view of today's scheduled work across all jobs.

| Time | Job | Work |
|------|-----|------|
| 8:00 AM | Maxwell Garage | Framing crew |
| 10:00 AM | Johnson Addition | Electrician rough-in |
| 1:00 PM | — | Estimate appointment: Smith residence |

- Each row is tappable → navigates to the job detail schedule tab (or estimate request for appointments).
- Shows schedule entries from Job Management + estimate appointments from Estimating.
- "View Full Calendar" link navigates to the schedule calendar view.
- If no schedule entries today: "Nothing scheduled today" with a link to the calendar.

### 5.6 Recent Activity (Secondary Column)

The last 10 actions across the entire system, reverse chronological. Gives Tony a sense of what's been happening even when he hasn't been in the app.

**Activity types shown:**

| Icon | Activity |
|------|----------|
| 💰 | Payment received: {client} paid {amount} for {job} |
| 📋 | New lead: {name} from {source} |
| 📷 | Photos added: {count} photos on {job} |
| 🏗️ | Job status changed: {job} → {new status} |
| 📋 | Estimate sent: {client} — {amount} |
| ✅ | Task completed: {task} on {job} |
| 📝 | Smart Note processed: {summary preview} |
| 📄 | Change order approved: {job} — {title} |

Each item shows: icon, description, relative timestamp ("3 min ago", "2 hours ago", "Yesterday").

Tapping any item navigates to the relevant record.

"View full activity log" link at the bottom navigates to the System Admin audit trail.

---

## 6. Top Navigation Bar

### Desktop

| Left | Center | Right |
|------|--------|-------|
| CHS Logo (clickable → home) | — | 🔔 Notification bell (badge count) · Tony's name with dropdown |

**Notification bell:** Shows count of unread notifications. Clicking opens a dropdown panel with the most recent notifications. Each notification is tappable. "View all" link navigates to a full notifications page.

**User dropdown:** Account settings, theme toggle (future), sign out.

### Mobile

| Left | Right |
|------|-------|
| CHS Logo (clickable → home) | 🔔 Notification bell · ☰ Hamburger menu |

**Hamburger menu:** Slide-out panel with full navigation (all items from the sidebar), external links, and sign out.

---

## 7. Data Queries

The dashboard aggregates data from multiple modules on each page load. To keep the dashboard fast, these queries should run in parallel and the UI should render progressively (show each widget as its data arrives, not wait for all queries to complete).

### KPI Tile Queries

```sql
-- Jobs in progress
SELECT COUNT(*) as count, SUM(contract_total) as value
FROM jobs WHERE status = 'in_progress'

-- Quotes outstanding
SELECT COUNT(*) as count, SUM(total) as value
FROM estimates WHERE status = 'sent'

-- Unpaid invoices
SELECT COUNT(*) as count, SUM(total_due - COALESCE(paid_amount, 0)) as value,
       COUNT(*) FILTER (WHERE status = 'past_due') as past_due_count
FROM invoices WHERE status IN ('sent', 'viewed', 'partial', 'past_due')

-- Cash this week
SELECT SUM(amount) as value
FROM payments WHERE received_date >= :week_start AND received_date < :week_end

-- Cash prior week (for delta calculation)
SELECT SUM(amount) as value
FROM payments WHERE received_date >= :prior_week_start AND received_date < :prior_week_end

-- YTD revenue
SELECT SUM(amount) as revenue
FROM payments WHERE received_date >= :year_start

-- YTD expenses
SELECT SUM(amount) as expenses FROM expenses WHERE incurred_date >= :year_start
UNION ALL
SELECT SUM(stripe_fee) FROM payments WHERE received_date >= :year_start AND stripe_fee > 0
```

### Action Items Query

Action items are computed, not stored. The dashboard API endpoint runs multiple queries and merges the results:

```
GET /api/dashboard/action-items

Returns: [
  { priority: "high", type: "invoice_past_due", title: "...", meta: {...}, link: "/financial/invoices/123" },
  { priority: "medium", type: "new_lead", title: "...", meta: {...}, link: "/estimates/requests/456" },
  ...
]
```

### Pipeline Summary Query

```sql
-- Lead pipeline counts
SELECT status, COUNT(*) as count
FROM estimate_requests WHERE status NOT IN ('converted', 'lost', 'cancelled')
GROUP BY status

-- Job pipeline counts
SELECT status, COUNT(*) as count
FROM jobs WHERE status NOT IN ('closed')
GROUP BY status

-- Conversion rate (this week)
SELECT
  COUNT(*) FILTER (WHERE status = 'converted') as converted,
  COUNT(*) as total
FROM estimate_requests WHERE created_at >= :week_start

-- Unpaid total across active jobs
SELECT SUM(total_due - COALESCE(paid_amount, 0)) as unpaid
FROM invoices WHERE status IN ('sent', 'viewed', 'partial', 'past_due')
```

### Today's Schedule Query

```sql
SELECT se.*, j.title as job_title, j.job_number
FROM schedule_entries se
JOIN jobs j ON se.job_id = j.id
WHERE se.scheduled_date = :today
ORDER BY se.start_time ASC

UNION ALL

SELECT er.appointment_date, er.appointment_time, c.first_name, c.last_name, er.property_address
FROM estimate_requests er
JOIN clients c ON er.client_id = c.id
WHERE DATE(er.appointment_date) = :today
ORDER BY er.appointment_time ASC
```

### Recent Activity Query

```sql
SELECT * FROM audit_log
ORDER BY created_at DESC
LIMIT 10
```

The audit log already captures all system actions with the action type, entity reference, user, and timestamp.

---

## 8. API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/dashboard/kpis` | All 6 KPI tile values in one response |
| GET | `/api/dashboard/action-items` | Computed action items sorted by priority |
| GET | `/api/dashboard/pipeline-summary` | Lead + job pipeline stage counts |
| GET | `/api/dashboard/schedule-today` | Today's schedule entries + estimate appointments |
| GET | `/api/dashboard/recent-activity` | Last 10 audit log entries |

All endpoints return JSON. The frontend makes all 5 calls in parallel on page load. Each widget renders independently as its data arrives.

**Caching:** KPI values and pipeline summary can be cached for 5 minutes (they don't change second-to-second). Action items, schedule, and activity should be fresh on every load.

---

## 9. Business Rules

1. The dashboard is the default landing page for all authenticated users. There is no separate "home page" — `/` is the dashboard.
2. KPI tiles always show current data (no date picker, no historical view on the dashboard — that lives in the Financial module's dashboards).
3. Action items are computed on each page load, not stored. This means they always reflect the current state of the system.
4. The "Cash This Week" tile uses the same Sunday–Saturday week boundary as the WC Spreadsheet.
5. The "YTD" metrics reset on January 1 of each year.
6. The Lead Pipeline widget (HL Kanban) uses the existing PIT proxy pattern for HL data. Drag-and-drop writes back to HL on drop.
7. Smart Notes processing is asynchronous — the user submits text, gets an immediate "Processing..." indicator, and the result appears when Claude returns.
8. The dashboard does not replace module-specific dashboards (e.g., the Financial Dashboard has deeper financial analytics). The home screen shows the summary; module screens show the detail.
9. External links in the sidebar open in new browser tabs, not within the app frame.
10. The notification bell count reflects unread notifications from the Notifications module. Clicking a notification marks it as read and navigates to the relevant record.

---

## 10. Responsive Behavior

### What changes between breakpoints:

| Widget | Desktop (1024px+) | Tablet (768–1023px) | Mobile (<768px) |
|--------|-------------------|---------------------|-----------------|
| KPI Tiles | 6 tiles in a row | 3 tiles per row, 2 rows | 2x2 grid + swipe |
| Action Items | Full list, primary column | Full list, full width | Full list, stacked |
| Pipeline Summary | Two side-by-side pipelines | Two side-by-side, narrower | Stacked vertically |
| Lead Pipeline (Kanban) | Visible, condensed | Visible, condensed | Hidden (use Pipeline Summary instead) |
| Smart Notes | Secondary column | Below action items, full width | Stacked in scroll |
| Today's Schedule | Secondary column | Below Smart Notes | Stacked in scroll |
| Recent Activity | Secondary column | Below schedule | Stacked in scroll |
| Sidebar | Always visible (240px) | Collapsible (icons only) | Hidden (bottom tab bar instead) |

### Mobile-specific optimizations:

- KPI tiles support horizontal swipe when more than 4 tiles exist.
- Action items show a max of 5 on mobile (vs. 8 on desktop) with "View all" link.
- Touch targets are minimum 44x44px per the design system.
- Pull-to-refresh reloads all dashboard data.

---

## 11. Inter-Module Connections

### ← Job Management
- Jobs in progress count and contract values for KPI tile.
- Job pipeline stage counts for Pipeline Summary.
- Schedule entries for Today's Schedule.
- Job status changes feed Recent Activity.
- Job budget alerts feed Action Items.

### ← Estimating & Quoting
- Quotes outstanding count and values for KPI tile.
- Lead pipeline stage counts for Pipeline Summary.
- Estimate request data for Lead Pipeline Kanban.
- New lead and quote sent events feed Recent Activity and Action Items.
- Follow-up reminders feed Action Items.
- Estimate appointments feed Today's Schedule.

### ← Financial Management
- Unpaid invoices, cash collected, YTD revenue/profit for KPI tiles.
- Past-due and upcoming invoices feed Action Items.
- Cost-plus cycle deadlines feed Action Items.
- Payment received events feed Recent Activity.

### ← Client Management & Portal
- Client names and contact info display on action items, leads, and schedule.
- High Level lead data powers the Lead Pipeline Kanban widget.

### ← Photo Capture
- Photo upload events feed Recent Activity.

### ← Social Media
- Posts awaiting approval feed Action Items.

### ← Notifications
- Unread notification count powers the bell badge in the top nav.
- Notification dropdown shows recent notifications.

### ← System & Administration
- Audit log powers Recent Activity.
- System health alerts could surface in Action Items (future).

---

## 12. Migration from chs-hub

### What carries forward:
- KPI tile pattern (top horizontal strip with icon + value + label).
- Smart Notes widget (text input + category + Process with Claude).
- Lead Pipeline Kanban (HL PIT proxy with drag-and-drop write-back).
- Business Pulse concept (becomes the KPI tiles + Pipeline Summary).
- Calendar concept (becomes Today's Schedule widget).
- Task Manager concept (becomes Action Items widget).

### What goes away:
- Quick Launch link grid (replaced by sidebar navigation to native modules).
- External tool links in the main content area (moved to collapsible "External Links" section at bottom of sidebar).
- Meetings widget (meetings are handled externally; coaching meetings can go in calendar if Google Calendar is connected).
- Local Map widget (was a nice-to-have, doesn't justify the screen real estate in the new layout).
- Business Bills links (moved to External Links in sidebar or removed entirely if not used regularly).
- Content Creation tool links (social media has its own native module now).

### What's new:
- Action Items widget with prioritized, tappable alerts.
- Pipeline Summary with visual stage counts.
- Today's Schedule showing cross-job and cross-module appointments.
- Recent Activity feed.
- Progressive loading (each widget renders independently).
- Responsive layout that actually works on mobile (current chs-hub dashboard is desktop-focused).

---

## 13. Technical Notes for Cursor

### Dashboard API pattern:

The dashboard should have a single parent route (`/api/dashboard`) with sub-routes for each widget. This keeps the dashboard data modular — the frontend can fetch widgets in parallel and render progressively.

```
GET /api/dashboard/kpis          → { tiles: [...] }
GET /api/dashboard/action-items  → { items: [...] }
GET /api/dashboard/pipeline      → { leads: {...}, jobs: {...} }
GET /api/dashboard/schedule      → { entries: [...] }
GET /api/dashboard/activity      → { entries: [...] }
```

### Frontend component structure:

```
views/Dashboard.tsx
  ├── KpiTiles.tsx           (horizontal strip)
  ├── ActionItems.tsx        (primary column)
  ├── PipelineSummary.tsx    (primary column)
  ├── LeadPipeline.tsx       (primary column, desktop only)
  ├── SmartNotes.tsx         (secondary column, carry forward)
  ├── TodaySchedule.tsx      (secondary column)
  └── RecentActivity.tsx     (secondary column)
```

Each component manages its own data fetching via `useApi` hook. Loading states show skeleton placeholders. Error states show a retry button.

### Performance target:

Dashboard should be interactive within 2 seconds on a desktop connection and 4 seconds on a mobile 4G connection. KPI tiles should render first (smallest query), followed by other widgets as their data arrives. No widget should block another.

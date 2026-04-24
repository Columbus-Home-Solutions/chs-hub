# Phase 6b-ui — Session Plan

**Date:** 2026-04-24
**Status:** Ready to execute after break

---

## Context

After phase 6b-data (Jobber sync + KPI API), the new Worker-backed dashboard needs to be stood up to replace the existing Apps Script-driven `chs-dashboard/index.html`. KPIs are already correct and matching Jobber to the penny (YTD collections $132,922.38, YTD expenses $24,643.06 / 90 items).

The user's explicit constraint: **keep the existing dashboard layout exactly as-is.** The existing burgundy/gold aesthetic, glass-card design, mobile bottom-nav, and section organization stay untouched. Changes are swap-in-place or additive only.

## Decisions locked in

| Decision | Value |
|---|---|
| Cloudflare Access policy | `tony@homesolutionsar.com` only for now; role scaffolding built-in from day one so crew/admin roles can be added later without refactor |
| Theme/layout | Existing dashboard preserved exactly |
| KPI tile swap | Replace "Yearly Gross Revenue" with **"YTD Profit / Margin %"** dual-stat tile (gross as subtext) |
| Additional KPI tile | Add 7th tile: **"Pipeline $"** = sum of open/awaiting-response quotes |
| Ads platform coverage | All three: Google LSA, Google Ads, Meta — scaffolded now, activate on demand |
| Ruled out | Unpaid invoice reminders (Jobber handles), Jobber→Calendar sync (Google Cal already linked), expense auto-categorizer (done in Jobber UI) |

## Session 6b-ui-core — Today

Goal: kill Apps Script dependency, dashboard runs entirely on Cloudflare stack.

### Scope

1. **API routes** on the Worker:
   - Extend `/api/kpis` to include: `jobs_in_progress`, `unpaid_invoices_total`, `payments_scheduled_total`, `pipeline_dollars`, `ytd_profit_margin_pct`
   - Add `/api/jobs/summary` for quick-overview table (for later 6f, but scaffolded now)

2. **Static dashboard** at `dash.homesolutionsar.com` (or `/dashboard` path on chs-hub Worker):
   - Port `chs-dashboard/index.html` 1:1 in layout
   - Rewire every KPI and section to hit the new Worker APIs instead of Apps Script
   - Remove Google Sheets-specific kludges (the "🔧 Fix Sheet" button on Smart Notes can go; Smart Notes UI stays, backend gets stubbed until 6d)

3. **Cloudflare Access policy**:
   - Lock `dash.homesolutionsar.com` to `tony@homesolutionsar.com`
   - Add role scaffolding: every sensitive component checks `env.USER_ROLE === 'owner'` (always true for now, but baked in)

4. **Polish items**:
   - Skeleton shimmers replace all spinners
   - "Last synced X min ago" freshness badges on each card (soft amber if stale >30 min)
   - IndexedDB cache for offline mode — dashboard renders last good payload when offline
   - KPI tile swap: Yearly Gross → YTD Profit / Margin %
   - Add 7th tile: Pipeline $

5. **Retire**:
   - Apps Script web app (stop polling it from any surface)
   - Old `chs-dashboard` repo becomes archived

### Acceptance criteria

- Dashboard loads in <300ms globally (edge-served)
- All 7 KPI tiles populate with correct D1-sourced numbers
- Offline mode works (airplane mode test)
- Skeleton loaders visible on first paint, replaced smoothly by real data
- Freshness badge shows sync age correctly
- No Apps Script calls in network tab

## Session 6b-ui-plus — Today (after core)

Goal: add interactivity on top of the migrated dashboard.

### Scope

1. **Drill-down modals** on every KPI tile:
   - YTD Profit → month-by-month sparkline + margin trend
   - Unpaid Invoices → list with amount/days-past-due, deep-link to Jobber
   - Jobs In Progress → list with customer, start date, status
   - Pipeline $ → list of open quotes with age
   - Each modal uses existing burgundy/gold theme

2. **Cmd+K command palette**:
   - "unpaid" → jump to Unpaid modal
   - "new note" → open Smart Notes editor
   - "add lead" → open Kanban new-card flow
   - "job #123" → jump to specific job detail

3. **Kanban auto-promotion**:
   - On Jobber sync, quote status changes move cards automatically
   - Manual drag still works for purely in-UI lanes

4. **Auto-refresh every 30s when tab is visible** (visibility API gated, pauses when backgrounded)

### Acceptance criteria

- Tap/click every KPI tile opens a relevant modal with real drill-down data
- `Cmd+K` / `Ctrl+K` opens palette from anywhere
- Kanban reflects Jobber state changes within one sync cycle
- Tab left open all day doesn't drain battery (paused when backgrounded)

## Session 6c — Tomorrow

Morning Brief: Claude generates 3-sentence daily summary at 6am, lands on dashboard above KPI strip, optionally SMS to owner.

## Full roadmap (reference)

1. 6b-ui-core — dashboard migration ← **today**
2. 6b-ui-plus — interactivity ← **today**
3. 6c — Morning Brief ← **tomorrow**
4. 6d — Smart Notes AI intake (voice memo + photo OCR via Claude)
5. 6e — Anomaly alerts + Quote-to-social
6. 6f — Jobs View + WC Export button (retires Job_Tracker workbook)
7. 6g — KBPI Auto-Fill Phase 1 (~70% from D1)
8. 6h — Google LSA + Business Profile (reviews + LSA leads/spend)
9. 6i — Google Ads integration (scaffold, activate when user runs ads)
10. 6j — Meta Marketing integration (scaffold, activate on first FB campaign)

## Pre-flight checklist (when user is back)

- [ ] Confirm `.env` still has valid `JOBBER_REFRESH_TOKEN` (if not, run `npm run jobber:oauth`)
- [ ] Worker is deployed and `https://chs-hub.tony-bc5.workers.dev/api/kpis` returns data
- [ ] Cloudflare dashboard available for setting up Access policy
- [ ] User has Cloudflare account admin access to add subdomain `dash.homesolutionsar.com`

## Files to touch in 6b-ui-core (tentative)

- `src/routes/kpis.ts` — extend with jobs_in_progress, unpaid, pipeline, margin fields
- `src/routes/jobs.ts` *(new)* — `/api/jobs/summary` endpoint
- `src/index.ts` — wire new route
- `dashboard/index.html` *(new, ported from chs-dashboard)* — the single-page dashboard
- `dashboard/app.js` *(new)* — fetches APIs, renders, offline cache
- `dashboard/styles.css` *(ported)* — existing theme preserved exactly
- `wrangler.toml` — add route for `dash.homesolutionsar.com`
- Cloudflare Access policy config (via dashboard or `wrangler`)

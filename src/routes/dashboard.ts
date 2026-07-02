/**
 * Dashboard API routes (Sprint 14).
 *
 *   GET /api/dashboard/kpis           → { tiles: KpiTile[] }           5-min cache
 *   GET /api/dashboard/action-items   → { items: ActionItem[] }         fresh
 *   PATCH /api/dashboard/action-items/:id/dismiss → { ok: true }        owner/admin
 *   GET /api/dashboard/pipeline       → { leads, jobs, conversionRate, unpaidTotal }  5-min cache
 *   GET /api/dashboard/schedule       → { entries: ScheduleEntry[] }    fresh
 *   GET /api/dashboard/activity       → { entries: ActivityEntry[], bellCount: number } fresh
 *
 * Role: O/PM/OA (enforced by RBAC middleware in index.ts).
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { buildJobCosting, computeYtdEarnedRevenue, computeYtdOperatingCosts, jobCogsOnly } from "../lib/job-costing.js";
import { handleDashboardMeetings } from "./google-calendar.js";

const DISMISSED_SETTING_KEY = "dashboard_dismissed_action_items";
const DISMISS_ROLES = ["owner", "office_admin"] as const;

// ── helpers ────────────────────────────────────────────────────────────────

function json(body: unknown, init: ResponseInit = {}): Response {
  const h = new Headers(init.headers);
  h.set("content-type", "application/json; charset=utf-8");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers: h });
}

/** Persist dismissed action-item ids in system_settings (no migration). */
async function loadDismissedIds(env: Env): Promise<Set<string>> {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = ?")
    .bind(DISMISSED_SETTING_KEY)
    .first<{ value: string }>();
  if (!row?.value) return new Set();
  try {
    const parsed = JSON.parse(row.value) as string[];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

async function saveDismissedIds(env: Env, ids: Set<string>): Promise<void> {
  const value = JSON.stringify([...ids]);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO system_settings (key, value, value_type, category, label, description, updated_at)
     VALUES (?, ?, 'string', 'dashboard', 'Dismissed action items', 'User-dismissed dashboard alerts', datetime('now'))`,
  )
    .bind(DISMISSED_SETTING_KEY, value)
    .run();
}

function actionItemLink(type: string, meta: Record<string, unknown>): string {
  switch (type) {
    case "invoice_past_due":
      return "/financial?tab=invoices&filter=overdue";
    case "invoice_due_soon":
      return "/financial?tab=invoices&filter=due_soon";
    case "social_approval":
      return "/social?tab=queue";
    case "new_lead":
      return "/estimating?status=new_request";
    case "follow_up_due":
      return "/estimating?status=follow_up";
    case "cost_plus_cycle":
    case "job_budget_alert":
    case "change_order_pending":
    case "warranty_checkin":
    case "lien_waiver_sent":
    case "completion_package_ready":
      return meta.jobId ? `/jobs/${meta.jobId}/completion-package` : "/jobs";
    case "punch_list_item_done":
    case "punch_list_complete":
      return meta.jobId ? `/jobs/${meta.jobId}?tab=punch_list` : "/jobs";
    case "voice_note_unmatched":
      return "/voice-notes/unmatched";
    default:
      return meta.jobId ? `/jobs/${meta.jobId}` : "/";
  }
}

/** ISO date for today in UTC ("YYYY-MM-DD"). */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Sunday-start week boundaries (ISO strings). */
function currentWeekRange(now = new Date()): { start: string; end: string; prevStart: string; prevEnd: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const dow = now.getUTCDay(); // 0 = Sunday
  const weekStart = new Date(Date.UTC(y, m, d - dow));
  const weekEnd = new Date(Date.UTC(y, m, d - dow + 7));
  const prevStart = new Date(Date.UTC(y, m, d - dow - 7));
  const prevEnd = weekStart;
  return {
    start: weekStart.toISOString().slice(0, 10),
    end: weekEnd.toISOString().slice(0, 10),
    prevStart: prevStart.toISOString().slice(0, 10),
    prevEnd: prevEnd.toISOString().slice(0, 10),
  };
}

/** Jan 1 of current year (ISO date string). */
function yearStart(): string {
  return `${new Date().getUTCFullYear()}-01-01`;
}

function formatCompactUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}

function formatYtdCogsSubtitle(costs: Awaited<ReturnType<typeof computeYtdOperatingCosts>>): string {
  const parts: string[] = [];
  if (costs.expenses > 0) parts.push(`${formatCompactUsd(costs.expenses)} expenses`);
  if (costs.labor_from_time > 0) parts.push(`${formatCompactUsd(costs.labor_from_time)} labor`);
  if (costs.stripe_fees > 0) parts.push(`${formatCompactUsd(costs.stripe_fees)} fees`);
  if (parts.length === 0) return "Log expenses & time to track COGS";
  return `${parts.join(" · ")} COGS`;
}

// ── In-memory caches (5-minute TTL) ──────────────────────────────────────

interface Cached<T> { data: T; expiresAt: number }
const kpiCache = new Map<string, Cached<unknown>>();
const pipelineCache = new Map<string, Cached<unknown>>();
const CACHE_TTL_MS = 5 * 60 * 1_000;

function cacheGet<T>(map: Map<string, Cached<unknown>>, key: string): T | null {
  const c = map.get(key);
  if (!c || c.expiresAt < Date.now()) return null;
  return c.data as T;
}
function cacheSet<T>(map: Map<string, Cached<unknown>>, key: string, data: T): void {
  map.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── KPI handler ───────────────────────────────────────────────────────────

interface KpiTile {
  id: string;
  label: string;
  value: number | string;
  subtitle: string;
  link: string;
  deltaDir?: "up" | "down" | null;
  deltaPct?: number | null;
}

export async function handleDashboardKpis(env: Env): Promise<Response> {
  const cached = cacheGet<{ tiles: KpiTile[] }>(kpiCache, "kpis");
  if (cached) return json(cached);

  const now = new Date();
  const week = currentWeekRange(now);
  const ys = yearStart();

  const [
    jobsRow,
    quotesRow,
    invoicesRow,
    cashWeekRow,
    cashPrevRow,
    ytdRevenueRow,
    ytdCosts,
    ytdEarnedRevenue,
  ] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) as cnt, COALESCE(SUM(contract_total), 0) as total FROM jobs WHERE status = 'in_progress'"
    ).first<{ cnt: number; total: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) as cnt, COALESCE(SUM(total), 0) as total FROM estimates WHERE status = 'sent'"
    ).first<{ cnt: number; total: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) as cnt,
              COALESCE(SUM(total_due - COALESCE(paid_amount, 0)), 0) as total,
              COUNT(*) FILTER (WHERE status = 'past_due') as past_due_count
       FROM invoices WHERE status IN ('sent', 'viewed', 'partial', 'past_due')`
    ).first<{ cnt: number; total: number; past_due_count: number }>(),
    env.DB.prepare(
      // Exclude payments on voided invoices from revenue KPIs.
      `SELECT COALESCE(SUM(p.amount), 0) as total
         FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
        WHERE (p.invoice_id IS NULL OR i.status != 'void')
          AND p.received_date >= ? AND p.received_date < ?`
    ).bind(week.start, week.end).first<{ total: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(p.amount), 0) as total
         FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
        WHERE (p.invoice_id IS NULL OR i.status != 'void')
          AND p.received_date >= ? AND p.received_date < ?`
    ).bind(week.prevStart, week.prevEnd).first<{ total: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(p.amount), 0) as revenue
         FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
        WHERE (p.invoice_id IS NULL OR i.status != 'void')
          AND p.received_date >= ?`
    ).bind(ys).first<{ revenue: number }>(),
    computeYtdOperatingCosts(env, ys),
    computeYtdEarnedRevenue(env, ys),
  ]);

  const cashThis = cashWeekRow?.total ?? 0;
  const cashPrev = cashPrevRow?.total ?? 0;
  let deltaDir: "up" | "down" | null = null;
  let deltaPct: number | null = null;
  if (cashPrev > 0) {
    deltaPct = Math.round(((cashThis - cashPrev) / cashPrev) * 100);
    deltaDir = deltaPct >= 0 ? "up" : "down";
    deltaPct = Math.abs(deltaPct);
  }

  const ytdRevenue = ytdRevenueRow?.revenue ?? 0;
  const ytdCogs = ytdCosts.total_cogs;
  const ytdJobCogs = jobCogsOnly(ytdCosts);
  const ytdProfit = ytdRevenue - ytdCogs;
  const ytdMarginPct = ytdRevenue > 0 ? Math.round((ytdProfit / ytdRevenue) * 100) : 0;
  const ytdCogsSubtitle = formatYtdCogsSubtitle(ytdCosts);

  const ytdEarned = ytdEarnedRevenue ?? 0;
  const ytdEarnedProfit = ytdEarned - ytdJobCogs;
  const ytdEarnedMarginPct = ytdEarned > 0 ? Math.round((ytdEarnedProfit / ytdEarned) * 100) : 0;

  const pastDueCount = invoicesRow?.past_due_count ?? 0;
  const invoiceSubtitle = pastDueCount > 0
    ? `${invoicesRow?.cnt ?? 0} open · ${pastDueCount} past due`
    : `${invoicesRow?.cnt ?? 0} open`;

  const tiles: KpiTile[] = [
    {
      id: "jobs_in_progress",
      label: "Jobs In Progress",
      value: jobsRow?.cnt ?? 0,
      subtitle: `$${((jobsRow?.total ?? 0) / 1000).toFixed(0)}k in contracts`,
      link: "/jobs?status=in_progress",
    },
    {
      id: "quotes_outstanding",
      label: "Quotes Outstanding",
      value: `$${((quotesRow?.total ?? 0) / 1000).toFixed(0)}k`,
      subtitle: `${quotesRow?.cnt ?? 0} open estimates`,
      link: "/estimates",
    },
    {
      id: "unpaid_invoices",
      label: "Unpaid Invoices",
      value: `$${((invoicesRow?.total ?? 0) / 1000).toFixed(0)}k`,
      subtitle: invoiceSubtitle,
      link: "/financial?tab=invoices&filter=unpaid",
      deltaDir: pastDueCount > 0 ? "down" : null,
    },
    {
      id: "cash_this_week",
      label: "Cash This Week",
      value: `$${((cashThis) / 1000).toFixed(0)}k`,
      subtitle: deltaDir ? `${deltaDir === "up" ? "↑" : "↓"}${deltaPct}% vs. last week` : "vs. last week",
      link: "/financial?tab=invoices&filter=paid_this_week",
      deltaDir,
      deltaPct,
    },
    {
      id: "ytd_revenue",
      label: "YTD Collected",
      value: `$${(ytdRevenue / 1000).toFixed(0)}k`,
      subtitle: ytdCogsSubtitle,
      link: "/financial?tab=invoices&filter=paid",
    },
    {
      id: "ytd_profit",
      label: "Cash Profit",
      value: `$${(ytdProfit / 1000).toFixed(0)}k`,
      subtitle: `${ytdMarginPct}% margin on collections`,
      link: "",
      deltaDir: ytdProfit >= 0 ? "up" : "down",
    },
    {
      id: "ytd_earned_margin",
      label: "Earned Margin",
      value: `$${(ytdEarnedProfit / 1000).toFixed(0)}k`,
      subtitle: `${ytdEarnedMarginPct}% on $${(ytdEarned / 1000).toFixed(0)}k invoiced`,
      link: "",
      deltaDir: ytdEarnedProfit >= 0 ? "up" : "down",
    },
  ];

  const result = { tiles };
  cacheSet(kpiCache, "kpis", result);
  return json(result);
}

// ── Action items handler ──────────────────────────────────────────────────

interface ActionItem {
  id: string;
  priority: "high" | "medium" | "low";
  type: string;
  title: string;
  meta: Record<string, unknown>;
  link: string;
  createdAt: string;
}

/** Days between two ISO date strings. */
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

export async function handleDashboardActionItems(env: Env): Promise<Response> {
  const today = todayUtc();
  const dueSoonDate = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const dismissed = await loadDismissedIds(env);

  // All sub-queries run in parallel.
  const [
    pastDueInvoices,
    dueSoonInvoices,
    endingCycles,
    newLeads,
    followUpLeads,
    pendingSocial,
    pendingChangOrders,
    warrantyJobs,
    inProgressJobsWithEstimate,
    pendingWaivers,
    readyPackages,
    notifyPunchVoice,
  ] = await Promise.all([
    // HIGH: invoices past due
    env.DB.prepare(
      `SELECT i.id, i.job_id, i.due_date, i.total_due - COALESCE(i.paid_amount, 0) AS balance,
              c.first_name, c.last_name
       FROM invoices i
       JOIN clients c ON i.client_id = c.id
       WHERE i.status = 'past_due'
       ORDER BY i.due_date ASC LIMIT 10`
    ).all<{ id: string; job_id: string; due_date: string; balance: number; first_name: string; last_name: string }>(),

    // MEDIUM: invoices due in 2 days
    env.DB.prepare(
      `SELECT i.id, i.job_id, i.due_date, i.total_due - COALESCE(i.paid_amount, 0) AS balance,
              c.first_name, c.last_name
       FROM invoices i
       JOIN clients c ON i.client_id = c.id
       WHERE i.status IN ('sent','viewed','partial')
         AND i.due_date = ?
       ORDER BY i.due_date ASC LIMIT 10`,
    ).bind(dueSoonDate).all<{ id: string; job_id: string; due_date: string; balance: number; first_name: string; last_name: string }>(),

    // MEDIUM: billing cycles ending within 2 days
    env.DB.prepare(
      `SELECT bc.id, bc.job_id, bc.period_end, j.title as job_title
       FROM billing_cycles bc
       JOIN jobs j ON bc.job_id = j.id
       WHERE bc.status = 'active'
         AND bc.period_end <= ?
       ORDER BY bc.period_end ASC LIMIT 10`,
    ).bind(dueSoonDate).all<{ id: string; job_id: string; period_end: string; job_title: string }>(),

    // MEDIUM: new leads (last 7 days)
    env.DB.prepare(
      `SELECT er.id, c.first_name, c.last_name, er.lead_source, er.created_at
       FROM estimate_requests er
       JOIN clients c ON er.client_id = c.id
       WHERE er.status = 'new_request'
         AND er.created_at >= datetime('now', '-7 days')
       ORDER BY er.created_at ASC LIMIT 10`,
    ).all<{ id: string; first_name: string; last_name: string; lead_source: string; created_at: string }>(),

    // MEDIUM: follow-up due
    env.DB.prepare(
      `SELECT er.id, c.first_name, c.last_name, er.created_at
       FROM estimate_requests er
       JOIN clients c ON er.client_id = c.id
       WHERE er.status = 'follow_up'
       ORDER BY er.created_at ASC LIMIT 10`,
    ).all<{ id: string; first_name: string; last_name: string; created_at: string }>(),

    // LOW: social posts pending approval
    env.DB.prepare(
      `SELECT id, caption, created_at FROM social_posts
       WHERE status = 'pending_approval'
       ORDER BY created_at ASC LIMIT 5`,
    ).all<{ id: string; caption: string; created_at: string }>(),

    // LOW: change orders pending signature
    env.DB.prepare(
      `SELECT co.id, co.title, co.job_id, co.created_at, j.title as job_title
       FROM change_orders co
       JOIN jobs j ON co.job_id = j.id
       WHERE co.status = 'sent'
         AND co.client_signature IS NULL
       ORDER BY co.created_at ASC LIMIT 5`,
    ).all<{ id: string; title: string; job_id: string; created_at: string; job_title: string }>(),

    // LOW: warranty 11-month reminder (335–395 days post-completion)
    env.DB.prepare(
      `SELECT id, title, actual_end_date
       FROM jobs
       WHERE status = 'complete'
         AND actual_end_date <= date('now', '-335 days')
         AND actual_end_date >= date('now', '-395 days')
       ORDER BY actual_end_date ASC LIMIT 5`,
    ).all<{ id: string; title: string; actual_end_date: string }>(),

    // For budget alerts — in-progress jobs with an estimate
    env.DB.prepare(
      `SELECT id, title, estimate_id FROM jobs
       WHERE status = 'in_progress'
         AND estimate_id IS NOT NULL
       LIMIT 20`,
    ).all<{ id: string; title: string; estimate_id: string }>(),

    // MEDIUM: client lien waiver sent, awaiting signature
    env.DB.prepare(
      `SELECT j.id as job_id, j.title as job_title, clw.sent_at
         FROM client_lien_waivers clw
         JOIN jobs j ON j.id = clw.job_id
        WHERE clw.status = 'sent'
        ORDER BY clw.sent_at ASC
        LIMIT 10`,
    ).all<{ job_id: string; job_title: string; sent_at: string }>(),

    // HIGH: completion package ready to send
    env.DB.prepare(
      `SELECT j.id as job_id, j.title as job_title, clw.signed_at
         FROM client_lien_waivers clw
         JOIN jobs j ON j.id = clw.job_id
        WHERE clw.status = 'signed'
          AND (j.completion_package_sent_at IS NULL OR j.completion_package_sent_at = '')
        ORDER BY clw.signed_at ASC
        LIMIT 10`,
    ).all<{ job_id: string; job_title: string; signed_at: string }>(),

    // MEDIUM/HIGH: punch list + voice note in-app notifications (Sprint 33)
    env.DB.prepare(
      `SELECT id, trigger_event, body, job_id, created_at
         FROM notification_logs
        WHERE channel = 'in_app'
          AND trigger_event IN ('punch_list_item_done', 'punch_list_complete', 'voice_note_unmatched')
          AND status IN ('queued', 'sent', 'delivered')
          AND created_at >= datetime('now', '-14 days')
        ORDER BY created_at DESC
        LIMIT 15`,
    ).all<{ id: string; trigger_event: string; body: string; job_id: string | null; created_at: string }>(),
  ]);

  const items: ActionItem[] = [];

  // HIGH: invoice_past_due
  for (const inv of pastDueInvoices.results ?? []) {
    const clientName = `${inv.first_name ?? ""} ${inv.last_name ?? ""}`.trim();
    const days = inv.due_date ? daysBetween(inv.due_date, today) : 0;
    const amount = `$${Number(inv.balance).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    items.push({
      id: `invoice_past_due_${inv.id}`,
      priority: "high",
      type: "invoice_past_due",
      title: `Invoice past due: ${clientName} — ${amount} (${days} days)`,
      meta: { invoiceId: inv.id, jobId: inv.job_id, balance: inv.balance, days },
      link: actionItemLink("invoice_past_due", { jobId: inv.job_id }),
      createdAt: inv.due_date ?? today,
    });
  }

  // MEDIUM: invoice_due_soon
  for (const inv of dueSoonInvoices.results ?? []) {
    const clientName = `${inv.first_name ?? ""} ${inv.last_name ?? ""}`.trim();
    const amount = `$${Number(inv.balance).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    items.push({
      id: `invoice_due_soon_${inv.id}`,
      priority: "medium",
      type: "invoice_due_soon",
      title: `Invoice due in 2 days: ${clientName} — ${amount}`,
      meta: { invoiceId: inv.id, jobId: inv.job_id, balance: inv.balance },
      link: actionItemLink("invoice_due_soon", { jobId: inv.job_id }),
      createdAt: inv.due_date ?? today,
    });
  }

  // MEDIUM: cost_plus_cycle
  for (const cycle of endingCycles.results ?? []) {
    items.push({
      id: `cost_plus_cycle_${cycle.id}`,
      priority: "medium",
      type: "cost_plus_cycle",
      title: `Cost-plus cycle ending: ${cycle.job_title} — reconcile by ${cycle.period_end}`,
      meta: { cycleId: cycle.id, jobId: cycle.job_id, periodEnd: cycle.period_end },
      link: actionItemLink("cost_plus_cycle", { jobId: cycle.job_id }),
      createdAt: cycle.period_end,
    });
  }

  // MEDIUM: new_lead
  for (const lead of newLeads.results ?? []) {
    const clientName = `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim();
    items.push({
      id: `new_lead_${lead.id}`,
      priority: "medium",
      type: "new_lead",
      title: `New lead: ${clientName} — ${lead.lead_source ?? "unknown source"}`,
      meta: { requestId: lead.id, leadSource: lead.lead_source },
      link: actionItemLink("new_lead", {}),
      createdAt: lead.created_at,
    });
  }

  // MEDIUM: follow_up_due
  for (const lead of followUpLeads.results ?? []) {
    const clientName = `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim();
    items.push({
      id: `follow_up_due_${lead.id}`,
      priority: "medium",
      type: "follow_up_due",
      title: `Quote follow-up due: ${clientName}`,
      meta: { requestId: lead.id },
      link: actionItemLink("follow_up_due", {}),
      createdAt: lead.created_at,
    });
  }

  // MEDIUM: job_budget_alert — use buildJobCosting for each in-progress job
  // Capped to first 10 jobs to stay within budget on every dashboard load.
  const budgetJobs = (inProgressJobsWithEstimate.results ?? []).slice(0, 10);
  const budgetAlerts: ActionItem[] = [];
  await Promise.allSettled(
    budgetJobs.map(async (j) => {
      try {
        const costing = await buildJobCosting(env, j.id);
        if (!costing.has_budget) return;
        for (const line of costing.lines) {
          if (line.budget > 0 && line.actual > line.budget * 1.1) {
            const overPct = Math.round(((line.actual - line.budget) / line.budget) * 100);
            budgetAlerts.push({
              id: `job_budget_alert_${j.id}_${line.line_item_id}`,
              priority: "medium",
              type: "job_budget_alert",
              title: `Budget alert: ${j.title} — over on ${line.name} by ${overPct}%`,
              meta: { jobId: j.id, lineItemId: line.line_item_id, overPct },
              link: actionItemLink("job_budget_alert", { jobId: j.id }),
              createdAt: today,
            });
          }
        }
      } catch {
        // Per spec: budget alert failures must not crash other action items.
      }
    }),
  );
  items.push(...budgetAlerts);

  // HIGH: completion_package_ready
  for (const p of readyPackages.results ?? []) {
    items.push({
      id: `completion_package_ready_${p.job_id}`,
      priority: "high",
      type: "completion_package_ready",
      title: `Completion package ready to review and send: ${p.job_title}`,
      meta: { jobId: p.job_id },
      link: actionItemLink("completion_package_ready", { jobId: p.job_id }),
      createdAt: p.signed_at ?? today,
    });
  }

  // MEDIUM: lien_waiver_sent
  for (const w of pendingWaivers.results ?? []) {
    items.push({
      id: `lien_waiver_sent_${w.job_id}`,
      priority: "medium",
      type: "lien_waiver_sent",
      title: `Lien waiver sent — awaiting client signature: ${w.job_title}`,
      meta: { jobId: w.job_id },
      link: actionItemLink("lien_waiver_sent", { jobId: w.job_id }),
      createdAt: w.sent_at ?? today,
    });
  }

  // LOW: social_approval
  for (const post of pendingSocial.results ?? []) {
    const preview = (post.caption ?? "").slice(0, 60);
    items.push({
      id: `social_approval_${post.id}`,
      priority: "low",
      type: "social_approval",
      title: `Social post ready for approval: ${preview}${preview.length === 60 ? "…" : ""}`,
      meta: { postId: post.id },
      link: actionItemLink("social_approval", {}),
      createdAt: post.created_at,
    });
  }

  // LOW: change_order_pending
  for (const co of pendingChangOrders.results ?? []) {
    items.push({
      id: `change_order_pending_${co.id}`,
      priority: "low",
      type: "change_order_pending",
      title: `Change order pending signature: ${co.job_title} — ${co.title}`,
      meta: { changeOrderId: co.id, jobId: co.job_id },
      link: actionItemLink("change_order_pending", { jobId: co.job_id }),
      createdAt: co.created_at,
    });
  }

  // LOW: warranty_checkin
  for (const job of warrantyJobs.results ?? []) {
    items.push({
      id: `warranty_checkin_${job.id}`,
      priority: "low",
      type: "warranty_checkin",
      title: `Warranty reminder: ${job.title} — 11-month check-in`,
      meta: { jobId: job.id, actualEndDate: job.actual_end_date },
      link: actionItemLink("warranty_checkin", { jobId: job.id }),
      createdAt: job.actual_end_date ?? today,
    });
  }

  // Sprint 33: punch list + voice note in-app notifications
  for (const row of notifyPunchVoice.results ?? []) {
    const priority =
      row.trigger_event === "punch_list_complete"
        ? "high"
        : row.trigger_event === "voice_note_unmatched" || row.trigger_event === "punch_list_item_done"
          ? "medium"
          : "medium";
    items.push({
      id: `${row.trigger_event}_${row.id}`,
      priority,
      type: row.trigger_event,
      title: row.body,
      meta: { jobId: row.job_id, notificationLogId: row.id },
      link: actionItemLink(row.trigger_event, { jobId: row.job_id }),
      createdAt: row.created_at,
    });
  }

  const visible = items.filter((i) => !dismissed.has(i.id));

  // Sort: high → medium → low, then oldest-first within each tier.
  const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
  visible.sort((a, b) => {
    const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (pd !== 0) return pd;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  return json({ items: visible.slice(0, 8) });
}

export async function handleDashboardActionItemDismiss(
  request: Request,
  env: Env,
  itemId: string,
): Promise<Response> {
  const guarded = await guard(request, env, [...DISMISS_ROLES]);
  if (guarded instanceof Response) return guarded;

  const dismissed = await loadDismissedIds(env);
  dismissed.add(itemId);
  await saveDismissedIds(env, dismissed);
  return json({ ok: true, id: itemId });
}

// ── Pipeline handler ───────────────────────────────────────────────────────

const LEAD_STATUS_LABELS: Record<string, string> = {
  new_request: "New Leads",
  appointment_set: "Appt Set",
  visit_done: "Visit Done",
  building: "Building",
  sent: "Estimate Sent",
  follow_up: "Follow Up",
};

const JOB_STATUS_LABELS: Record<string, string> = {
  deposit_paid: "Deposit Paid",
  scheduled: "Scheduled",
  in_progress: "In Progress",
  punch_list: "Punch List",
  complete: "Complete",
};

interface PipelineStage {
  status: string;
  label: string;
  count: number;
}

export async function handleDashboardPipeline(env: Env): Promise<Response> {
  const cached = cacheGet<unknown>(pipelineCache, "pipeline");
  if (cached) return json(cached);

  const week = currentWeekRange();

  const [leadRows, jobRows, convRows, unpaidRow] = await Promise.all([
    env.DB.prepare(
      `SELECT status, COUNT(*) as count
       FROM estimate_requests
       WHERE status NOT IN ('won', 'lost')
       GROUP BY status`
    ).all<{ status: string; count: number }>(),
    env.DB.prepare(
      `SELECT status, COUNT(*) as count
       FROM jobs
       WHERE status NOT IN ('closed')
       GROUP BY status`
    ).all<{ status: string; count: number }>(),
    env.DB.prepare(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'won') as converted,
         COUNT(*) as total
       FROM estimate_requests
       WHERE created_at >= ?`
    ).bind(week.start).first<{ converted: number; total: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(total_due - COALESCE(paid_amount, 0)), 0) as unpaid
       FROM invoices WHERE status IN ('sent', 'viewed', 'partial', 'past_due')`
    ).first<{ unpaid: number }>(),
  ]);

  // Map lead stages in order.
  const leadOrder = ["new_request", "appointment_set", "visit_done", "building", "sent", "follow_up"];
  const leadCountMap = new Map((leadRows.results ?? []).map((r) => [r.status, r.count]));
  const leads: PipelineStage[] = leadOrder
    .filter((s) => LEAD_STATUS_LABELS[s])
    .map((s) => ({ status: s, label: LEAD_STATUS_LABELS[s]!, count: leadCountMap.get(s) ?? 0 }));

  // Map job stages in order.
  const jobOrder = ["deposit_paid", "scheduled", "in_progress", "punch_list", "complete"];
  const jobCountMap = new Map((jobRows.results ?? []).map((r) => [r.status, r.count]));
  const jobs: PipelineStage[] = jobOrder
    .filter((s) => JOB_STATUS_LABELS[s])
    .map((s) => ({ status: s, label: JOB_STATUS_LABELS[s]!, count: jobCountMap.get(s) ?? 0 }));

  const total = convRows?.total ?? 0;
  const converted = convRows?.converted ?? 0;
  const conversionRate = total > 0 ? Math.round((converted / total) * 100) : 0;
  const unpaidTotal = unpaidRow?.unpaid ?? 0;

  const result = { leads, jobs, conversionRate, unpaidTotal };
  cacheSet(pipelineCache, "pipeline", result);
  return json(result);
}

// ── Schedule handler ───────────────────────────────────────────────────────

interface ScheduleEntry {
  type: "schedule" | "appointment" | "google_calendar";
  entry_type: "job" | "estimate" | "warranty" | "google_calendar";
  id: string;
  startTime: string | null;
  endTime: string | null;
  label: string;
  description: string | null;
  link: string | null;
  meetLink: string | null;
}

export async function handleDashboardSchedule(env: Env): Promise<Response> {
  const today = todayUtc();

  const [schedRows, apptRows, gcalRows] = await Promise.all([
    env.DB.prepare(
      `SELECT se.id, se.start_time, se.trade_or_work, j.title as job_title, j.id as job_id, j.job_number
       FROM schedule_entries se
       JOIN jobs j ON se.job_id = j.id
       WHERE se.scheduled_date = ?
         AND se.status != 'cancelled'
       ORDER BY se.start_time ASC`,
    ).bind(today).all<{ id: string; start_time: string; trade_or_work: string; job_title: string; job_id: string; job_number: string }>(),

    env.DB.prepare(
      `SELECT er.id, er.appointment_date, er.appointment_time, c.first_name, c.last_name, er.property_address
       FROM estimate_requests er
       JOIN clients c ON er.client_id = c.id
       WHERE DATE(er.appointment_date) = ?
         AND er.status NOT IN ('won', 'lost')
       ORDER BY er.appointment_date ASC`,
    ).bind(today).all<{ id: string; appointment_date: string; appointment_time: string | null; first_name: string; last_name: string; property_address: string }>(),

    env.DB.prepare(
      `SELECT id, title, start_time, end_time, meet_link
       FROM google_calendar_events
       WHERE date(start_time, 'localtime') = ?
       ORDER BY start_time ASC`,
    ).bind(today).all<{ id: string; title: string; start_time: string; end_time: string | null; meet_link: string | null }>().catch(() => ({ results: [] as { id: string; title: string; start_time: string; end_time: string | null; meet_link: string | null }[] })),
  ]);

  const entries: ScheduleEntry[] = [];

  for (const row of schedRows.results ?? []) {
    entries.push({
      type: "schedule",
      entry_type: "job",
      id: row.id,
      startTime: row.start_time ?? null,
      endTime: null,
      label: row.job_title ?? `Job #${row.job_number}`,
      description: row.trade_or_work ?? null,
      link: `/jobs/${row.job_id}`,
      meetLink: null,
    });
  }

  for (const row of apptRows.results ?? []) {
    const clientName = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
    entries.push({
      type: "appointment",
      entry_type: "estimate",
      id: row.id,
      startTime: row.appointment_time ?? null,
      endTime: null,
      label: `Estimate appointment: ${clientName}`,
      description: row.property_address ?? null,
      link: "/estimating",
      meetLink: null,
    });
  }

  for (const row of (gcalRows as { results: { id: string; title: string; start_time: string; end_time: string | null; meet_link: string | null }[] }).results ?? []) {
    entries.push({
      type: "google_calendar",
      entry_type: "google_calendar",
      id: row.id,
      startTime: row.start_time,
      endTime: row.end_time ?? null,
      label: row.title,
      description: null,
      link: null,
      meetLink: row.meet_link ?? null,
    });
  }

  // Sort by startTime ascending (nulls last). GCal entries have ISO datetimes,
  // CHS entries have "HH:MM" time strings — ISO sorts correctly vs ISO and
  // "HH:MM" sorts correctly vs "HH:MM"; mixed compare falls back to string order.
  entries.sort((a, b) => {
    if (!a.startTime && !b.startTime) return 0;
    if (!a.startTime) return 1;
    if (!b.startTime) return -1;
    return a.startTime.localeCompare(b.startTime);
  });

  return json({ entries });
}

// ── Activity handler ───────────────────────────────────────────────────────

interface ActivityEntry {
  id: string;
  icon: string;
  description: string;
  createdAt: string;
  link: string | null;
}

const ACTION_MAP: Record<string, { icon: string; template: string }> = {
  payment_received: { icon: "💰", template: "Payment received" },
  invoice_paid: { icon: "💰", template: "Invoice paid" },
  estimate_request_created: { icon: "📋", template: "New lead" },
  estimate_sent: { icon: "📋", template: "Estimate sent" },
  job_status_changed: { icon: "🏗️", template: "Job status changed" },
  task_completed: { icon: "✅", template: "Task completed" },
  smart_note_processed: { icon: "📝", template: "Smart Note processed" },
  change_order_approved: { icon: "📄", template: "Change order approved" },
  photo_uploaded: { icon: "📷", template: "Photos added" },
  document_uploaded: { icon: "📄", template: "Document uploaded" },
  job_created: { icon: "🏗️", template: "Job created" },
  invoice_created: { icon: "💰", template: "Invoice created" },
  payment_recorded: { icon: "💰", template: "Payment recorded" },
};

function describeAction(action: string, details: string | null, entityType: string | null): string {
  const entry = ACTION_MAP[action];
  if (entry) return entry.template;
  // Fallback: humanise the raw action string.
  return action.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function iconForAction(action: string): string {
  return ACTION_MAP[action]?.icon ?? "🔔";
}

function linkForEntry(entityType: string | null, entityId: string | null): string | null {
  if (!entityType || !entityId) return null;
  switch (entityType) {
    case "job": return `/jobs/${entityId}`;
    case "invoice": return "/financial?tab=invoices";
    case "payment": return "/financial?tab=payments";
    case "estimate_request": return `/estimating/${entityId}`;
    case "smart_note": return null;
    default: return null;
  }
}

export async function handleDashboardActivity(env: Env): Promise<Response> {
  const [auditRows, bellCountRow] = await Promise.all([
    env.DB.prepare(
      `SELECT id, action, entity_type, entity_id, details, created_at
       FROM audit_logs
       ORDER BY created_at DESC
       LIMIT 10`
    ).all<{ id: string; action: string; entity_type: string | null; entity_id: string | null; details: string | null; created_at: string }>(),

    env.DB.prepare(
      `SELECT COUNT(*) as cnt
       FROM notification_logs
       WHERE created_at >= datetime('now', '-24 hours')
         AND status IN ('sent', 'delivered')`
    ).first<{ cnt: number }>(),
  ]);

  const entries: ActivityEntry[] = (auditRows.results ?? []).map((row) => ({
    id: row.id,
    icon: iconForAction(row.action),
    description: describeAction(row.action, row.details, row.entity_type),
    createdAt: row.created_at,
    link: linkForEntry(row.entity_type, row.entity_id),
  }));

  const bellCount = bellCountRow?.cnt ?? 0;

  return json({ entries, bellCount });
}

// ── Main router ────────────────────────────────────────────────────────────

export async function handleDashboard(
  env: Env,
  url: URL,
  request?: Request,
): Promise<Response | null> {
  const path = url.pathname;

  const dismissMatch = path.match(/^\/api\/dashboard\/action-items\/([^/]+)\/dismiss$/);
  if (dismissMatch && request?.method === "PATCH") {
    return handleDashboardActionItemDismiss(request, env, decodeURIComponent(dismissMatch[1]!));
  }

  if (path === "/api/dashboard/kpis") return handleDashboardKpis(env);
  if (path === "/api/dashboard/action-items") return handleDashboardActionItems(env);
  if (path === "/api/dashboard/pipeline") return handleDashboardPipeline(env);
  if (path === "/api/dashboard/schedule") return handleDashboardSchedule(env);
  if (path === "/api/dashboard/meetings") return handleDashboardMeetings(env);
  if (path === "/api/dashboard/activity") return handleDashboardActivity(env);

  return null;
}

/**
 * Job Health API (Sprint 34).
 *
 *   GET /api/jobs/health
 *
 * Returns freshness health for all active jobs (scheduled, in_progress,
 * punch_list).  Health is computed at read time from activity tables — no
 * cached column on jobs.
 *
 * Auth: ALL authenticated users (single-user today, structured for PM/OA
 * roles later — same visibility as the job list generally).
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";

const READ_ROLES = ["owner", "project_manager", "field_crew", "office_admin"] as const;

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function err(status: number, code: string): Response {
  return json({ error: code }, { status });
}

type HealthColor = "green" | "amber" | "red" | "neutral";

interface JobHealthRow {
  id: string;
  title: string;
  job_number: number | null;
  status: string;
  client_name: string;
  property_address: string | null;
  last_daily_log: string | null;
  last_smart_note: string | null;
  last_photo: string | null;
}

interface JobHealthItem {
  id: string;
  title: string;
  job_number: number | null;
  status: string;
  client_name: string;
  property_address: string | null;
  health: HealthColor;
  days_quiet: number | null;
  last_daily_log: string | null;
  last_smart_note: string | null;
  last_photo: string | null;
}

function maxDate(dates: (string | null)[]): string | null {
  const valid = dates.filter(Boolean) as string[];
  if (valid.length === 0) return null;
  return valid.reduce((best, d) => (d > best ? d : best));
}

function daysQuiet(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  if (isNaN(then)) return null;
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

function computeHealth(status: string, mostRecentActivity: string | null): { health: HealthColor; days_quiet: number | null } {
  if (status === "scheduled") {
    return { health: "neutral", days_quiet: null };
  }
  // in_progress or punch_list
  if (!mostRecentActivity) {
    return { health: "red", days_quiet: null };
  }
  const days = daysQuiet(mostRecentActivity);
  if (days === null) return { health: "red", days_quiet: null };
  if (days <= 2) return { health: "green", days_quiet: days };
  if (days <= 5) return { health: "amber", days_quiet: days };
  return { health: "red", days_quiet: days };
}

const HEALTH_ORDER: Record<HealthColor, number> = { red: 0, amber: 1, green: 2, neutral: 3 };

function sortJobs(jobs: JobHealthItem[]): JobHealthItem[] {
  return [...jobs].sort((a, b) => {
    const hDiff = HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health];
    if (hDiff !== 0) return hDiff;
    // Within same health: most quiet first (highest days_quiet first).
    // null days_quiet (no activity) sorts before any number (treated as Infinity).
    const da = a.days_quiet ?? Infinity;
    const db = b.days_quiet ?? Infinity;
    return db - da;
  });
}

export async function handleJobHealth(env: Env, request: Request): Promise<Response> {
  const guarded = await guard(request, env, [...READ_ROLES]);
  if (guarded instanceof Response) return guarded;

  const { results } = await env.DB.prepare(
    `SELECT
       j.id,
       j.title,
       j.job_number,
       j.status,
       j.property_address,
       c.first_name || ' ' || c.last_name AS client_name,
       MAX(dl.created_at) AS last_daily_log,
       MAX(sn.created_at) AS last_smart_note,
       MAX(p.created_at)  AS last_photo
     FROM jobs j
     JOIN clients c ON c.id = j.client_id
     LEFT JOIN daily_logs dl ON dl.job_id = j.id
     LEFT JOIN smart_notes sn ON sn.job_id = j.id
     LEFT JOIN photos p ON p.job_id = j.id AND p.is_active = 1
     WHERE j.status IN ('scheduled', 'in_progress', 'punch_list')
     GROUP BY j.id`,
  ).all<JobHealthRow>();

  const jobs: JobHealthItem[] = (results ?? []).map((row) => {
    const mostRecent = maxDate([row.last_daily_log, row.last_smart_note, row.last_photo]);
    const { health, days_quiet } = computeHealth(row.status, mostRecent);
    return {
      id: row.id,
      title: row.title,
      job_number: row.job_number,
      status: row.status,
      client_name: row.client_name,
      property_address: row.property_address,
      health,
      days_quiet,
      last_daily_log: row.last_daily_log,
      last_smart_note: row.last_smart_note,
      last_photo: row.last_photo,
    };
  });

  return json({ jobs: sortJobs(jobs) });
}

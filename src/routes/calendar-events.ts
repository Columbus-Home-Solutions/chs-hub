/**
 * Unified calendar feed — job schedule, warranty calls, estimate visits, Google Meet.
 *
 *   GET /api/calendar/events?from=&to=
 */

import type { Env } from "../env.js";
import {
  type CalendarEvent,
  type ScheduleJob,
  datePart,
  timePart,
} from "../lib/calendar-colors.js";
import { nativeJobSourceWhereAliased } from "../lib/native-jobs.js";
import { ACTIVE_SCHEDULE_JOB_STATUSES, computeJobRag } from "../lib/schedule-rag.js";
import { normalizeScheduleEntryType } from "../lib/schedule-entry-type.js";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}
function str(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  return s === "" ? null : s;
}

function titleCaseJobType(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function calendarFeedFailure(err: unknown): { error: string; details: string } {
  return {
    error: "calendar_feed_failed",
    details: err instanceof Error ? err.message : String(err),
  };
}

export async function handleCalendarEvents(env: Env, url: URL): Promise<Response> {
  try {
    return await assembleCalendarEvents(env, url);
  } catch (err) {
    const body = calendarFeedFailure(err);
    console.error("[calendar/events] feed query failed:", body.details);
    return json(body, { status: 500 });
  }
}

async function assembleCalendarEvents(env: Env, url: URL): Promise<Response> {
  const from = str(url.searchParams.get("from"));
  const to = str(url.searchParams.get("to"));
  const events: CalendarEvent[] = [];

  // Job schedule entries (job_task + deadline)
  {
    const where: string[] = ["e.status != 'cancelled'"];
    const binds: unknown[] = [];
    if (from) {
      where.push("e.scheduled_date >= ?");
      binds.push(from);
    }
    if (to) {
      where.push("e.scheduled_date <= ?");
      binds.push(to);
    }
    const rows =
      (
        await env.DB.prepare(
          `SELECT e.id, e.job_id, e.scheduled_date, e.trade_or_work, e.start_time, e.end_time,
                  e.sub_id, e.status, e.entry_type,
                  j.job_number, j.title AS job_title, j.assigned_to,
                  TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS user_name,
                  u.calendar_color AS user_color,
                  COALESCE(s.company_name, s.company) AS sub_name,
                  s.calendar_color AS sub_color
             FROM schedule_entries e
             JOIN jobs j ON j.id = e.job_id
             LEFT JOIN users u ON u.id = j.assigned_to
             LEFT JOIN subcontractors s ON s.id = e.sub_id
            WHERE ${where.join(" AND ")}
            ORDER BY e.scheduled_date ASC, e.start_time ASC`,
        )
          .bind(...binds)
          .all<{
            id: string;
            job_id: string;
            scheduled_date: string | null;
            trade_or_work: string | null;
            start_time: string | null;
            end_time: string | null;
            sub_id: string | null;
            status: string | null;
            entry_type: string | null;
            job_number: number | null;
            job_title: string | null;
            assigned_to: string | null;
            user_name: string | null;
            user_color: string | null;
            sub_name: string | null;
            sub_color: string | null;
          }>()
      ).results ?? [];

    for (const r of rows) {
      const date = datePart(r.scheduled_date);
      if (!date) continue;
      const isDeadline = normalizeScheduleEntryType(r.entry_type) === "deadline";
      events.push({
        id: r.id,
        type: isDeadline ? "deadline" : "job_appointment",
        title: r.trade_or_work ?? (isDeadline ? "Deadline" : "Scheduled work"),
        date,
        start_time: r.start_time ?? timePart(r.scheduled_date),
        end_time: r.end_time,
        assigned_user_id: r.assigned_to,
        assigned_user_name: r.user_name || null,
        assigned_user_color: r.user_color,
        assigned_sub_id: r.sub_id,
        assigned_sub_name: r.sub_name,
        assigned_sub_color: r.sub_color,
        job_id: r.job_id,
        job_number: r.job_number,
        job_title: r.job_title,
        link_path: `/jobs/${r.job_id}?tab=schedule`,
        meet_link: null,
        description: null,
        status: r.status,
      });
    }
  }

  // Warranty calls with a scheduled date
  {
    const where: string[] = ["w.status NOT IN ('cancelled', 'completed')", "w.scheduled_date IS NOT NULL"];
    const binds: unknown[] = [];
    if (from) {
      where.push("substr(w.scheduled_date, 1, 10) >= ?");
      binds.push(from);
    }
    if (to) {
      where.push("substr(w.scheduled_date, 1, 10) <= ?");
      binds.push(to);
    }
    const rows =
      (
        await env.DB.prepare(
          `SELECT w.id, w.job_id, w.title, w.description, w.status,
                  w.scheduled_date, w.scheduled_end, w.assigned_to, w.assigned_sub_id,
                  j.job_number, j.title AS job_title,
                  TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS user_name,
                  u.calendar_color AS user_color,
                  COALESCE(s.company_name, s.company) AS sub_name,
                  s.calendar_color AS sub_color
             FROM warranty_calls w
             JOIN jobs j ON j.id = w.job_id
             LEFT JOIN users u ON u.id = w.assigned_to
             LEFT JOIN subcontractors s ON s.id = w.assigned_sub_id
            WHERE ${where.join(" AND ")}
            ORDER BY w.scheduled_date ASC`,
        )
          .bind(...binds)
          .all<Record<string, unknown>>()
      ).results ?? [];

    for (const r of rows) {
      const scheduled = String(r.scheduled_date ?? "");
      const date = datePart(scheduled);
      if (!date) continue;
      events.push({
        id: String(r.id),
        type: "warranty_call",
        title: String(r.title),
        date,
        start_time: timePart(scheduled),
        end_time: r.scheduled_end ? timePart(String(r.scheduled_end)) : null,
        assigned_user_id: (r.assigned_to as string | null) ?? null,
        assigned_user_name: (r.user_name as string | null) || null,
        assigned_user_color: (r.user_color as string | null) ?? null,
        assigned_sub_id: (r.assigned_sub_id as string | null) ?? null,
        assigned_sub_name: (r.sub_name as string | null) ?? null,
        assigned_sub_color: (r.sub_color as string | null) ?? null,
        job_id: String(r.job_id),
        job_number: (r.job_number as number | null) ?? null,
        job_title: (r.job_title as string | null) ?? null,
        link_path: `/warranty-calls/${r.id}`,
        meet_link: null,
        description: (r.description as string | null) ?? null,
        status: String(r.status),
      });
    }
  }

  // Estimate visits
  {
    const where: string[] = ["er.appointment_date IS NOT NULL", "er.status NOT IN ('declined', 'lost')"];
    const binds: unknown[] = [];
    if (from) {
      where.push("substr(er.appointment_date, 1, 10) >= ?");
      binds.push(from);
    }
    if (to) {
      where.push("substr(er.appointment_date, 1, 10) <= ?");
      binds.push(to);
    }
    const rows =
      (
        await env.DB.prepare(
          `SELECT er.id, er.appointment_date, er.appointment_time, er.property_address,
                  er.job_type, er.status,
                  c.first_name, c.last_name
             FROM estimate_requests er
             LEFT JOIN clients c ON c.id = er.client_id
            WHERE ${where.join(" AND ")}
            ORDER BY er.appointment_date ASC`,
        )
          .bind(...binds)
          .all<Record<string, unknown>>()
      ).results ?? [];

    for (const r of rows) {
      const appt = String(r.appointment_date ?? "");
      const date = datePart(appt);
      if (!date) continue;
      const client = [r.first_name, r.last_name].filter(Boolean).join(" ");
      events.push({
        id: String(r.id),
        type: "estimate_visit",
        title: client ? `Estimate — ${client}` : "Estimate visit",
        date,
        start_time: (r.appointment_time as string | null) ?? timePart(appt),
        end_time: null,
        assigned_user_id: null,
        assigned_user_name: null,
        assigned_user_color: null,
        assigned_sub_id: null,
        assigned_sub_name: null,
        assigned_sub_color: null,
        job_id: null,
        job_number: null,
        job_title: null,
        link_path: `/estimating/${r.id}`,
        meet_link: null,
        description: (r.property_address as string | null) ?? null,
        status: String(r.status ?? ""),
      });
    }
  }

  // Proposal review calls (future only, active requests)
  {
    const where: string[] = [
      "er.proposal_review_date IS NOT NULL",
      "er.status NOT IN ('lost', 'won')",
      "er.proposal_review_date >= datetime('now')",
    ];
    const binds: unknown[] = [];
    if (from) {
      where.push("substr(er.proposal_review_date, 1, 10) >= ?");
      binds.push(from);
    }
    if (to) {
      where.push("substr(er.proposal_review_date, 1, 10) <= ?");
      binds.push(to);
    }
    const rows =
      (
        await env.DB.prepare(
          `SELECT er.id, er.proposal_review_date, er.property_address, er.job_type, er.status,
                  c.first_name, c.last_name
             FROM estimate_requests er
             LEFT JOIN clients c ON c.id = er.client_id
            WHERE ${where.join(" AND ")}
            ORDER BY er.proposal_review_date ASC`,
        )
          .bind(...binds)
          .all<Record<string, unknown>>()
      ).results ?? [];

    for (const r of rows) {
      const reviewAt = String(r.proposal_review_date ?? "");
      const date = datePart(reviewAt);
      if (!date) continue;
      const client = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
      const jobType = titleCaseJobType(String(r.job_type ?? ""));
      const address = String(r.property_address ?? "");
      events.push({
        id: String(r.id),
        type: "proposal_review",
        title: client ? `Proposal Review — ${client}` : "Proposal Review",
        date,
        start_time: timePart(reviewAt),
        end_time: null,
        assigned_user_id: null,
        assigned_user_name: null,
        assigned_user_color: null,
        assigned_sub_id: null,
        assigned_sub_name: null,
        assigned_sub_color: null,
        job_id: null,
        job_number: null,
        job_title: null,
        link_path: `/estimating/${r.id}`,
        meet_link: null,
        description: [jobType, address].filter(Boolean).join(" · ") || null,
        status: String(r.status ?? ""),
      });
    }
  }

  // Permit inspections (scheduled, not yet passed/failed)
  {
    const where: string[] = ["p.inspection_date IS NOT NULL", "p.status = 'inspection_scheduled'"];
    const binds: unknown[] = [];
    if (from) {
      where.push("substr(p.inspection_date, 1, 10) >= ?");
      binds.push(from);
    }
    if (to) {
      where.push("substr(p.inspection_date, 1, 10) <= ?");
      binds.push(to);
    }
    const rows =
      (
        await env.DB.prepare(
          `SELECT p.id, p.job_id, p.permit_type, p.inspection_date, p.status,
                  j.job_number, j.title AS job_title, j.assigned_to,
                  TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS user_name,
                  u.calendar_color AS user_color
             FROM permits p
             JOIN jobs j ON j.id = p.job_id
             LEFT JOIN users u ON u.id = j.assigned_to
            WHERE ${where.join(" AND ")}
            ORDER BY p.inspection_date ASC`,
        )
          .bind(...binds)
          .all<Record<string, unknown>>()
      ).results ?? [];

    for (const r of rows) {
      const when = String(r.inspection_date ?? "");
      const date = datePart(when);
      if (!date) continue;
      const permitType = String(r.permit_type ?? "permit");
      const jobTitle = String(r.job_title ?? "Job");
      events.push({
        id: String(r.id),
        type: "permit_inspection",
        title: `Inspection — ${permitType}, ${jobTitle}`,
        date,
        start_time: timePart(when),
        end_time: null,
        assigned_user_id: (r.assigned_to as string | null) ?? null,
        assigned_user_name: (r.user_name as string | null) || null,
        assigned_user_color: (r.user_color as string | null) ?? null,
        assigned_sub_id: null,
        assigned_sub_name: null,
        assigned_sub_color: null,
        job_id: String(r.job_id),
        job_number: (r.job_number as number | null) ?? null,
        job_title: (r.job_title as string | null) ?? null,
        link_path: `/jobs/${r.job_id}?tab=permits`,
        meet_link: null,
        description: null,
        status: String(r.status ?? ""),
      });
    }
  }

  // Google Meet events (cached)
  {
    const where: string[] = ["meet_link IS NOT NULL"];
    const binds: unknown[] = [];
    if (from) {
      where.push("substr(start_time, 1, 10) >= ?");
      binds.push(from);
    }
    if (to) {
      where.push("substr(start_time, 1, 10) <= ?");
      binds.push(to);
    }
    const rows =
      (
        await env.DB.prepare(
          `SELECT id, title, start_time, end_time, meet_link, description
             FROM google_calendar_events
            WHERE ${where.join(" AND ")}
            ORDER BY start_time ASC`,
        )
          .bind(...binds)
          .all<Record<string, unknown>>()
      ).results ?? [];

    for (const r of rows) {
      const start = String(r.start_time ?? "");
      const date = datePart(start);
      if (!date) continue;
      events.push({
        id: String(r.id),
        type: "google_meeting",
        title: String(r.title),
        date,
        start_time: timePart(start),
        end_time: r.end_time ? timePart(String(r.end_time)) : null,
        assigned_user_id: null,
        assigned_user_name: null,
        assigned_user_color: null,
        assigned_sub_id: null,
        assigned_sub_name: null,
        assigned_sub_color: null,
        job_id: null,
        job_number: null,
        job_title: null,
        link_path: null,
        meet_link: (r.meet_link as string | null) ?? null,
        description: (r.description as string | null) ?? null,
        status: null,
      });
    }
  }

  events.sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    if (d !== 0) return d;
    return (a.start_time ?? "").localeCompare(b.start_time ?? "");
  });

  const today = new Date().toISOString().slice(0, 10);
  const statusList = ACTIVE_SCHEDULE_JOB_STATUSES.map((s) => `'${s}'`).join(", ");
  const jobRows =
    (
      await env.DB.prepare(
        `SELECT j.id, j.job_number, j.title, j.status, j.start_date, j.target_end_date, j.assigned_to,
                TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS assigned_name,
                COALESCE(u.name, '') AS assigned_fallback,
                u.calendar_color AS assigned_color
           FROM jobs j
           LEFT JOIN users u ON u.id = j.assigned_to
          WHERE ${nativeJobSourceWhereAliased("j")}
            AND j.status IN (${statusList})
          ORDER BY j.start_date ASC, j.job_number ASC`,
      ).all<{
        id: string;
        job_number: number | null;
        title: string | null;
        status: string | null;
        start_date: string | null;
        target_end_date: string | null;
        assigned_to: string | null;
        assigned_name: string | null;
        assigned_fallback: string | null;
        assigned_color: string | null;
      }>()
    ).results ?? [];

  const permitJobs = new Set(
    (
      (
        await env.DB.prepare(
          `SELECT DISTINCT job_id FROM permits WHERE status = 'inspection_scheduled'`,
        ).all<{ job_id: string }>()
      ).results ?? []
    ).map((r) => r.job_id),
  );
  const oorJobs = new Set(
    (
      (
        await env.DB.prepare(
          `SELECT DISTINCT e.job_id
             FROM schedule_entries e
             JOIN jobs j ON j.id = e.job_id
            WHERE j.target_end_date IS NOT NULL
              AND e.scheduled_date > j.target_end_date
              AND e.status != 'cancelled'`,
        ).all<{ job_id: string }>()
      ).results ?? []
    ).map((r) => r.job_id),
  );

  const jobs: ScheduleJob[] = jobRows.map((r) => ({
    id: r.id,
    job_number: r.job_number,
    title: r.title,
    status: r.status,
    start_date: r.start_date,
    target_end_date: r.target_end_date,
    assigned_to: r.assigned_to,
    assigned_to_name: (r.assigned_name || "").trim() || (r.assigned_fallback || "").trim() || null,
    assigned_to_color: r.assigned_color,
    rag: computeJobRag({
      status: r.status,
      targetEndDate: r.target_end_date,
      today,
      hasIncompletePermitInspection: permitJobs.has(r.id),
      hasOutOfRangeEntry: oorJobs.has(r.id),
    }),
  }));

  return json({ from, to, events, jobs });
}

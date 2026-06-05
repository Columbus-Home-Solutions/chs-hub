/**
 * Unified calendar feed — job schedule, warranty calls, estimate visits, Google Meet.
 *
 *   GET /api/calendar/events?from=&to=
 */

import type { Env } from "../env.js";
import { type CalendarEvent, datePart, timePart } from "../lib/calendar-colors.js";

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

export async function handleCalendarEvents(env: Env, url: URL): Promise<Response> {
  const from = str(url.searchParams.get("from"));
  const to = str(url.searchParams.get("to"));
  const events: CalendarEvent[] = [];

  // Job schedule entries
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
                  e.sub_id, e.status,
                  j.job_number, j.title AS job_title,
                  COALESCE(s.company_name, s.company) AS sub_name,
                  s.calendar_color AS sub_color
             FROM schedule_entries e
             JOIN jobs j ON j.id = e.job_id
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
            job_number: number | null;
            job_title: string | null;
            sub_name: string | null;
            sub_color: string | null;
          }>()
      ).results ?? [];

    for (const r of rows) {
      const date = datePart(r.scheduled_date);
      if (!date) continue;
      events.push({
        id: r.id,
        type: "job_appointment",
        title: r.trade_or_work ?? "Scheduled work",
        date,
        start_time: r.start_time ?? timePart(r.scheduled_date),
        end_time: r.end_time,
        assigned_user_id: null,
        assigned_user_name: null,
        assigned_user_color: null,
        assigned_sub_id: r.sub_id,
        assigned_sub_name: r.sub_name,
        assigned_sub_color: r.sub_color,
        job_id: r.job_id,
        job_number: r.job_number,
        job_title: r.job_title,
        link_path: `/jobs/${r.job_id}`,
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

  return json({ from, to, events });
}

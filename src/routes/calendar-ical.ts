/**
 * iCal feed — CHS → external calendars (public, token-gated).
 *
 *   GET  /api/calendar/ical?token=
 *   GET  /api/calendar/ical/settings       (owner) — feed URL for Settings UI
 *   POST /api/calendar/ical/regenerate     (owner)
 */

import type { Env } from "../env.js";
import { authenticateRequest, AuthError } from "../middleware/auth.js";
import { requireRole, RoleError } from "../middleware/roles.js";

const TOKEN_KEY = "calendar_ical_token";

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

async function requireOwner(request: Request, env: Env): Promise<Response | null> {
  try {
    const authed = await authenticateRequest(request, env);
    requireRole(authed, ["owner"]);
    return null;
  } catch (err) {
    if (err instanceof AuthError) return json({ error: "unauthorized", message: err.message }, { status: 401 });
    if (err instanceof RoleError) return json({ error: "forbidden", message: err.message }, { status: 403 });
    throw err;
  }
}

async function getOrCreateToken(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = ?")
    .bind(TOKEN_KEY)
    .first<{ value: string }>();
  if (row?.value) return row.value;
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
     VALUES (?, ?, 'string', 'integrations', 'Calendar iCal token', 'Secret token for the public iCal feed URL.', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  )
    .bind(TOKEN_KEY, token)
    .run();
  return token;
}

function icalDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    const clean = iso.replace(/[-:]/g, "").slice(0, 15);
    return clean.endsWith("Z") ? clean : `${clean}Z`;
  }
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escapeIcal(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function vevent(uid: string, start: string, end: string, summary: string, description: string): string {
  return [
    "BEGIN:VEVENT",
    `UID:${uid}@chs`,
    `DTSTART:${icalDate(start)}`,
    `DTEND:${icalDate(end)}`,
    `SUMMARY:${escapeIcal(summary)}`,
    description ? `DESCRIPTION:${escapeIcal(description)}` : "",
    "END:VEVENT",
  ]
    .filter(Boolean)
    .join("\r\n");
}

async function buildIcalFeed(env: Env): Promise<string> {
  const events: string[] = [];

  const scheduleRows =
    (
      await env.DB.prepare(
        `SELECT e.id, e.scheduled_date, e.start_time, e.end_time, e.trade_or_work, e.notes,
                j.job_number, j.title AS job_title
           FROM schedule_entries e
           JOIN jobs j ON j.id = e.job_id
          WHERE e.status != 'cancelled' AND e.scheduled_date IS NOT NULL`,
      ).all<Record<string, unknown>>()
    ).results ?? [];

  for (const r of scheduleRows) {
    const date = String(r.scheduled_date).slice(0, 10);
    const start = r.start_time ? `${date}T${String(r.start_time)}:00.000Z` : `${date}T08:00:00.000Z`;
    const end = r.end_time ? `${date}T${String(r.end_time)}:00.000Z` : `${date}T17:00:00.000Z`;
    const jobNum = r.job_number != null ? `JOB-${String(r.job_number).padStart(3, "0")}` : "Job";
    events.push(
      vevent(
        `schedule-${r.id}`,
        start,
        end,
        `${jobNum} — ${String(r.trade_or_work ?? "Scheduled work")}`,
        [r.job_title, r.notes].filter(Boolean).join(" · "),
      ),
    );
  }

  const warrantyRows =
    (
      await env.DB.prepare(
        `SELECT w.id, w.title, w.description, w.scheduled_date, w.scheduled_end,
                j.job_number
           FROM warranty_calls w
           JOIN jobs j ON j.id = w.job_id
          WHERE w.status NOT IN ('cancelled', 'completed') AND w.scheduled_date IS NOT NULL`,
      ).all<Record<string, unknown>>()
    ).results ?? [];

  for (const r of warrantyRows) {
    const start = String(r.scheduled_date);
    const end = r.scheduled_end ? String(r.scheduled_end) : start;
    const jobNum = r.job_number != null ? `JOB-${String(r.job_number).padStart(3, "0")}` : "";
    events.push(
      vevent(`warranty-${r.id}`, start, end, `Warranty: ${String(r.title)}`, [jobNum, r.description].filter(Boolean).join(" · ")),
    );
  }

  const estimateRows =
    (
      await env.DB.prepare(
        `SELECT er.id, er.appointment_date, er.property_address, er.job_type,
                c.first_name, c.last_name
           FROM estimate_requests er
           LEFT JOIN clients c ON c.id = er.client_id
          WHERE er.appointment_date IS NOT NULL AND er.status NOT IN ('declined', 'lost')`,
      ).all<Record<string, unknown>>()
    ).results ?? [];

  for (const r of estimateRows) {
    const start = String(r.appointment_date);
    const end = new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();
    const client = [r.first_name, r.last_name].filter(Boolean).join(" ");
    events.push(
      vevent(
        `estimate-${r.id}`,
        start,
        end,
        client ? `Estimate — ${client}` : "Estimate visit",
        String(r.property_address ?? r.job_type ?? ""),
      ),
    );
  }

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Columbus Home Solutions//CHS//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Columbus Home Solutions",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
}

export async function handleIcalFeed(env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get("token")?.trim();
  if (!token) {
    return new Response("Missing token", { status: 401, headers: { "content-type": "text/plain" } });
  }
  const stored = await env.DB.prepare("SELECT value FROM system_settings WHERE key = ?")
    .bind(TOKEN_KEY)
    .first<{ value: string }>();
  if (!stored?.value || stored.value !== token) {
    return new Response("Invalid token", { status: 403, headers: { "content-type": "text/plain" } });
  }
  const body = await buildIcalFeed(env);
  return new Response(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function handleIcalSettings(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  const token = await getOrCreateToken(env);
  const origin = new URL(request.url).origin;
  return json({ url: `${origin}/api/calendar/ical?token=${token}` });
}

export async function handleIcalRegenerate(request: Request, env: Env): Promise<Response> {
  const denied = await requireOwner(request, env);
  if (denied) return denied;
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
     VALUES (?, ?, 'string', 'integrations', 'Calendar iCal token', 'Secret token for the public iCal feed URL.', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  )
    .bind(TOKEN_KEY, token)
    .run();
  const origin = new URL(request.url).origin;
  return json({ url: `${origin}/api/calendar/ical?token=${token}` });
}

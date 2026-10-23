/**
 * Day-rate worker check-in on the existing /sub/:token link.
 * Pending rows do not count as accrued labor until an owner or PM confirms them.
 */

import type { Env } from "../env.js";
import { guard } from "../middleware/guard.js";
import { resolveSubAccessToken, subAccessLink } from "../lib/sub-access-tokens.js";
import { POST_DEPOSIT_JOB_STATUSES, centralDate, isCheckinDate, round2 } from "../../shared/labor-week.js";
import { cancelQueuedDayRateNotices, inviteText, retranslateQueuedDayRate, workerLang } from "../lib/day-rate-notify.js";
import { renderSVG } from "uqr";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function err(status: number, error: string, message = error): Response {
  return json({ error, message }, status);
}

const WRITE = ["owner", "project_manager"] as const;
const CHECKIN_HOURLY_CAP = 30;
const NOT_AVAILABLE = { error: "not_available", message: "This page isn't available for this link." };

interface TokenRow {
  token: string;
  sub_id: string;
  disabled_at: string | null;
  schedule_seen_at: string | null;
  punch_seen_at: string | null;
  company_name: string | null;
  contact_name: string | null;
  day_rate: number | null;
  worker_type: string | null;
  is_active: number | null;
  text_updates_enabled: number | null;
  preferred_language: string | null;
}

export async function resolveCheckinToken(env: Env, token: string): Promise<TokenRow | Response> {
  if (!token || token.length < 8) return err(404, "not_found");
  const row = await env.DB.prepare(
    `SELECT t.token, t.sub_id, t.disabled_at, t.schedule_seen_at, t.punch_seen_at,
            COALESCE(s.company_name, s.company) AS company_name,
            COALESCE(s.contact_name, s.primary_contact) AS contact_name,
            s.day_rate, s.worker_type, s.is_active, s.text_updates_enabled, s.preferred_language
       FROM sub_access_tokens t
       JOIN subcontractors s ON s.id = t.sub_id
      WHERE t.token = ?`,
  )
    .bind(token)
    .first<TokenRow>();
  if (!row || row.disabled_at || row.is_active === 0) return err(404, "not_found");
  return row;
}

function firstName(row: TokenRow): string {
  const raw = (row.contact_name || row.company_name || "").trim();
  return raw.split(/\s+/)[0] || "there";
}

function publicJob(row: { id: string; job_number: string | null; title: string | null; property_address: string | null }) {
  return {
    id: row.id,
    job_number: row.job_number,
    title: row.title,
    street: row.property_address,
  };
}

async function rateLimited(env: Env, subId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM labor_entries
      WHERE sub_id = ? AND entered_via = 'checkin_link'
        AND COALESCE(submitted_at, created_at) >= datetime('now', '-1 hour')`,
  )
    .bind(subId)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= CHECKIN_HOURLY_CAP;
}

export async function handleCheckinGet(env: Env, token: string): Promise<Response> {
  const row = await resolveCheckinToken(env, token);
  if (row instanceof Response) return row;
  if ((row.worker_type ?? "subcontractor") !== "day_rate_labor") return json(NOT_AVAILABLE, 404);

  const today = centralDate();
  const { results: jobs } = await env.DB.prepare(
    `SELECT j.id, j.job_number, j.title, j.property_address,
            MAX(le.work_date) AS last_worked
       FROM jobs j
       JOIN clients c ON c.id = j.client_id
       LEFT JOIN labor_entries le ON le.job_id = j.id AND le.sub_id = ? AND le.deleted_at IS NULL
      WHERE j.status IN (${POST_DEPOSIT_JOB_STATUSES.map(() => "?").join(",")})
        AND COALESCE(c.is_test, 0) = 0
      GROUP BY j.id
      ORDER BY last_worked DESC, j.job_number ASC`,
  )
    .bind(row.sub_id, ...POST_DEPOSIT_JOB_STATUSES)
    .all();

  const { results: recent } = await env.DB.prepare(
    `SELECT le.id, le.work_date, le.days, le.status, le.expense_id, le.deleted_at, le.submitted_at, le.job_id,
            j.job_number, j.title, j.property_address
       FROM labor_entries le
       JOIN jobs j ON j.id = le.job_id
      WHERE le.sub_id = ? AND le.entered_via = 'checkin_link'
        AND le.work_date >= date('now', '-14 days')
      ORDER BY le.work_date DESC, le.created_at DESC
      LIMIT 20`,
  )
    .bind(row.sub_id)
    .all<{
      id: string;
      work_date: string;
      days: number;
      status: string;
      expense_id: string | null;
      deleted_at: string | null;
      submitted_at: string | null;
      job_id: string;
      job_number: string | null;
      title: string | null;
      property_address: string | null;
    }>();

  return json({
    greeting: `Hi ${firstName(row)}`,
    name: firstName(row),
    language: workerLang(row.preferred_language),
    today,
    jobs: (jobs ?? []).map((j) => publicJob(j as { id: string; job_number: string | null; title: string | null; property_address: string | null })),
    recent: (recent ?? []).map((entry) => ({
      id: entry.id,
      work_date: entry.work_date,
      days: entry.days,
      state: entry.deleted_at ? "removed" : entry.expense_id ? "paid" : entry.status,
      job: publicJob({ id: entry.job_id, job_number: entry.job_number, title: entry.title, property_address: entry.property_address }),
      can_undo: !entry.deleted_at && entry.status === "pending" && !entry.expense_id && (entry.submitted_at ?? "").slice(0, 10) === today,
    })),
  });
}

export async function handleCheckinPost(env: Env, token: string, request: Request): Promise<Response> {
  const row = await resolveCheckinToken(env, token);
  if (row instanceof Response) return row;
  if ((row.worker_type ?? "subcontractor") !== "day_rate_labor") return json(NOT_AVAILABLE, 404);
  if (await rateLimited(env, row.sub_id)) return err(429, "rate_limited");

  let body: { job_id?: string; work_date?: string; days?: number };
  try {
    body = await request.json();
  } catch {
    return err(400, "invalid_json");
  }
  const days = body.days;
  if (days !== 1 && days !== 0.5) return err(400, "days");
  const workDate = (body.work_date ?? "").trim();
  const today = centralDate();
  if (!isCheckinDate(workDate, today)) {
    return json({ error: "ask_tony", message: "Ask Tony to add that day." }, 400);
  }
  const jobId = (body.job_id ?? "").trim();
  if (!jobId) return err(400, "job_required");

  const job = await env.DB.prepare(
    `SELECT j.id FROM jobs j
       JOIN clients c ON c.id = j.client_id
      WHERE j.id = ? AND j.status IN (${POST_DEPOSIT_JOB_STATUSES.map(() => "?").join(",")})
        AND COALESCE(c.is_test, 0) = 0`,
  )
    .bind(jobId, ...POST_DEPOSIT_JOB_STATUSES)
    .first<{ id: string }>();
  if (!job) return err(400, "job_not_available");

  const existing = await env.DB.prepare(
    `SELECT id, days, status FROM labor_entries
      WHERE sub_id = ? AND job_id = ? AND work_date = ? AND deleted_at IS NULL`,
  )
    .bind(row.sub_id, jobId, workDate)
    .first<{ id: string; days: number; status: string }>();
  if (existing) return json({ id: existing.id, days: existing.days, status: existing.status, idempotent: true });

  const used = await env.DB.prepare(
    `SELECT COALESCE(SUM(days), 0) AS days FROM labor_entries
      WHERE sub_id = ? AND work_date = ? AND deleted_at IS NULL`,
  )
    .bind(row.sub_id, workDate)
    .first<{ days: number }>();
  if (round2((used?.days ?? 0) + days) > 1) return err(400, "day_cap", "That day is already a full day.");

  const id = crypto.randomUUID();
  const rate = row.day_rate != null && row.day_rate > 0 ? row.day_rate : 0;
  await env.DB.prepare(
    `INSERT INTO labor_entries
       (id, sub_id, job_id, work_date, days, day_rate, entered_via, status, submitted_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'checkin_link', 'pending', ?, 'checkin_link', datetime('now'), datetime('now'))`,
  )
    .bind(id, row.sub_id, jobId, workDate, days, rate, today)
    .run();
  return json({ id, days, status: "pending", idempotent: false }, 201);
}

export async function handleCheckinDelete(env: Env, token: string, entryId: string): Promise<Response> {
  const row = await resolveCheckinToken(env, token);
  if (row instanceof Response) return row;
  if ((row.worker_type ?? "subcontractor") !== "day_rate_labor") return json(NOT_AVAILABLE, 404);
  const today = centralDate();
  const entry = await env.DB.prepare(
    `SELECT id, status, work_date, expense_id, deleted_at, sub_id, submitted_at
       FROM labor_entries WHERE id = ?`,
  )
    .bind(entryId)
    .first<{
      id: string;
      status: string;
      work_date: string;
      expense_id: string | null;
      deleted_at: string | null;
      sub_id: string;
      submitted_at: string | null;
    }>();
  if (!entry || entry.sub_id !== row.sub_id) return err(404, "not_found");
  if (entry.deleted_at) return json({ ok: true });
  const submittedDay = entry.submitted_at ? entry.submitted_at.slice(0, 10) : "";
  if (entry.status !== "pending" || entry.expense_id || submittedDay !== today) {
    return err(400, "cannot_undo");
  }
  await env.DB.prepare(
    `UPDATE labor_entries
        SET deleted_at = datetime('now'), deleted_by = 'checkin_link', delete_reason = 'removed by worker',
            updated_at = datetime('now'), updated_by = 'checkin_link'
      WHERE id = ?`,
  )
    .bind(entryId)
    .run();
  return json({ ok: true });
}

export async function handleCheckinSchedule(env: Env, token: string): Promise<Response> {
  const row = await resolveCheckinToken(env, token);
  if (row instanceof Response) return row;
  if ((row.worker_type ?? "subcontractor") !== "day_rate_labor") return json(NOT_AVAILABLE, 404);
  const today = centralDate();
  const { results } = await env.DB.prepare(
    `SELECT se.id, se.scheduled_date, se.start_time, se.end_time, se.status, se.created_at,
            j.job_number, j.title, j.property_address
       FROM schedule_entries se
       JOIN jobs j ON j.id = se.job_id
      WHERE se.sub_id = ? AND se.status != 'cancelled'
        AND se.scheduled_date >= ? AND se.scheduled_date <= date(?, '+14 days')
      ORDER BY se.scheduled_date ASC, se.start_time ASC`,
  )
    .bind(row.sub_id, today, today)
    .all<{
      id: string;
      scheduled_date: string;
      start_time: string | null;
      end_time: string | null;
      status: string | null;
      created_at: string | null;
      job_number: string | null;
      title: string | null;
      property_address: string | null;
    }>();
  await env.DB.prepare(`UPDATE sub_access_tokens SET schedule_seen_at = datetime('now') WHERE token = ?`).bind(token).run();
  const seen = row.schedule_seen_at;
  return json({
    language: workerLang(row.preferred_language),
    entries: (results ?? []).map((entry) => ({
      id: entry.id,
      date: entry.scheduled_date,
      start_time: entry.start_time,
      end_time: entry.end_time,
      status: entry.status,
      is_new: !seen || (entry.created_at ?? "") > seen,
      job_number: entry.job_number,
      title: entry.title,
      street: entry.property_address,
    })),
  });
}

export async function handleCheckinPunch(env: Env, token: string): Promise<Response> {
  const row = await resolveCheckinToken(env, token);
  if (row instanceof Response) return row;
  if ((row.worker_type ?? "subcontractor") !== "day_rate_labor") return json(NOT_AVAILABLE, 404);
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.description, i.created_at, j.job_number, j.title, j.property_address
       FROM punch_list_items i
       JOIN punch_lists pl ON pl.id = i.punch_list_id
       JOIN jobs j ON j.id = pl.job_id
      WHERE i.sub_id = ? AND COALESCE(i.status, '') != 'done'
      ORDER BY i.created_at DESC`,
  )
    .bind(row.sub_id)
    .all<{
      id: string;
      description: string | null;
      created_at: string | null;
      job_number: string | null;
      title: string | null;
      property_address: string | null;
    }>();
  const seen = row.punch_seen_at;
  await env.DB.prepare(`UPDATE sub_access_tokens SET punch_seen_at = datetime('now') WHERE token = ?`).bind(token).run();
  return json({
    language: workerLang(row.preferred_language),
    items: (results ?? []).map((item) => ({
      id: item.id,
      description: item.description,
      job_number: item.job_number,
      title: item.title,
      property_address: item.property_address,
      is_new: !seen || (item.created_at ?? "") > seen,
    })),
  });
}

export async function handleCheckinManifest(env: Env, token: string): Promise<Response> {
  const row = await resolveCheckinToken(env, token);
  if (row instanceof Response) return row;
  const start = `/sub/${token}`;
  return new Response(
    JSON.stringify({
      name: "CHS Check In",
      short_name: "Check In",
      lang: workerLang(row.preferred_language),
      start_url: start,
      scope: start,
      display: "standalone",
      icons: [{ src: "/app/assets/chs-logo-192.png", sizes: "192x192", type: "image/png" }],
    }),
    { headers: { "Content-Type": "application/manifest+json" } },
  );
}

export async function handleCheckinCounts(env: Env, token: string): Promise<Response> {
  const row = await resolveCheckinToken(env, token);
  if (row instanceof Response) return row;
  const today = centralDate();
  const schedule = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM schedule_entries
      WHERE sub_id = ? AND status != 'cancelled'
        AND scheduled_date >= ? AND scheduled_date <= date(?, '+14 days')
        AND (? IS NULL OR created_at > ?)`,
  )
    .bind(row.sub_id, today, today, row.schedule_seen_at, row.schedule_seen_at)
    .first<{ n: number }>();
  const punch = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM punch_list_items
      WHERE sub_id = ? AND COALESCE(status, '') != 'done'
        AND (? IS NULL OR created_at > ?)`,
  )
    .bind(row.sub_id, row.punch_seen_at, row.punch_seen_at)
    .first<{ n: number }>();
  return json({ schedule_new: schedule?.n ?? 0, punch_new: punch?.n ?? 0 });
}

async function requireStaff(request: Request, env: Env): Promise<{ email: string } | Response> {
  const guarded = await guard(request, env, [...WRITE]);
  if (guarded instanceof Response) return guarded;
  return { email: guarded.user.email };
}

export async function handleLaborPending(request: Request, env: Env): Promise<Response> {
  const staff = await requireStaff(request, env);
  if (staff instanceof Response) return staff;
  const { results } = await env.DB.prepare(
    `SELECT le.id, le.sub_id, le.job_id, le.work_date, le.days, le.day_rate, le.submitted_at, le.notes,
            COALESCE(s.company_name, s.company) AS worker_name, s.day_rate AS worker_day_rate,
            j.job_number, j.title AS job_title,
            (SELECT COUNT(*) FROM labor_entries other
              WHERE other.sub_id = le.sub_id AND other.job_id = le.job_id AND other.work_date = le.work_date
                AND other.id != le.id AND other.deleted_at IS NULL AND other.entered_via != 'checkin_link') AS hand_logged
       FROM labor_entries le
       JOIN subcontractors s ON s.id = le.sub_id
       JOIN jobs j ON j.id = le.job_id
      WHERE le.status = 'pending' AND le.deleted_at IS NULL
      ORDER BY le.submitted_at ASC`,
  )
    .all();
  return json({ entries: results ?? [], count: (results ?? []).length });
}

export async function handleLaborConfirm(request: Request, env: Env): Promise<Response> {
  const staff = await requireStaff(request, env);
  if (staff instanceof Response) return staff;
  let body: { entry_ids?: string[]; edits?: { id: string; job_id?: string; days?: number; day_rate?: number }[] };
  try {
    body = await request.json();
  } catch {
    return err(400, "invalid_json");
  }
  const ids = body.entry_ids ?? [];
  if (!ids.length) return err(400, "entry_ids");
  const edits = new Map((body.edits ?? []).map((edit) => [edit.id, edit]));
  const email = staff.email;
  const confirmed: string[] = [];
  const needsRate: string[] = [];
  for (const id of ids) {
    const entry = await env.DB.prepare(
      `SELECT id, status, day_rate, deleted_at, expense_id FROM labor_entries WHERE id = ?`,
    )
      .bind(id)
      .first<{ id: string; status: string; day_rate: number; deleted_at: string | null; expense_id: string | null }>();
    if (!entry || entry.deleted_at || entry.expense_id || entry.status !== "pending") continue;
    const edit = edits.get(id);
    const rate = edit?.day_rate ?? entry.day_rate;
    if (!(rate > 0)) {
      needsRate.push(id);
      continue;
    }
    if (edit?.days != null && edit.days !== 1 && edit.days !== 0.5) return err(400, "days");
    await env.DB.prepare(
      `UPDATE labor_entries
          SET status = 'confirmed', confirmed_at = datetime('now'), confirmed_by = ?,
              day_rate = ?, days = COALESCE(?, days), job_id = COALESCE(?, job_id),
              updated_at = datetime('now'), updated_by = ?
        WHERE id = ? AND status = 'pending' AND deleted_at IS NULL`,
    )
      .bind(email, rate, edit?.days ?? null, edit?.job_id ?? null, email, id)
      .run();
    confirmed.push(id);
  }
  if (!confirmed.length && needsRate.length) {
    return json({ error: "day_rate_required", message: "Set a day rate on the flagged check-in.", needs_rate: needsRate }, 400);
  }
  return json({ confirmed, needs_rate: needsRate });
}

export async function handleLaborReject(request: Request, env: Env): Promise<Response> {
  const staff = await requireStaff(request, env);
  if (staff instanceof Response) return staff;
  let body: { entry_id?: string; reason?: string };
  try {
    body = await request.json();
  } catch {
    return err(400, "invalid_json");
  }
  const reason = (body.reason ?? "").trim();
  if (!body.entry_id || !reason) return err(400, "reason_required");
  const email = staff.email;
  const res = await env.DB.prepare(
    `UPDATE labor_entries
        SET deleted_at = datetime('now'), deleted_by = ?, delete_reason = ?,
            updated_at = datetime('now'), updated_by = ?
      WHERE id = ? AND status = 'pending' AND deleted_at IS NULL AND expense_id IS NULL`,
  )
    .bind(email, reason, email, body.entry_id)
    .run();
  if (!res.meta.changes) return err(404, "not_found");
  return json({ ok: true });
}

export async function handleCheckinLink(request: Request, env: Env, subId: string, action: "get" | "regenerate" | "disable"): Promise<Response> {
  const staff = await requireStaff(request, env);
  if (staff instanceof Response) return staff;
  const sub = await env.DB.prepare(
    `SELECT id, worker_type, preferred_language FROM subcontractors WHERE id = ?`,
  )
    .bind(subId)
    .first<{ id: string; worker_type: string | null; preferred_language: string | null }>();
  if (!sub || (sub.worker_type ?? "subcontractor") !== "day_rate_labor") return err(400, "not_day_rate");

  if (action === "disable") {
    await env.DB.prepare(
      `UPDATE sub_access_tokens SET disabled_at = datetime('now') WHERE sub_id = ? AND disabled_at IS NULL`,
    )
      .bind(subId)
      .run();
    return json({ disabled: true });
  }
  if (action === "regenerate") {
    const token = crypto.randomUUID().replace(/-/g, "");
    await env.DB.prepare(
      `UPDATE sub_access_tokens SET token = ?, disabled_at = NULL, created_at = datetime('now') WHERE sub_id = ?`,
    )
      .bind(token, subId)
      .run();
    const link = subAccessLink(token);
    return json({ link, invite: inviteText(link, sub.preferred_language), language: workerLang(sub.preferred_language) });
  }
  const token = await resolveSubAccessToken(env, subId);
  const link = subAccessLink(token);
  return json({ link, invite: inviteText(link, sub.preferred_language), language: workerLang(sub.preferred_language), disabled: false });
}

export async function handleWorkerLanguage(env: Env, token: string, request: Request): Promise<Response> {
  const row = await resolveCheckinToken(env, token);
  if (row instanceof Response) return row;
  if ((row.worker_type ?? "subcontractor") !== "day_rate_labor") return json(NOT_AVAILABLE, 404);
  let body: { language?: string };
  try {
    body = await request.json();
  } catch {
    return err(400, "invalid_json");
  }
  if (body.language !== "en" && body.language !== "es") return err(400, "language");
  await env.DB.prepare(`UPDATE subcontractors SET preferred_language = ? WHERE id = ?`)
    .bind(body.language, row.sub_id)
    .run();
  await retranslateQueuedDayRate(env, row.sub_id);
  return json({ language: body.language });
}

export async function handleCheckinQr(request: Request, env: Env, subId: string): Promise<Response> {
  const staff = await requireStaff(request, env);
  if (staff instanceof Response) return staff;
  const token = await resolveSubAccessToken(env, subId);
  const link = subAccessLink(token);
  const svg = renderSVG(link, { border: 2 });
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml" } });
}

export async function handleTextUpdates(request: Request, env: Env, subId: string): Promise<Response> {
  const staff = await requireStaff(request, env);
  if (staff instanceof Response) return staff;
  let body: { enabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return err(400, "invalid_json");
  }
  const enabled = body.enabled ? 1 : 0;
  const email = staff.email;
  const sub = await env.DB.prepare(`SELECT phone, email FROM subcontractors WHERE id = ?`)
    .bind(subId)
    .first<{ phone: string | null; email: string | null }>();
  await env.DB.prepare(
    `UPDATE subcontractors
        SET text_updates_enabled = ?, text_updates_enabled_at = datetime('now'), text_updates_enabled_by = ?
      WHERE id = ?`,
  )
    .bind(enabled, email, subId)
    .run();
  if (enabled === 0) {
    await cancelQueuedDayRateNotices(env, { phone: sub?.phone, email: sub?.email }, "text_updates_off");
  }
  return json({ text_updates_enabled: enabled });
}

/**
 * Mirror future CHS items onto Tony's primary Google Calendar.
 * CHS is the source of truth. Failures never roll back the CHS write.
 * Estimate visits are busy. Schedule entries and warranty calls are free,
 * so a crew day cannot come back through free/busy and block booking.
 */

import type { Env } from "../env.js";
import { centralClockToUtc, centralParts, CHS_TIMEZONE } from "./central-send-window.js";
import {
  GcalNotConnectedError,
  GcalReconnectError,
  getValidAccessToken,
  hasEventWriteScope,
  loadGcalConnection,
} from "./google-calendar-auth.js";
import { createOwnerInApp } from "./notification-engine.js";
import { decideKeepaliveAlert } from "./qbo-token-keepalive.js";
import { centralDateKey, jobBlocksAvailability } from "./self-scheduling.js";

export const WRITE_SETTING = "google_calendar_write_enabled";
export const ALERT_SETTING = "google_calendar_write_alert";
export const RETRY_CAP = 25;
export const BACKFILL_CAP = 40;
const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export type SourceType = "estimate_request" | "schedule_entry" | "warranty_call";
export type CalendarSyncState = "off" | "needs_reconnect" | "on";

export interface GcalEventBody {
  summary: string;
  location: string;
  description: string;
  transparency: "opaque" | "transparent";
  start: { date: string } | { dateTime: string; timeZone: typeof CHS_TIMEZONE };
  end: { date: string } | { dateTime: string; timeZone: typeof CHS_TIMEZONE };
  extendedProperties: {
    private: { chs: "1"; chs_source_type: SourceType; chs_source_id: string };
  };
}

interface LinkRow {
  id: string;
  google_event_id: string | null;
  last_synced_hash: string | null;
  status: string;
}

type FetchLike = typeof fetch;

const PHONE = /(?:\+?1[\s.-]*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}/;

export function scrubPrivate(text: string): string {
  return text
    .replace(PHONE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function personName(row: {
  first_name?: string | null;
  last_name?: string | null;
  client_name?: string | null;
}): string {
  const joined = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return joined || (row.client_name ?? "").trim() || "Client";
}

function addressOf(row: {
  property_address?: string | null;
  property_city?: string | null;
  property_state?: string | null;
  property_zip?: string | null;
}): string {
  return scrubPrivate(
    [row.property_address, row.property_city, row.property_state, row.property_zip]
      .map((part) => (part ?? "").trim())
      .filter(Boolean)
      .join(", "),
  );
}

export function nextDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}

export function isCurrentOrFutureDay(ymd: string, now = new Date()): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) && ymd >= centralDateKey(now);
}

function dateKeyOf(value: string | null | undefined, now = new Date()): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const instant = new Date(raw);
  if (Number.isNaN(instant.getTime())) {
    const head = raw.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : null;
  }
  return centralDateKey(instant);
}

function clockMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const hm = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!hm) return null;
  const h = Number(hm[1]);
  const m = Number(hm[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function chicagoStamp(instant: Date): string {
  const p = centralParts(instant);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00`;
}

function clockStamp(ymd: string, minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${ymd}T${pad(h)}:${pad(m)}:00`;
}

function tagged(
  sourceType: SourceType,
  sourceId: string,
  summary: string,
  location: string,
  description: string,
  transparency: "opaque" | "transparent",
  start: GcalEventBody["start"],
  end: GcalEventBody["end"],
): GcalEventBody {
  return {
    summary: scrubPrivate(summary).slice(0, 200) || "CHS",
    location: scrubPrivate(location).slice(0, 300),
    description: scrubPrivate(description).slice(0, 1500),
    transparency,
    start,
    end,
    extendedProperties: {
      private: { chs: "1", chs_source_type: sourceType, chs_source_id: sourceId },
    },
  };
}

function dashboardLink(path: string): string {
  return `https://dashboard.homesolutionsar.com${path}`;
}

export function eventHash(body: GcalEventBody): string {
  const canonical = JSON.stringify({
    summary: body.summary,
    location: body.location,
    description: body.description,
    transparency: body.transparency,
    start: body.start,
    end: body.end,
    source: body.extendedProperties.private,
  });
  let h = 5381;
  for (let i = 0; i < canonical.length; i++) h = ((h << 5) + h + canonical.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

export function buildEstimateEvent(input: {
  id: string;
  client: string;
  jobType: string | null;
  address: string;
  start: Date;
  visitMinutes: number;
}): GcalEventBody {
  const end = new Date(input.start.getTime() + Math.max(15, input.visitMinutes) * 60_000);
  const kind = (input.jobType ?? "project").replace(/[_-]+/g, " ");
  return tagged(
    "estimate_request",
    input.id,
    `Estimate: ${input.client}`,
    input.address,
    `${kind}\n${dashboardLink(`/app/estimating/${input.id}`)}`,
    "opaque",
    { dateTime: chicagoStamp(input.start), timeZone: CHS_TIMEZONE },
    { dateTime: chicagoStamp(end), timeZone: CHS_TIMEZONE },
  );
}

export function buildScheduleEvent(input: {
  id: string;
  jobId: string;
  jobTitle: string;
  client: string;
  address: string;
  work: string | null;
  crew: string | null;
  date: string;
  startMin: number | null;
  endMin: number | null;
}): GcalEventBody {
  const title = input.jobTitle.trim()
    ? `Job: ${input.jobTitle.trim()} (${input.client})`
    : `Job: ${input.client}`;
  const lines = [input.work?.trim() || "Scheduled work"];
  if (input.crew?.trim()) lines.push(`Crew: ${input.crew.trim()}`);
  lines.push(dashboardLink(`/app/jobs/${input.jobId}`));
  const timed = input.startMin != null && input.endMin != null && input.endMin > input.startMin;
  return tagged(
    "schedule_entry",
    input.id,
    title,
    input.address,
    lines.join("\n"),
    "transparent",
    timed
      ? { dateTime: clockStamp(input.date, input.startMin!), timeZone: CHS_TIMEZONE }
      : { date: input.date },
    timed
      ? { dateTime: clockStamp(input.date, input.endMin!), timeZone: CHS_TIMEZONE }
      : { date: nextDate(input.date) },
  );
}

export function buildWarrantyEvent(input: {
  id: string;
  jobId: string;
  client: string;
  title: string;
  address: string;
  crew: string | null;
  date: string;
  startMin: number | null;
  endMin: number | null;
}): GcalEventBody {
  const lines = [input.title.trim() || "Warranty call"];
  if (input.crew?.trim()) lines.push(`Crew: ${input.crew.trim()}`);
  lines.push(dashboardLink(`/app/jobs/${input.jobId}`));
  const timed = input.startMin != null && input.endMin != null && input.endMin > input.startMin;
  return tagged(
    "warranty_call",
    input.id,
    `Warranty: ${input.client}`,
    input.address,
    lines.join("\n"),
    "transparent",
    timed
      ? { dateTime: clockStamp(input.date, input.startMin!), timeZone: CHS_TIMEZONE }
      : { date: input.date },
    timed
      ? { dateTime: clockStamp(input.date, input.endMin!), timeZone: CHS_TIMEZONE }
      : { date: nextDate(input.date) },
  );
}

async function settingValue(env: Env, key: string): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string | null }>();
  return (row?.value ?? "").trim();
}

function enabledValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

async function writeEnabled(env: Env): Promise<boolean> {
  return enabledValue(await settingValue(env, WRITE_SETTING));
}

function shortError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/ya29\.[A-Za-z0-9_\-]+/g, "[token]").replace(/Bearer\s+\S+/gi, "Bearer [token]").slice(0, 300);
}

async function loadLink(env: Env, sourceType: SourceType, sourceId: string): Promise<LinkRow | null> {
  return env.DB.prepare(
    `SELECT id, google_event_id, last_synced_hash, status
       FROM google_calendar_event_links
      WHERE source_type = ? AND source_id = ?`,
  )
    .bind(sourceType, sourceId)
    .first<LinkRow>();
}

async function saveLink(
  env: Env,
  sourceType: SourceType,
  sourceId: string,
  patch: {
    googleEventId?: string | null;
    hash?: string | null;
    status: string;
    error?: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await loadLink(env, sourceType, sourceId);
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO google_calendar_event_links
         (id, source_type, source_id, google_event_id, last_synced_hash, last_synced_at, status, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        sourceType,
        sourceId,
        patch.googleEventId ?? null,
        patch.hash ?? null,
        patch.status === "synced" ? now : null,
        patch.status,
        patch.error ?? null,
        now,
        now,
      )
      .run();
    return;
  }
  await env.DB.prepare(
    `UPDATE google_calendar_event_links
        SET google_event_id = ?,
            last_synced_hash = ?,
            last_synced_at = CASE WHEN ? = 'synced' THEN ? ELSE last_synced_at END,
            status = ?,
            last_error = ?,
            updated_at = ?
      WHERE id = ?`,
  )
    .bind(
      patch.googleEventId === undefined ? existing.google_event_id : patch.googleEventId,
      patch.hash === undefined ? existing.last_synced_hash : patch.hash,
      patch.status,
      now,
      patch.status,
      patch.error ?? null,
      now,
      existing.id,
    )
    .run();
}

async function visitMinutes(env: Env): Promise<number> {
  const raw = await settingValue(env, "scheduling_visit_minutes");
  const n = Number(raw);
  return Number.isFinite(n) && n >= 15 ? n : 60;
}

export async function desiredCalendarEvent(
  env: Env,
  sourceType: SourceType,
  sourceId: string,
  now: Date,
): Promise<GcalEventBody | null> {
  if (sourceType === "estimate_request") {
    const row = await env.DB.prepare(
      `SELECT er.id, er.status, er.appointment_date, er.appointment_time, er.job_type,
              er.property_address, er.property_city, er.property_state, er.property_zip,
              c.first_name, c.last_name, c.name AS client_name
         FROM estimate_requests er
         LEFT JOIN clients c ON c.id = er.client_id
        WHERE er.id = ?`,
    )
      .bind(sourceId)
      .first<{
        id: string;
        status: string;
        appointment_date: string | null;
        appointment_time: string | null;
        job_type: string | null;
        property_address: string | null;
        property_city: string | null;
        property_state: string | null;
        property_zip: string | null;
        first_name: string | null;
        last_name: string | null;
        client_name: string | null;
      }>();
    if (!row?.appointment_date) return null;
    const status = (row.status ?? "").toLowerCase();
    if (status === "lost" || status === "declined") return null;
    const day = dateKeyOf(row.appointment_date, now);
    if (!day || !isCurrentOrFutureDay(day, now)) return null;
    const start = estimateVisitStart(row.appointment_date, row.appointment_time, day);
    if (Number.isNaN(start.getTime())) return null;
    return buildEstimateEvent({
      id: row.id,
      client: personName(row),
      jobType: row.job_type,
      address: addressOf(row),
      start,
      visitMinutes: await visitMinutes(env),
    });
  }

  if (sourceType === "schedule_entry") {
    const row = await env.DB.prepare(
      `SELECT e.id, e.job_id, e.scheduled_date, e.start_time, e.end_time, e.status, e.trade_or_work,
              j.status AS job_status, j.title AS job_title,
              j.property_address, j.property_city, j.property_state, j.property_zip,
              c.first_name, c.last_name, c.name AS client_name,
              COALESCE(s.company_name, s.company, s.contact_name) AS crew
         FROM schedule_entries e
         JOIN jobs j ON j.id = e.job_id
         LEFT JOIN clients c ON c.id = j.client_id
         LEFT JOIN subcontractors s ON s.id = e.sub_id
        WHERE e.id = ?`,
    )
      .bind(sourceId)
      .first<{
        id: string;
        job_id: string;
        scheduled_date: string | null;
        start_time: string | null;
        end_time: string | null;
        status: string | null;
        trade_or_work: string | null;
        job_status: string | null;
        job_title: string | null;
        property_address: string | null;
        property_city: string | null;
        property_state: string | null;
        property_zip: string | null;
        first_name: string | null;
        last_name: string | null;
        client_name: string | null;
        crew: string | null;
      }>();
    if (!row) return null;
    const entryStatus = (row.status ?? "scheduled").toLowerCase();
    if (["cancelled", "canceled", "completed"].includes(entryStatus)) return null;
    if (!jobBlocksAvailability(row.job_status)) return null;
    const day = dateKeyOf(row.scheduled_date, now);
    if (!day || !isCurrentOrFutureDay(day, now)) return null;
    return buildScheduleEvent({
      id: row.id,
      jobId: row.job_id,
      jobTitle: row.job_title ?? "",
      client: personName(row),
      address: addressOf(row),
      work: row.trade_or_work,
      crew: row.crew,
      date: day,
      startMin: clockMinutes(row.start_time),
      endMin: clockMinutes(row.end_time),
    });
  }

  const row = await env.DB.prepare(
    `SELECT w.id, w.job_id, w.status, w.title, w.scheduled_date, w.scheduled_end,
            j.status AS job_status,
            j.property_address, j.property_city, j.property_state, j.property_zip,
            c.first_name, c.last_name, c.name AS client_name,
            COALESCE(s.company_name, s.company, s.contact_name) AS crew
       FROM warranty_calls w
       JOIN jobs j ON j.id = w.job_id
       LEFT JOIN clients c ON c.id = j.client_id
       LEFT JOIN subcontractors s ON s.id = w.assigned_sub_id
      WHERE w.id = ?`,
  )
    .bind(sourceId)
    .first<{
      id: string;
      job_id: string;
      status: string | null;
      title: string | null;
      scheduled_date: string | null;
      scheduled_end: string | null;
      job_status: string | null;
      property_address: string | null;
      property_city: string | null;
      property_state: string | null;
      property_zip: string | null;
      first_name: string | null;
      last_name: string | null;
      client_name: string | null;
      crew: string | null;
    }>();
  if (!row) return null;
  const status = (row.status ?? "").toLowerCase();
  if (status !== "open" && status !== "scheduled") return null;
  if (!jobBlocksAvailability(row.job_status)) return null;
  const day = dateKeyOf(row.scheduled_date, now);
  if (!day || !isCurrentOrFutureDay(day, now)) return null;
  const startMin = clockMinutes(row.scheduled_date) ?? clockMinutes(timePart(row.scheduled_date));
  const endMin = clockMinutes(row.scheduled_end) ?? clockMinutes(timePart(row.scheduled_end));
  return buildWarrantyEvent({
    id: row.id,
    jobId: row.job_id,
    client: personName(row),
    title: row.title ?? "Warranty call",
    address: addressOf(row),
    crew: row.crew,
    date: day,
    startMin,
    endMin,
  });
}

/** A full instant wins. A date plus HH:MM is that Central clock. A date alone stays 8:00. */
export function estimateVisitStart(
  appointmentDate: string,
  appointmentTime: string | null | undefined,
  day: string,
): Date {
  if (appointmentDate.includes("T")) return new Date(appointmentDate);
  const minutes = clockMinutes(appointmentTime);
  const hour = minutes == null ? 8 : Math.floor(minutes / 60);
  const minute = minutes == null ? 0 : minutes % 60;
  return centralClockToUtc(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)),
    Number(day.slice(8, 10)),
    hour,
    minute,
  );
}

function timePart(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

async function googleCall(
  fetchImpl: FetchLike,
  token: string,
  method: "POST" | "PATCH" | "DELETE",
  url: string,
  body?: GcalEventBody,
): Promise<{ ok: boolean; status: number; id?: string; text: string }> {
  const resp = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let id: string | undefined;
  if (text) {
    try {
      id = (JSON.parse(text) as { id?: string }).id;
    } catch {
      id = undefined;
    }
  }
  return { ok: resp.ok, status: resp.status, id, text: text.slice(0, 300) };
}

async function mirrorSourceInner(
  env: Env,
  sourceType: SourceType,
  sourceId: string,
  fetchImpl: FetchLike,
  now: Date,
  force: boolean,
): Promise<"skipped" | "unchanged" | "synced" | "deleted" | "failed"> {
  if (!(await writeEnabled(env))) return "skipped";
  const conn = await loadGcalConnection(env);
  if (!conn || conn.status === "disconnected" || !hasEventWriteScope(conn)) return "skipped";

  const desired = await desiredCalendarEvent(env, sourceType, sourceId, now);
  const link = await loadLink(env, sourceType, sourceId);
  const hash = desired ? eventHash(desired) : null;
  if (!force && desired && link?.status === "synced" && link.google_event_id && link.last_synced_hash === hash) {
    return "unchanged";
  }
  // A hand-deleted Google event stays gone until CHS itself changes.
  // force is the owner's Ignore: put the CHS time back even when the hash matches.
  if (!force && desired && link?.status === "deleted" && link.last_synced_hash === hash) {
    return "unchanged";
  }
  if (!desired && (!link?.google_event_id || link.status === "deleted")) return "unchanged";

  let token: string;
  try {
    token = await getValidAccessToken(env);
  } catch (err) {
    if (err instanceof GcalNotConnectedError || err instanceof GcalReconnectError) {
      await saveLink(env, sourceType, sourceId, { status: "failed", error: shortError(err), hash });
      return "failed";
    }
    throw err;
  }

  try {
    if (!desired) {
      const url = `${EVENTS_URL}/${encodeURIComponent(link!.google_event_id!)}?sendUpdates=none`;
      const result = await googleCall(fetchImpl, token, "DELETE", url);
      if (!result.ok && result.status !== 404 && result.status !== 410) {
        await saveLink(env, sourceType, sourceId, { status: "failed", error: `delete ${result.status}` });
        return "failed";
      }
      await saveLink(env, sourceType, sourceId, {
        status: "deleted",
        googleEventId: link!.google_event_id,
        error: null,
      });
      return "deleted";
    }

    const sameGone = link?.status === "deleted" && link.last_synced_hash === hash;
    const canPatch = !!link?.google_event_id && link.status !== "deleted" && !sameGone;
    if (canPatch) {
      const url = `${EVENTS_URL}/${encodeURIComponent(link!.google_event_id!)}?sendUpdates=none`;
      const result = await googleCall(fetchImpl, token, "PATCH", url, desired);
      if (result.status === 404 || result.status === 410) {
        if (!force && link!.last_synced_hash === hash) {
          await saveLink(env, sourceType, sourceId, { status: "deleted", googleEventId: null, error: null });
          return "deleted";
        }
      } else if (!result.ok) {
        await saveLink(env, sourceType, sourceId, { status: "failed", error: `patch ${result.status}`, hash });
        return "failed";
      } else {
        await saveLink(env, sourceType, sourceId, {
          status: "synced",
          googleEventId: result.id ?? link!.google_event_id,
          hash,
          error: null,
        });
        return "synced";
      }
    }

    const created = await googleCall(fetchImpl, token, "POST", `${EVENTS_URL}?sendUpdates=none`, desired);
    if (!created.ok || !created.id) {
      await saveLink(env, sourceType, sourceId, { status: "failed", error: `insert ${created.status}`, hash });
      return "failed";
    }
    await saveLink(env, sourceType, sourceId, {
      status: "synced",
      googleEventId: created.id,
      hash,
      error: null,
    });
    return "synced";
  } catch (err) {
    await saveLink(env, sourceType, sourceId, { status: "failed", error: shortError(err), hash });
    return "failed";
  }
}

export async function mirrorSource(
  env: Env,
  sourceType: SourceType,
  sourceId: string,
  deps?: { fetch?: FetchLike; now?: Date; force?: boolean },
): Promise<"skipped" | "unchanged" | "synced" | "deleted" | "failed"> {
  return mirrorSourceInner(
    env,
    sourceType,
    sourceId,
    deps?.fetch ?? fetch,
    deps?.now ?? new Date(),
    deps?.force === true,
  );
}

/** Never throws. A Google failure must not fail the CHS action that just saved. */
export async function queueCalendarMirror(env: Env, sourceType: SourceType, sourceId: string): Promise<void> {
  try {
    await mirrorSource(env, sourceType, sourceId);
  } catch (err) {
    console.error(`[gcal-write] ${sourceType} ${sourceId}: ${shortError(err)}`);
  }
}

export async function queueJobCalendarMirror(env: Env, jobId: string): Promise<void> {
  try {
    const entries =
      (
        await env.DB.prepare("SELECT id FROM schedule_entries WHERE job_id = ?")
          .bind(jobId)
          .all<{ id: string }>()
      ).results ?? [];
    const calls =
      (
        await env.DB.prepare("SELECT id FROM warranty_calls WHERE job_id = ?")
          .bind(jobId)
          .all<{ id: string }>()
      ).results ?? [];
    for (const row of entries) await queueCalendarMirror(env, "schedule_entry", row.id);
    for (const row of calls) await queueCalendarMirror(env, "warranty_call", row.id);
  } catch (err) {
    console.error(`[gcal-write] job ${jobId}: ${shortError(err)}`);
  }
}

async function readAlert(env: Env): Promise<{ status: "ok" | "fail" | "none"; streak: number; notified: boolean }> {
  const raw = await settingValue(env, ALERT_SETTING);
  if (!raw) return { status: "none", streak: 0, notified: false };
  try {
    const parsed = JSON.parse(raw) as { status?: string; streak?: number; notified?: boolean };
    const status = parsed.status === "ok" || parsed.status === "fail" ? parsed.status : "none";
    return {
      status,
      streak: typeof parsed.streak === "number" ? parsed.streak : 0,
      notified: parsed.notified === true,
    };
  } catch {
    return { status: "none", streak: 0, notified: false };
  }
}

async function writeAlert(
  env: Env,
  state: { status: "ok" | "fail"; streak: number; notified: boolean },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
     VALUES (?, ?, 'json', 'integrations', 'Google Calendar write alert',
             'Failure streak for mirroring CHS items. Not edited by hand.', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  )
    .bind(ALERT_SETTING, JSON.stringify(state))
    .run();
}

export async function retryFailedCalendarWrites(
  env: Env,
  deps?: { fetch?: FetchLike; now?: Date },
): Promise<{ scanned: number; synced: number; failed: number; notified: boolean }> {
  if (!(await writeEnabled(env))) return { scanned: 0, synced: 0, failed: 0, notified: false };
  const rows =
    (
      await env.DB.prepare(
        `SELECT source_type, source_id FROM google_calendar_event_links
          WHERE status IN ('failed', 'pending')
          ORDER BY updated_at ASC
          LIMIT ?`,
      )
        .bind(RETRY_CAP)
        .all<{ source_type: SourceType; source_id: string }>()
    ).results ?? [];
  let synced = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const outcome = await mirrorSource(env, row.source_type, row.source_id, deps);
      if (outcome === "failed") failed += 1;
      else synced += 1;
    } catch {
      failed += 1;
    }
  }
  const still =
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM google_calendar_event_links WHERE status = 'failed'",
    ).first<{ n: number }>();
  const ok = Number(still?.n ?? 0) === 0;
  const decision = decideKeepaliveAlert(await readAlert(env), ok);
  await writeAlert(env, decision.state);
  if (decision.notify) {
    await createOwnerInApp(env, {
      message: "Google Calendar isn't updating. CHS items may be missing from your calendar until sync works again.",
      linkPath: "/app/settings?tab=integrations",
      triggerEvent: "google_calendar_write_failed",
      dedupe: `gcal-write-alert-${decision.state.streak}`,
    });
  }
  return { scanned: rows.length, synced, failed, notified: decision.notify };
}

const LIVE_SQL = "'deposit_paid','scheduled','in_progress','punch_list','late'";

export async function countFutureUnsynced(env: Env, now = new Date()): Promise<number> {
  const day = centralDateKey(now);
  const schedule = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM schedule_entries e
       JOIN jobs j ON j.id = e.job_id
      WHERE substr(e.scheduled_date, 1, 10) >= ?
        AND lower(COALESCE(j.status, '')) IN (${LIVE_SQL})
        AND lower(COALESCE(e.status, 'scheduled')) NOT IN ('cancelled', 'canceled', 'completed')
        AND NOT EXISTS (
          SELECT 1 FROM google_calendar_event_links l
           WHERE l.source_type = 'schedule_entry' AND l.source_id = e.id AND l.status = 'synced'
        )`,
  )
    .bind(day)
    .first<{ n: number }>();
  const estimates = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM estimate_requests er
      WHERE er.appointment_date IS NOT NULL
        AND substr(er.appointment_date, 1, 10) >= ?
        AND lower(COALESCE(er.status, '')) NOT IN ('lost', 'declined')
        AND NOT EXISTS (
          SELECT 1 FROM google_calendar_event_links l
           WHERE l.source_type = 'estimate_request' AND l.source_id = er.id AND l.status = 'synced'
        )`,
  )
    .bind(day)
    .first<{ n: number }>();
  const warranty = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM warranty_calls w
       JOIN jobs j ON j.id = w.job_id
      WHERE w.scheduled_date IS NOT NULL
        AND substr(w.scheduled_date, 1, 10) >= ?
        AND lower(COALESCE(w.status, '')) IN ('open', 'scheduled')
        AND lower(COALESCE(j.status, '')) IN (${LIVE_SQL})
        AND NOT EXISTS (
          SELECT 1 FROM google_calendar_event_links l
           WHERE l.source_type = 'warranty_call' AND l.source_id = w.id AND l.status = 'synced'
        )`,
  )
    .bind(day)
    .first<{ n: number }>();
  return Number(schedule?.n ?? 0) + Number(estimates?.n ?? 0) + Number(warranty?.n ?? 0);
}

export async function backfillFutureItems(
  env: Env,
  deps?: { fetch?: FetchLike; now?: Date },
): Promise<{ attempted: number; remaining: number }> {
  const now = deps?.now ?? new Date();
  const day = centralDateKey(now);
  const ids: Array<{ type: SourceType; id: string }> = [];
  const take = async (sql: string, type: SourceType) => {
    const rows =
      (
        await env.DB.prepare(sql)
          .bind(day, BACKFILL_CAP)
          .all<{ id: string }>()
      ).results ?? [];
    for (const row of rows) ids.push({ type, id: row.id });
  };
  await take(
    `SELECT e.id FROM schedule_entries e
       JOIN jobs j ON j.id = e.job_id
      WHERE substr(e.scheduled_date, 1, 10) >= ?
        AND lower(COALESCE(j.status, '')) IN (${LIVE_SQL})
        AND lower(COALESCE(e.status, 'scheduled')) NOT IN ('cancelled', 'canceled', 'completed')
      LIMIT ?`,
    "schedule_entry",
  );
  await take(
    `SELECT er.id FROM estimate_requests er
      WHERE er.appointment_date IS NOT NULL
        AND substr(er.appointment_date, 1, 10) >= ?
        AND lower(COALESCE(er.status, '')) NOT IN ('lost', 'declined')
      LIMIT ?`,
    "estimate_request",
  );
  await take(
    `SELECT w.id FROM warranty_calls w
       JOIN jobs j ON j.id = w.job_id
      WHERE w.scheduled_date IS NOT NULL
        AND substr(w.scheduled_date, 1, 10) >= ?
        AND lower(COALESCE(w.status, '')) IN ('open', 'scheduled')
        AND lower(COALESCE(j.status, '')) IN (${LIVE_SQL})
      LIMIT ?`,
    "warranty_call",
  );
  const batch = ids.slice(0, BACKFILL_CAP);
  for (const item of batch) await mirrorSource(env, item.type, item.id, deps);
  const remaining = await countFutureUnsynced(env, now);
  return { attempted: batch.length, remaining };
}

export async function calendarWriteStatus(env: Env): Promise<{
  write_enabled: boolean;
  write_scope: boolean;
  calendar_sync: CalendarSyncState;
  write_synced: number;
  write_failed: number;
  write_last_at: string | null;
}> {
  const enabled = await writeEnabled(env);
  const conn = await loadGcalConnection(env);
  const connected = !!conn && conn.status === "connected";
  const write_scope = connected && hasEventWriteScope(conn);
  let calendar_sync: CalendarSyncState = "off";
  if (connected && !write_scope) calendar_sync = "needs_reconnect";
  else if (write_scope && enabled) calendar_sync = "on";
  const counts =
    (
      await env.DB.prepare(
        `SELECT status, COUNT(*) AS n FROM google_calendar_event_links GROUP BY status`,
      ).all<{ status: string; n: number }>()
    ).results ?? [];
  const n = (status: string) => Number(counts.find((row) => row.status === status)?.n ?? 0);
  const last = await env.DB.prepare(
    `SELECT MAX(last_synced_at) AS at FROM google_calendar_event_links WHERE status = 'synced'`,
  ).first<{ at: string | null }>();
  return {
    write_enabled: enabled,
    write_scope,
    calendar_sync,
    write_synced: n("synced"),
    write_failed: n("failed"),
    write_last_at: last?.at ?? null,
  };
}

export async function setCalendarWriteEnabled(
  env: Env,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; error: "needs_reconnect" }> {
  if (enabled) {
    const conn = await loadGcalConnection(env);
    if (!conn || conn.status !== "connected" || !hasEventWriteScope(conn)) {
      return { ok: false, error: "needs_reconnect" };
    }
  }
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
     VALUES (?, ?, 'string', 'integrations', 'Show CHS items on Google Calendar',
             'Off until turned on. Requires a Google reconnect that includes event write.', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  )
    .bind(WRITE_SETTING, enabled ? "1" : "0")
    .run();
  return { ok: true };
}

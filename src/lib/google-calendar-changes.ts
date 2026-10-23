/**
 * Stage 2: notice Google edits to CHS-tagged events. CHS does not change
 * until the owner presses Apply.
 *
 * Detection is one events.list per existing 15-minute tick, and only while
 * google_calendar_changes_enabled is 1. The first cursor is 15 minutes ago,
 * so turning the switch on does not scan history. Push channels are not used.
 * Warranty events and anything without chs=1 are ignored. A Google event
 * never creates a CHS lead, job, or schedule row.
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
import { createOwnerInApp, markOwnerInAppRead, resolveOwner } from "./notification-engine.js";
import { handleEstimateRequestAppointment } from "../routes/estimate-requests.js";
import { handleScheduleUpdate } from "../routes/schedule.js";
import { centralDateKey, formatCentralWhen, formatSlotLabel } from "./self-scheduling.js";
import {
  desiredCalendarEvent,
  mirrorSource,
  nextDate,
  type GcalEventBody,
  type SourceType,
} from "./google-calendar-writeback.js";

export const CHANGES_SETTING = "google_calendar_changes_enabled";
const CURSOR_SETTING = "google_calendar_changes_cursor";
const LIST_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const REVIEW_PATH = "/app/";

type FetchLike = typeof fetch;
type ChangeSource = "estimate_request" | "schedule_entry";
type ChangeKind = "moved" | "deleted";

export interface PendingChange {
  id: string;
  source_type: ChangeSource;
  source_id: string;
  change_kind: ChangeKind;
  summary_label: string | null;
  when_label: string | null;
}

interface PendingRow extends PendingChange {
  google_start: string | null;
  google_end: string | null;
  google_all_day: number;
  status: string;
}

interface ListedEvent {
  id?: string;
  status?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
}

interface RemoteWindow {
  allDay: boolean;
  startIso: string | null;
  endIso: string | null;
  day: string;
  key: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function chicagoStamp(instant: Date): string {
  const p = centralParts(instant);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00`;
}

function hhmm(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

async function settingValue(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string | null }>();
  const value = (row?.value ?? "").trim();
  return value || null;
}

async function writeSetting(env: Env, key: string, value: string, label: string, description: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO system_settings (key, value, value_type, category, label, description, updated_at)
     VALUES (?, ?, 'string', 'integrations', ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  )
    .bind(key, value, label, description)
    .run();
}

function desiredKey(body: GcalEventBody): string {
  if ("date" in body.start && "date" in body.end) return `day:${body.start.date}:${body.end.date}`;
  if ("dateTime" in body.start && "dateTime" in body.end) {
    return `time:${body.start.dateTime.slice(0, 16)}:${body.end.dateTime.slice(0, 16)}`;
  }
  return "unknown";
}

function remoteWindow(ev: ListedEvent): RemoteWindow | null {
  if (ev.start?.date) {
    const day = ev.start.date;
    const endDay = ev.end?.date ?? nextDate(day);
    return { allDay: true, startIso: null, endIso: null, day, key: `day:${day}:${endDay}` };
  }
  if (!ev.start?.dateTime || !ev.end?.dateTime) return null;
  const start = new Date(ev.start.dateTime);
  const end = new Date(ev.end.dateTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return {
    allDay: false,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    day: centralDateKey(start),
    key: `time:${chicagoStamp(start).slice(0, 16)}:${chicagoStamp(end).slice(0, 16)}`,
  };
}

function phrase(sourceType: string, summary: string): string {
  if (sourceType === "estimate_request") {
    const client = summary.replace(/^Estimate:\s*/, "").trim() || "a client";
    return `Estimate for ${client}`;
  }
  const paren = summary.match(/\(([^)]+)\)\s*$/);
  const client = (paren?.[1] ?? summary.replace(/^Job:\s*/, "")).trim() || "a client";
  return `Job for ${client}`;
}

function whenText(window: RemoteWindow): string {
  if (window.allDay || !window.startIso) {
    const [year, month, day] = window.day.split("-").map(Number);
    return centralClockToUtc(year, month, day, 12, 0)
      .toLocaleDateString("en-US", {
        timeZone: CHS_TIMEZONE,
        weekday: "short",
        month: "short",
        day: "numeric",
      })
      .replace(/\u202f/g, " ");
  }
  return formatCentralWhen(new Date(window.startIso));
}

function actorRequest(email: string, body: unknown): Request {
  return new Request("https://dashboard.homesolutionsar.com/api/internal/calendar-change", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "Cf-Access-Authenticated-User-Email": email,
    },
    body: JSON.stringify(body),
  });
}

async function readCursor(env: Env, now: Date): Promise<{ updatedMin: string; pageToken?: string }> {
  const raw = await settingValue(env, CURSOR_SETTING);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { updatedMin?: string; pageToken?: string };
      if (parsed.updatedMin) return { updatedMin: parsed.updatedMin, pageToken: parsed.pageToken || undefined };
    } catch {
      /* A bad cursor starts the 15-minute window over. */
    }
  }
  return { updatedMin: new Date(now.getTime() - 15 * 60_000).toISOString() };
}

async function writeCursor(env: Env, cursor: { updatedMin: string; pageToken?: string }): Promise<void> {
  await writeSetting(
    env,
    CURSOR_SETTING,
    JSON.stringify(cursor),
    "Google Calendar change cursor",
    "updatedMin for the next events.list. Not edited by hand.",
  );
}

function listUrl(cursor: { updatedMin: string; pageToken?: string }): string {
  const params = new URLSearchParams({
    privateExtendedProperty: "chs=1",
    showDeleted: "true",
    singleEvents: "true",
    maxResults: "20",
    updatedMin: cursor.updatedMin,
  });
  if (cursor.pageToken) params.set("pageToken", cursor.pageToken);
  return `${LIST_URL}?${params.toString()}`;
}

async function clearOpen(env: Env, sourceType: string, sourceId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE google_calendar_pending_changes
        SET status = 'ignored', updated_at = datetime('now')
      WHERE source_type = ? AND source_id = ? AND status = 'pending'`,
  )
    .bind(sourceType, sourceId)
    .run();
}

async function recordChange(
  env: Env,
  sourceType: ChangeSource,
  sourceId: string,
  kind: ChangeKind,
  window: RemoteWindow,
  summary: string,
): Promise<boolean> {
  const label = phrase(sourceType, summary);
  const whenLabel = whenText(window);
  const open = await env.DB.prepare(
    `SELECT id, bell_sent FROM google_calendar_pending_changes
      WHERE source_type = ? AND source_id = ? AND status = 'pending'`,
  )
    .bind(sourceType, sourceId)
    .first<{ id: string; bell_sent: number | null }>();
  const googleStart = window.allDay ? window.day : window.startIso;
  const googleEnd = window.allDay ? null : window.endIso;
  if (open) {
    await env.DB.prepare(
      `UPDATE google_calendar_pending_changes
          SET change_kind = ?, google_start = ?, google_end = ?, google_all_day = ?,
              summary_label = ?, when_label = ?, updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(kind, googleStart, googleEnd, window.allDay ? 1 : 0, label, whenLabel, open.id)
      .run();
    return false;
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO google_calendar_pending_changes (
       id, source_type, source_id, change_kind, google_start, google_end, google_all_day,
       summary_label, when_label, status, bell_sent, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, datetime('now'), datetime('now'))`,
  )
    .bind(id, sourceType, sourceId, kind, googleStart, googleEnd, window.allDay ? 1 : 0, label, whenLabel)
    .run();
  const message =
    kind === "deleted"
      ? `${label} was removed on Google. Cancel it in CHS or put it back.`
      : `${label} moved on Google to ${whenLabel} Central. Apply to CHS?`;
  await createOwnerInApp(env, {
    message,
    linkPath: REVIEW_PATH,
    dedupe: `gcal-change-${id}`,
    triggerEvent: "google_calendar_change",
  });
  await env.DB.prepare(
    `UPDATE google_calendar_pending_changes SET bell_sent = 1, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(id)
    .run();
  return true;
}

export async function pollGoogleCalendarChanges(
  env: Env,
  deps?: { fetch?: FetchLike; now?: Date },
): Promise<{ skipped: boolean; scanned: number; opened: number }> {
  const now = deps?.now ?? new Date();
  if ((await settingValue(env, CHANGES_SETTING)) !== "1") return { skipped: true, scanned: 0, opened: 0 };
  const conn = await loadGcalConnection(env);
  if (!conn || conn.status !== "connected" || !hasEventWriteScope(conn)) {
    return { skipped: true, scanned: 0, opened: 0 };
  }
  let token: string;
  try {
    token = await getValidAccessToken(env);
  } catch (err) {
    if (err instanceof GcalNotConnectedError || err instanceof GcalReconnectError) {
      return { skipped: true, scanned: 0, opened: 0 };
    }
    throw err;
  }
  const cursor = await readCursor(env, now);
  const fetchImpl = deps?.fetch ?? fetch;
  const resp = await fetchImpl(listUrl(cursor), {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!resp.ok) return { skipped: false, scanned: 0, opened: 0 };
  const body = (await resp.json()) as { items?: ListedEvent[]; nextPageToken?: string };
  const items = body.items ?? [];
  let opened = 0;
  for (const item of items) {
    try {
      const tagged = item.extendedProperties?.private;
      if (tagged?.chs !== "1") continue;
      const sourceType = tagged.chs_source_type;
      const sourceId = tagged.chs_source_id ?? "";
      if ((sourceType !== "estimate_request" && sourceType !== "schedule_entry") || !sourceId) continue;
      const remote = remoteWindow(item);
      if (!remote || remote.day < centralDateKey(now)) continue;
      const desired = await desiredCalendarEvent(env, sourceType, sourceId, now);
      if (!desired) {
        await clearOpen(env, sourceType, sourceId);
        continue;
      }
      if ((item.status ?? "").toLowerCase() === "cancelled") {
        if (await recordChange(env, sourceType, sourceId, "deleted", remote, desired.summary)) opened += 1;
        continue;
      }
      if (remote.key === desiredKey(desired)) {
        await clearOpen(env, sourceType, sourceId);
        continue;
      }
      if (await recordChange(env, sourceType, sourceId, "moved", remote, desired.summary)) opened += 1;
    } catch (err) {
      console.error(`[gcal-changes] ${item.id ?? "event"}: ${(err as Error).message}`);
    }
  }
  if (body.nextPageToken) {
    await writeCursor(env, { updatedMin: cursor.updatedMin, pageToken: body.nextPageToken });
  } else if (items.length === 0) {
    await writeCursor(env, { updatedMin: new Date(now.getTime() - 2 * 60_000).toISOString() });
  } else {
    const newest = items.reduce(
      (max, item) => (item.updated && item.updated > max ? item.updated : max),
      cursor.updatedMin,
    );
    await writeCursor(env, { updatedMin: newest });
  }
  return { skipped: false, scanned: items.length, opened };
}

export async function calendarChangesStatus(env: Env): Promise<{
  changes_enabled: boolean;
  pending_changes: PendingChange[];
}> {
  const changes_enabled = (await settingValue(env, CHANGES_SETTING)) === "1";
  const rows =
    (
      await env.DB.prepare(
        `SELECT id, source_type, source_id, change_kind, summary_label, when_label
           FROM google_calendar_pending_changes
          WHERE status = 'pending'
          ORDER BY updated_at ASC
          LIMIT 20`,
      ).all<PendingChange>()
    ).results ?? [];
  return { changes_enabled, pending_changes: rows };
}

export async function setCalendarChangesEnabled(
  env: Env,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; error: "needs_reconnect" }> {
  if (enabled) {
    const conn = await loadGcalConnection(env);
    if (!conn || conn.status !== "connected" || !hasEventWriteScope(conn)) {
      return { ok: false, error: "needs_reconnect" };
    }
  }
  await writeSetting(
    env,
    CHANGES_SETTING,
    enabled ? "1" : "0",
    "Tell me when a CHS item moves on Google",
    "Off until turned on. A move or delete rings the owner once. Nothing in CHS changes until Apply.",
  );
  return { ok: true };
}

async function loadPending(env: Env, id: string): Promise<PendingRow | null> {
  return env.DB.prepare(
    `SELECT id, source_type, source_id, change_kind, google_start, google_end, google_all_day,
            summary_label, when_label, status
       FROM google_calendar_pending_changes
      WHERE id = ? AND status = 'pending'`,
  )
    .bind(id)
    .first<PendingRow>();
}

async function markPending(env: Env, id: string, status: "applied" | "ignored"): Promise<void> {
  await env.DB.prepare(
    `UPDATE google_calendar_pending_changes
        SET status = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'`,
  )
    .bind(status, id)
    .run();
  try {
    await markOwnerInAppRead(env, `gcal-change-${id}`);
  } catch (err) {
    console.error(`[gcal-changes] bell read: ${(err as Error).message}`);
  }
}

function estimateFields(row: PendingRow): { appointment_date: string; appointment_time: string } {
  if (row.google_all_day || !row.google_start?.includes("T")) {
    const day = (row.google_start ?? "").slice(0, 10);
    const [year, month, date] = day.split("-").map(Number);
    const start = centralClockToUtc(year, month, date, 8, 0);
    return { appointment_date: start.toISOString(), appointment_time: "8:00 AM" };
  }
  const start = new Date(row.google_start);
  return { appointment_date: start.toISOString(), appointment_time: formatSlotLabel(start) };
}

function scheduleFields(row: PendingRow): Record<string, unknown> {
  if (row.google_all_day || !row.google_start?.includes("T")) {
    return { scheduled_date: (row.google_start ?? "").slice(0, 10), start_time: null, end_time: null };
  }
  const start = new Date(row.google_start);
  const end = new Date(row.google_end ?? row.google_start);
  const sp = centralParts(start);
  const ep = centralParts(end);
  return {
    scheduled_date: centralDateKey(start),
    start_time: hhmm(sp.hour * 60 + sp.minute),
    end_time: hhmm(ep.hour * 60 + ep.minute),
  };
}

export async function applyCalendarChange(
  env: Env,
  id: string,
  action: string,
  deps?: { fetch?: FetchLike; now?: Date },
): Promise<{ ok: true } | { ok: false; status: number; error: string; message: string }> {
  const row = await loadPending(env, id);
  if (!row) return { ok: false, status: 404, error: "not_found", message: "That change is no longer waiting." };
  const moved = row.change_kind === "moved";
  const allowed = moved ? ["apply", "apply_silent", "ignore"] : ["cancel", "ignore"];
  if (!allowed.includes(action)) {
    return { ok: false, status: 400, error: "bad_request", message: "That action does not fit this change." };
  }
  const owner = await resolveOwner(env);
  if (!owner?.email) return { ok: false, status: 400, error: "no_owner", message: "No owner is available to save this." };

  if (action === "ignore") {
    const outcome = await mirrorSource(env, row.source_type as SourceType, row.source_id, {
      fetch: deps?.fetch,
      now: deps?.now,
      force: true,
    });
    if (outcome === "skipped" || outcome === "failed") {
      return {
        ok: false,
        status: 409,
        error: outcome,
        message: "Calendar sync is off or Google rejected the update. CHS was not changed.",
      };
    }
    await markPending(env, id, "ignored");
    return { ok: true };
  }

  const silent = action === "apply_silent";
  const request =
    row.source_type === "estimate_request"
      ? actorRequest(
          owner.email,
          action === "cancel" ? { appointment_date: null, appointment_time: null } : estimateFields(row),
        )
      : actorRequest(owner.email, action === "cancel" ? { status: "cancelled" } : scheduleFields(row));
  const resp =
    row.source_type === "estimate_request"
      ? await handleEstimateRequestAppointment(
          request,
          env,
          row.source_id,
          silent ? { suppressCustomerNotice: true } : undefined,
        )
      : await handleScheduleUpdate(request, env, row.source_id, silent ? { suppressNotices: true } : undefined);
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string; message?: string; details?: string };
    return {
      ok: false,
      status: resp.status,
      error: body.error ?? "save_failed",
      message: body.message ?? body.details ?? "CHS did not save that change.",
    };
  }
  await markPending(env, id, "applied");
  return { ok: true };
}

/**
 * Google Calendar read-only sync — Meet events with hangoutLink only.
 */

import type { Env } from "../env.js";
import {
  GcalNotConnectedError,
  getValidAccessToken,
  markGcalSynced,
  setGcalError,
} from "./google-calendar-auth.js";

export interface GcalSyncStats {
  fetched: number;
  upserted: number;
  deleted: number;
  duration_ms: number;
}

interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

export async function syncGoogleCalendarEvents(env: Env): Promise<GcalSyncStats> {
  const start = Date.now();
  const stats: GcalSyncStats = { fetched: 0, upserted: 0, deleted: 0, duration_ms: 0 };

  let token: string;
  try {
    token = await getValidAccessToken(env);
  } catch (err) {
    if (err instanceof GcalNotConnectedError) {
      stats.duration_ms = Date.now() - start;
      return stats;
    }
    throw err;
  }

  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });

  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    { headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
  );

  if (!resp.ok) {
    const text = await resp.text();
    await setGcalError(env, `sync failed (${resp.status}): ${text.slice(0, 300)}`);
    throw new Error(`Google Calendar sync failed: ${resp.status}`);
  }

  const data = (await resp.json()) as { items?: GoogleEvent[] };
  const items = (data.items ?? []).filter((e) => e.hangoutLink && e.id && e.status !== "cancelled");
  stats.fetched = items.length;

  const seenIds = new Set<string>();
  const syncedAt = new Date().toISOString();

  for (const ev of items) {
    const id = ev.id!;
    seenIds.add(id);
    const startTime = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00.000Z` : null);
    const endTime = ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T23:59:59.000Z` : null);
    if (!startTime || !endTime) continue;

    await env.DB.prepare(
      `INSERT INTO google_calendar_events
         (id, calendar_id, title, start_time, end_time, meet_link, description, event_type, synced_at)
       VALUES (?, 'primary', ?, ?, ?, ?, ?, 'meeting', ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         start_time = excluded.start_time,
         end_time = excluded.end_time,
         meet_link = excluded.meet_link,
         description = excluded.description,
         synced_at = excluded.synced_at`,
    )
      .bind(id, ev.summary ?? "Google Meet", startTime, endTime, ev.hangoutLink ?? null, ev.description ?? null, syncedAt)
      .run();
    stats.upserted++;
  }

  // Remove stale Meet events in the sync window that Google no longer returns.
  const stale =
    (
      await env.DB.prepare(
        `SELECT id FROM google_calendar_events
          WHERE meet_link IS NOT NULL
            AND start_time >= ?
            AND start_time <= ?`,
      )
        .bind(timeMin, timeMax)
        .all<{ id: string }>()
    ).results ?? [];

  for (const row of stale) {
    if (!seenIds.has(row.id)) {
      await env.DB.prepare("DELETE FROM google_calendar_events WHERE id = ?").bind(row.id).run();
      stats.deleted++;
    }
  }

  await markGcalSynced(env);
  stats.duration_ms = Date.now() - start;
  return stats;
}

export async function listUpcomingMeetings(env: Env, limit = 5): Promise<
  Array<{
    id: string;
    title: string;
    start_time: string;
    end_time: string;
    meet_link: string | null;
  }>
> {
  const now = new Date().toISOString();
  const rows =
    (
      await env.DB.prepare(
        `SELECT id, title, start_time, end_time, meet_link
           FROM google_calendar_events
          WHERE meet_link IS NOT NULL AND start_time >= ?
          ORDER BY start_time ASC
          LIMIT ?`,
      )
        .bind(now, limit)
        .all<{
          id: string;
          title: string;
          start_time: string;
          end_time: string;
          meet_link: string | null;
        }>()
    ).results ?? [];
  return rows;
}

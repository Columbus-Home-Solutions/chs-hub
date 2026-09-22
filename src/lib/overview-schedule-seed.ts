/**
 * Overview start date → schedule_entries seed.
 *
 * The Schedule Calendar and dashboard Today's Schedule only read
 * schedule_entries. The Overview tab's start date lives on jobs.start_date.
 * When that date is set and the job has no real day-by-day entries yet, we
 * seed one all-day schedule_entries row so the job shows up immediately.
 * Once Tony has built a detailed Schedule-tab plan, Overview edits leave
 * those rows alone.
 */

import type { Env } from "../env.js";

/** Stored in schedule_entries.notes so we can update (not duplicate) the seed. */
export const OVERVIEW_SEED_NOTE = "overview_start_date";

export interface OverviewSeedEntry {
  id: string;
  start_time: string | null;
  end_time: string | null;
  sub_id: string | null;
  notes: string | null;
}

export function isOverviewSeedEntry(entry: OverviewSeedEntry): boolean {
  return (
    !entry.start_time &&
    !entry.end_time &&
    !entry.sub_id &&
    entry.notes === OVERVIEW_SEED_NOTE
  );
}

export function overviewScheduleAction(
  entries: OverviewSeedEntry[],
): "create" | "update" | "leave" {
  if (entries.length === 0) return "create";
  if (entries.length === 1 && isOverviewSeedEntry(entries[0])) return "update";
  return "leave";
}

export function hasDetailedSchedule(entries: OverviewSeedEntry[]): boolean {
  return entries.some((e) => !isOverviewSeedEntry(e));
}

export function jobScheduleTitle(
  title: string | null | undefined,
  jobNumber: number | null | undefined,
): string {
  const num = jobNumber != null ? `JOB-${String(jobNumber).padStart(3, "0")}` : null;
  const t = (title ?? "").trim() || null;
  if (t && num) return `${num} ${t}`;
  return t || num || "Job";
}

export function normalizeScheduleDate(value: string | null | undefined): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, 10);
}

export async function loadJobScheduleEntries(
  env: Env,
  jobId: string,
): Promise<OverviewSeedEntry[]> {
  return (
    (
      await env.DB.prepare(
        `SELECT id, start_time, end_time, sub_id, notes FROM schedule_entries WHERE job_id = ?`,
      )
        .bind(jobId)
        .all<OverviewSeedEntry>()
    ).results ?? []
  );
}

export async function loadScheduleSeedState(
  env: Env,
  jobId: string,
): Promise<{ schedule_entry_count: number; has_detailed_schedule: boolean }> {
  const rows = await loadJobScheduleEntries(env, jobId);
  return {
    schedule_entry_count: rows.length,
    has_detailed_schedule: hasDetailedSchedule(rows),
  };
}

export async function syncOverviewStartDate(
  env: Env,
  jobId: string,
  newStartDate: string | null,
  jobTitle: string | null,
  jobNumber: number | null,
): Promise<"created" | "updated" | "deleted" | "left"> {
  const date = normalizeScheduleDate(newStartDate);
  const rows = await loadJobScheduleEntries(env, jobId);
  const action = overviewScheduleAction(rows);

  if (action === "leave") return "left";

  if (action === "create") {
    if (!date) return "left";
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO schedule_entries
         (id, job_id, scheduled_date, trade_or_work, sub_id, start_time, end_time,
          notes, notification_sent, status, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 0, 'scheduled', datetime('now'))`,
    )
      .bind(id, jobId, date, jobScheduleTitle(jobTitle, jobNumber), OVERVIEW_SEED_NOTE)
      .run();
    return "created";
  }

  const seed = rows[0];
  if (!date) {
    await env.DB.prepare("DELETE FROM schedule_entries WHERE id = ?").bind(seed.id).run();
    return "deleted";
  }

  await env.DB.prepare("UPDATE schedule_entries SET scheduled_date = ? WHERE id = ?")
    .bind(date, seed.id)
    .run();
  return "updated";
}

/** Draft RAG heuristic for the Overall Schedule Timeline (Tony to confirm). */

export type JobRag = "on_track" | "at_risk" | "behind";

export const ACTIVE_SCHEDULE_JOB_STATUSES = [
  "deposit_paid",
  "scheduled",
  "in_progress",
  "punch_list",
] as const;

export function isTerminalJobStatus(status: string | null | undefined): boolean {
  return status === "complete" || status === "closed";
}

export function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = String(value).trim();
  return s ? s.slice(0, 10) : null;
}

export function isOutOfRangeEntry(
  scheduledDate: string | null | undefined,
  targetEndDate: string | null | undefined,
): boolean {
  const scheduled = dateOnly(scheduledDate);
  const target = dateOnly(targetEndDate);
  if (!scheduled || !target) return false;
  return scheduled > target;
}

export function daysPastTarget(
  scheduledDate: string,
  targetEndDate: string,
): number {
  const a = Date.parse(`${dateOnly(scheduledDate)}T00:00:00Z`);
  const b = Date.parse(`${dateOnly(targetEndDate)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((a - b) / 86_400_000);
}

export function overallScheduleProgress(
  startDate: string | null | undefined,
  targetEndDate: string | null | undefined,
  today: string,
): { hasRange: boolean; dayCount: number | null; pct: number } {
  const start = dateOnly(startDate);
  const end = dateOnly(targetEndDate);
  const now = dateOnly(today);
  if (!start || !end || !now) return { hasRange: false, dayCount: null, pct: 0 };
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  const t = Date.parse(`${now}T00:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e) || Number.isNaN(t) || e < s) {
    return { hasRange: false, dayCount: null, pct: 0 };
  }
  const dayCount = Math.round((e - s) / 86_400_000) + 1;
  if (t <= s) return { hasRange: true, dayCount, pct: 0 };
  if (t >= e) return { hasRange: true, dayCount, pct: 100 };
  return { hasRange: true, dayCount, pct: ((t - s) / (e - s)) * 100 };
}

/**
 * behind  — target end has passed and the job is still open
 * at_risk — scheduled (not yet passed) permit inspection, or a day-by-day
 *           entry after target_end_date
 * on_track — everything else, including complete/closed and jobs with no dates
 */
export function computeJobRag(input: {
  status: string | null;
  targetEndDate: string | null;
  today: string;
  hasIncompletePermitInspection: boolean;
  hasOutOfRangeEntry: boolean;
}): JobRag {
  if (
    !isTerminalJobStatus(input.status) &&
    dateOnly(input.targetEndDate) &&
    dateOnly(input.targetEndDate)! < dateOnly(input.today)!
  ) {
    return "behind";
  }
  if (input.hasIncompletePermitInspection || input.hasOutOfRangeEntry) {
    return "at_risk";
  }
  return "on_track";
}

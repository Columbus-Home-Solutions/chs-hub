/** Monday–Sunday labor weeks in America/Chicago. Calendar math is on YYYY-MM-DD strings. */

export const LABOR_TIME_ZONE = "America/Chicago";

export const POST_DEPOSIT_JOB_STATUSES = [
  "deposit_paid",
  "scheduled",
  "in_progress",
  "punch_list",
  "complete",
] as const;

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function centralDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: LABOR_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, from the calendar date (not the local timezone). */
export function weekdayIndex(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function weekStartMonday(iso: string): string {
  const day = weekdayIndex(iso);
  const delta = day === 0 ? -6 : 1 - day;
  return addDays(iso, delta);
}

export function weekBounds(iso: string): { start: string; end: string } {
  const start = weekStartMonday(iso);
  return { start, end: addDays(start, 6) };
}

/** A week is closed once its Sunday is in the past (Central calendar date). */
export function isWeekClosed(weekEnd: string, today: string): boolean {
  return today > weekEnd;
}

/** Friday after the Sunday the week ends. */
export function payDateForWeek(weekEnd: string): string {
  return addDays(weekEnd, 5);
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

export function datesInWeek(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function lineTotal(days: number, rate: number): number {
  return round2(days * rate);
}

export function daysLabel(days: number): string {
  return Number.isInteger(days) ? String(days) : days.toFixed(1);
}

export interface UnpaidLaborSlice {
  work_date: string;
  sub_id: string;
  days: number;
  day_rate: number;
}

/**
 * The most recent week whose Sunday has passed.
 * Null only when `today` cannot be placed (not used for an open current week).
 */
export function mostRecentClosedWeek(today: string): { start: string; end: string } {
  const day = weekdayIndex(today);
  const daysBack = day === 0 ? 7 : day;
  const end = addDays(today, -daysBack);
  return { start: addDays(end, -6), end };
}

/** Friday on or after `today` (Central calendar date). */
export function nextPayFriday(today: string): string {
  const day = weekdayIndex(today);
  const delta = day <= 5 ? 5 - day : 6;
  return addDays(today, delta);
}

export type WeekPayState = "open" | "closed_unpaid" | "partly_paid" | "paid";

/** Open until Sunday has passed. After that, paid / partly paid / unpaid from the day's dollars. */
export function weekPayState(
  today: string,
  weekEnd: string,
  paidAmount: number,
  unpaidAmount: number,
): WeekPayState {
  if (!isWeekClosed(weekEnd, today)) return "open";
  if (unpaidAmount <= 0 && paidAmount > 0) return "paid";
  if (paidAmount > 0 && unpaidAmount > 0) return "partly_paid";
  return "closed_unpaid";
}

export interface UnpaidWeekSlice {
  week_start: string;
  week_end: string;
  unpaid: number;
}

/**
 * Aggregate unpaid closed weeks. High when any of those weeks is on or past its pay Friday.
 * Open-week slices must be omitted by the caller.
 */
export function laborUnpaidAggregate(
  today: string,
  weeks: UnpaidWeekSlice[],
): {
  weeks: number;
  total: number;
  oldest: string;
  priority: "medium" | "high";
} | null {
  const unpaid = weeks.filter((week) => week.unpaid > 0 && isWeekClosed(week.week_end, today));
  if (unpaid.length === 0) return null;
  unpaid.sort((a, b) => (a.week_start < b.week_start ? -1 : 1));
  const priority = unpaid.some((week) => today >= payDateForWeek(week.week_end)) ? "high" : "medium";
  return {
    weeks: unpaid.length,
    total: round2(unpaid.reduce((sum, week) => sum + week.unpaid, 0)),
    oldest: unpaid[0].week_start,
    priority,
  };
}

/** Kept for the original most-recent-week signal. The dashboard uses {@link laborUnpaidAggregate}. */
export function laborPayrollSignal(
  today: string,
  entries: UnpaidLaborSlice[],
  paidWeekStarts: string[],
): {
  week_start: string;
  week_end: string;
  pay_date: string;
  total: number;
  workers: number;
  priority: "medium" | "high";
} | null {
  const { start, end } = mostRecentClosedWeek(today);
  if (paidWeekStarts.includes(start)) return null;
  const rows = entries.filter((entry) => entry.work_date >= start && entry.work_date <= end);
  if (rows.length === 0) return null;
  const pay_date = payDateForWeek(end);
  const total = round2(rows.reduce((sum, row) => sum + row.days * row.day_rate, 0));
  return {
    week_start: start,
    week_end: end,
    pay_date,
    total,
    workers: new Set(rows.map((row) => row.sub_id)).size,
    priority: today >= pay_date ? "high" : "medium",
  };
}

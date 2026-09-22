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

export function daysPastTarget(scheduledDate: string, targetEndDate: string): number {
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

export function countdownLabel(date: string, startTime: string | null, now = new Date()): string {
  const iso = startTime && startTime.length >= 4 ? `${date}T${startTime.slice(0, 5)}:00` : `${date}T12:00:00`;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const ms = then.getTime() - now.getTime();
  if (ms <= 0) return "now";
  const hrs = Math.round(ms / 3_600_000);
  if (hrs < 24) return `in ${hrs} hr${hrs === 1 ? "" : "s"}`;
  const days = Math.round(hrs / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

export function startOfMondayWeek(d: Date): Date {
  const x = new Date(d);
  const day = x.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setUTCDate(x.getUTCDate() + diff);
  return x;
}

export function initials(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "?";
  const parts = n.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return ((parts[0][0] ?? "") + (parts[parts.length - 1][0] ?? "")).toUpperCase();
}

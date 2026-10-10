/**
 * Customer self-scheduling. Slot math only — no Google calls and no writes.
 * Every clock time is America/Chicago, including across daylight saving.
 */

import { CHS_TIMEZONE, centralClockToUtc, centralParts } from "./central-send-window.js";

export const BOOKING_SOURCE = "customer_self_scheduled";
export const BOOKING_PHONE = "501-263-2050";
export const BOOKABLE_STATUSES = ["new_request", "contacted"] as const;
export const TOKEN_TTL_MS = 21 * 24 * 60 * 60 * 1000;

export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface SchedulingRules {
  enabled: boolean;
  days: number[];
  startMin: number;
  endMin: number;
  visitMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  horizonDays: number;
  maxPerDay: number;
  slotMinutes: number;
  blockedDates: string[];
}

export interface OpenSlot {
  start: string;
  date: string;
  label: string;
}

export const DEFAULT_RULES: SchedulingRules = {
  enabled: false,
  days: [1, 2, 3, 4, 5, 6],
  startMin: 8 * 60,
  endMin: 17 * 60,
  visitMinutes: 60,
  bufferMinutes: 30,
  minNoticeHours: 4,
  horizonDays: 14,
  maxPerDay: 2,
  slotMinutes: 30,
  blockedDates: [],
};

export function parseRules(values: Record<string, string | null | undefined>): SchedulingRules {
  const num = (key: string, fallback: number) => {
    const raw = values[key];
    if (raw == null || raw.trim() === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const clock = (key: string, fallback: number) => {
    const parsed = parseClock(values[key] ?? "");
    return parsed ?? fallback;
  };
  const dayRaw = (values.scheduling_days ?? "").trim();
  const days = dayRaw
    ? dayRaw
        .split(",")
        .map((d) => Number(d.trim()))
        .filter((d) => d >= 0 && d <= 6)
    : [];
  const blocked = (values.scheduling_blocked_dates ?? "")
    .split(/[,\s]+/)
    .map((d) => d.trim())
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const enabledRaw = (values.scheduling_enabled ?? "0").trim().toLowerCase();
  return {
    enabled: enabledRaw === "1" || enabledRaw === "true" || enabledRaw === "on",
    days: days.length ? days : DEFAULT_RULES.days,
    startMin: clock("scheduling_start", DEFAULT_RULES.startMin),
    endMin: clock("scheduling_end", DEFAULT_RULES.endMin),
    visitMinutes: Math.max(15, num("scheduling_visit_minutes", DEFAULT_RULES.visitMinutes)),
    bufferMinutes: num("scheduling_buffer_minutes", DEFAULT_RULES.bufferMinutes),
    minNoticeHours: num("scheduling_min_notice_hours", DEFAULT_RULES.minNoticeHours),
    horizonDays: Math.max(1, num("scheduling_horizon_days", DEFAULT_RULES.horizonDays)),
    maxPerDay: Math.max(0, num("scheduling_max_per_day", DEFAULT_RULES.maxPerDay)),
    slotMinutes: Math.max(15, num("scheduling_slot_minutes", DEFAULT_RULES.slotMinutes)),
    blockedDates: blocked,
  };
}

export function parseClock(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = value.trim();
  const ampm = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ampm) {
    let h = Number(ampm[1]);
    const m = Number(ampm[2]);
    const ap = ampm[3].toUpperCase();
    if (ap === "PM" && h < 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  }
  const hm = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!hm) return null;
  const h = Number(hm[1]);
  const m = Number(hm[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

export function centralDateKey(instant: Date): string {
  const p = centralParts(instant);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function weekdayIndex(year: number, month: number, day: number): number {
  const noon = centralClockToUtc(year, month, day, 12, 0);
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: CHS_TIMEZONE,
    weekday: "short",
  }).format(noon);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

function addCivilDays(year: number, month: number, day: number, n: number) {
  const t = new Date(Date.UTC(year, month - 1, day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && a1 > b0;
}

export function expandBusy(busy: BusyInterval[], bufferMinutes: number): BusyInterval[] {
  const pad = bufferMinutes * 60_000;
  return busy
    .filter((b) => b.end.getTime() > b.start.getTime())
    .map((b) => ({
      start: new Date(b.start.getTime() - pad),
      end: new Date(b.end.getTime() + pad),
    }));
}

export function formatSlotLabel(instant: Date): string {
  return instant
    .toLocaleTimeString("en-US", {
      timeZone: CHS_TIMEZONE,
      hour: "numeric",
      minute: "2-digit",
    })
    .replace(/\u202f/g, " ");
}

export function formatCentralWhen(instant: Date): string {
  return instant
    .toLocaleString("en-US", {
      timeZone: CHS_TIMEZONE,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
    .replace(/\u202f/g, " ");
}

/**
 * Open visit starts. Busy intervals already include travel buffer.
 * selfBookedByDate counts customer-booked visits already on that Central day.
 */
export function generateSlots(args: {
  now: Date;
  rules: SchedulingRules;
  busy: BusyInterval[];
  selfBookedByDate?: Record<string, number>;
}): OpenSlot[] {
  const { now, rules } = args;
  const counts = args.selfBookedByDate ?? {};
  const blocked = new Set(rules.blockedDates);
  const expanded = expandBusy(args.busy, rules.bufferMinutes);
  const today = centralParts(now);
  const slots: OpenSlot[] = [];
  const noticeMs = rules.minNoticeHours * 3_600_000;

  for (let offset = 0; offset <= rules.horizonDays; offset++) {
    const civil = addCivilDays(today.year, today.month, today.day, offset);
    const date = `${civil.year}-${String(civil.month).padStart(2, "0")}-${String(civil.day).padStart(2, "0")}`;
    if (blocked.has(date)) continue;
    if (!rules.days.includes(weekdayIndex(civil.year, civil.month, civil.day))) continue;
    if ((counts[date] ?? 0) >= rules.maxPerDay) continue;

    for (let minute = rules.startMin; minute + rules.visitMinutes <= rules.endMin; minute += rules.slotMinutes) {
      const start = centralClockToUtc(civil.year, civil.month, civil.day, Math.floor(minute / 60), minute % 60);
      const end = new Date(start.getTime() + rules.visitMinutes * 60_000);
      if (start.getTime() < now.getTime() + noticeMs) continue;
      const hit = expanded.some((b) => overlaps(start.getTime(), end.getTime(), b.start.getTime(), b.end.getTime()));
      if (hit) continue;
      slots.push({ start: start.toISOString(), date, label: formatSlotLabel(start) });
    }
  }
  return slots;
}

/** A CHS schedule or warranty row, turned into a busy interval. No titles. */
export function rowToBusy(
  dateRaw: string | null | undefined,
  startRaw: string | null | undefined,
  endRaw: string | null | undefined,
  rules: SchedulingRules,
): BusyInterval | null {
  if (!dateRaw) return null;
  const date = dateRaw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split("-").map(Number);
  const startMin = parseClock(startRaw) ?? (startRaw && startRaw.includes("T") ? null : rules.startMin);
  const endMin = parseClock(endRaw);

  if (startRaw && startRaw.includes("T") && endRaw && endRaw.includes("T")) {
    const start = new Date(startRaw);
    const end = new Date(endRaw);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    return { start, end };
  }

  const from = startMin ?? rules.startMin;
  const to = endMin ?? rules.endMin;
  if (to <= from) return null;
  return {
    start: centralClockToUtc(year, month, day, Math.floor(from / 60), from % 60),
    end: centralClockToUtc(year, month, day, Math.floor(to / 60), to % 60),
  };
}

export function appointmentToBusy(iso: string | null | undefined, visitMinutes: number): BusyInterval | null {
  if (!iso) return null;
  const start = new Date(iso.includes("T") ? iso : `${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  if (!iso.includes("T")) {
    return null;
  }
  return { start, end: new Date(start.getTime() + visitMinutes * 60_000) };
}

/**
 * Central-Time date helpers for the WC Spreadsheet sync (Module-Spec §5.2, §9).
 *
 * The Worker runs in UTC; every week/month boundary is America/Chicago. These
 * helpers are pure + exported so the row-discovery and bucketing logic is unit
 * testable without hitting D1 or Sheets.
 *
 * Conventions:
 *   - A "CT date" is a YYYY-MM-DD string in America/Chicago.
 *   - Weeks run Sunday 00:00 → Saturday 23:59:59 CT.
 *   - Internally we represent a calendar date as a UTC-midnight Date so that
 *     date arithmetic (add days, compare) is DST-proof — we never do clock math.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Parts of a calendar date. month is 1..12. */
export interface DateParts {
  year: number;
  month: number;
  day: number;
}

/** Format a Date's UTC Y/M/D as YYYY-MM-DD (no time). */
export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** A UTC-midnight Date for the given calendar parts. */
export function utcDate(p: DateParts): Date {
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}

/**
 * Convert an instant (or stored timestamp string) to its calendar date in CT.
 * Accepts ISO date ("2026-05-24") or datetime; date-only strings are treated as
 * that calendar date (no timezone shift). Returns YYYY-MM-DD in CT.
 */
export function toCtDate(value: string | number | Date): string {
  let instant: Date;
  if (value instanceof Date) {
    instant = value;
  } else if (typeof value === "number") {
    instant = new Date(value);
  } else {
    const s = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // bare date → no shift
    // bare datetime without timezone → assume UTC
    instant = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  }
  if (Number.isNaN(instant.getTime())) return "";
  return ctPartsToYmd(instant);
}

function ctPartsToYmd(instant: Date): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Today's calendar date in CT, as parts. */
export function ctToday(now: Date = new Date()): DateParts {
  const s = ctPartsToYmd(now);
  const [y, m, d] = s.split("-").map(Number);
  return { year: y, month: m, day: d };
}

export interface WeekBounds {
  start: string; // ISO date, Sunday
  end: string; // ISO date, Saturday (inclusive)
  endExclusive: string; // ISO date, next Sunday
}

/** Current Sun→Sat week (CT) containing `now`. */
export function ctWeekBounds(now: Date = new Date()): WeekBounds {
  const today = utcDate(ctToday(now));
  const dow = today.getUTCDay(); // 0=Sun
  const start = new Date(today);
  start.setUTCDate(today.getUTCDate() - dow);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const endExclusive = new Date(start);
  endExclusive.setUTCDate(start.getUTCDate() + 7);
  return { start: ymd(start), end: ymd(end), endExclusive: ymd(endExclusive) };
}

export interface MonthBounds {
  start: string; // first day ISO
  endExclusive: string; // first day of next month ISO
  monthIndex: number; // 1..12
  year: number;
  label: string; // "Jan"
}

/** Current month (CT) containing `now`. */
export function ctMonthBounds(now: Date = new Date()): MonthBounds {
  const t = ctToday(now);
  const start = utcDate({ year: t.year, month: t.month, day: 1 });
  const nextMonth = t.month === 12 ? 1 : t.month + 1;
  const nextYear = t.month === 12 ? t.year + 1 : t.year;
  const endExclusive = utcDate({ year: nextYear, month: nextMonth, day: 1 });
  return {
    start: ymd(start),
    endExclusive: ymd(endExclusive),
    monthIndex: t.month,
    year: t.year,
    label: MONTHS[t.month - 1],
  };
}

/** The Sunday (ISO) of the week containing the given CT date string. */
export function sundayOf(ctDateStr: string): string {
  const [y, m, d] = ctDateStr.split("-").map(Number);
  const date = utcDate({ year: y, month: m, day: d });
  const dow = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - dow);
  return ymd(date);
}

/**
 * Parse a short M/D cell value (e.g. "5/24", "12/28") or a Google Sheets serial
 * date number, returning { month, day } (1-based month). Returns null if not a
 * recognizable date. Year is NOT inferred here (the caller aligns the year).
 */
export function parseShortDate(cell: string | number | null): { month: number; day: number } | null {
  if (cell == null) return null;
  if (typeof cell === "number") {
    // Google Sheets serial date (epoch Dec 30 1899).
    const ms = Date.UTC(1899, 11, 30) + cell * 86400 * 1000;
    const d = new Date(ms);
    return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }
  const m = String(cell).match(/(\d{1,2})\s*[/\-]\s*(\d{1,2})/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

/** Format Sun→Sat ISO bounds as a Marketing Tallies weekly period label (e.g. "7/19 - 7/25"). */
export function formatMarketingWeekLabel(weekStart: string, weekEnd: string): string {
  const short = (iso: string) => {
    const [, month, day] = iso.split("-").map(Number);
    return `${month}/${day}`;
  };
  return `${short(weekStart)} - ${short(weekEnd)}`;
}

/** Parse a merged "Weekly Period" label like "7/12 - 7/18" or "7/12/2026 - 7/18/2026". */
export function parseWeekRange(cell: string | number | null): { start: string | number; end: string | number } | null {
  if (cell == null || typeof cell === "number") return null;
  const m = String(cell).match(
    /(\d{1,2}\s*[/\-]\s*\d{1,2}(?:\s*[/\-]\s*\d{2,4})?)\s*[-–—]\s*(\d{1,2}\s*[/\-]\s*\d{1,2}(?:\s*[/\-]\s*\d{2,4})?)/,
  );
  if (!m) return null;
  return { start: m[1].trim(), end: m[2].trim() };
}

/** Marketing Tallies row matcher — handles merged A:B period labels. */
export function marketingRowMatches(
  startCell: string | number | null,
  endCell: string | number | null,
  today: DateParts,
): boolean {
  if (kpiRowMatches(startCell, endCell, today)) return true;
  const merged = parseWeekRange(startCell);
  if (merged && kpiRowMatches(merged.start, merged.end, today)) return true;
  if (endCell == null || endCell === "") {
    // Merged Weekly Period: only col A populated — infer Sat as start+6 serial days.
    if (typeof startCell === "number" && kpiRowMatches(startCell, startCell + 6, today)) return true;
    if (kpiRowMatches(startCell, startCell, today)) return true;
  }
  return false;
}

function cellToIso(cell: string | number | null, baseYear: number): string | null {
  const parsed = parseShortDate(cell);
  if (!parsed) return null;
  return `${baseYear}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`;
}

/** Match a marketing row's period label to explicit Sun→Sat week bounds. */
export function marketingRowMatchesWeek(
  startCell: string | number | null,
  endCell: string | number | null,
  weekStart: string,
  weekEnd: string,
  today: DateParts,
): boolean {
  if (marketingRowMatches(startCell, endCell, today)) return true;
  const merged = parseWeekRange(startCell);
  const startRaw = merged?.start ?? startCell;
  const endRaw = merged?.end ?? endCell;
  for (const baseYear of [today.year - 1, today.year, today.year + 1]) {
    const startIso = cellToIso(startRaw, baseYear);
    if (!startIso) continue;
    const endIso = cellToIso(endRaw, baseYear) ?? startIso;
    const rowWeekStart = sundayOf(startIso);
    if (rowWeekStart === weekStart && endIso === weekEnd) return true;
    if (startIso === weekStart && endIso === weekEnd) return true;
  }
  return false;
}

/**
 * KPI row matcher (§5.2): does `today` fall between the row's start (col A) and
 * end (col B) short dates, inclusive? Years are absent in the sheet, so we test
 * the row against today's year ±1 to handle year-boundary weeks like
 * "12/28"→"1/3" regardless of which side of New Year today sits.
 */
export function kpiRowMatches(
  startCell: string | number | null,
  endCell: string | number | null,
  today: DateParts,
): boolean {
  const s = parseShortDate(startCell);
  const e = parseShortDate(endCell);
  if (!s || !e) return false;
  const todayUtc = utcDate(today);
  for (const baseYear of [today.year - 1, today.year, today.year + 1]) {
    const start = utcDate({ year: baseYear, month: s.month, day: s.day });
    let end = utcDate({ year: baseYear, month: e.month, day: e.day });
    if (end < start) end = utcDate({ year: baseYear + 1, month: e.month, day: e.day });
    if (start <= todayUtc && todayUtc <= end) return true;
  }
  return false;
}

/** Match a month label cell ("Jan", "January", "1") to a 1..12 month index. */
export function monthLabelMatches(cell: string | number | null, monthIndex: number): boolean {
  if (cell == null) return false;
  if (typeof cell === "number") return cell === monthIndex;
  const s = String(cell).trim().toLowerCase();
  const target = MONTHS[monthIndex - 1].toLowerCase();
  return s.startsWith(target) || s === String(monthIndex);
}

/** Semantic lead-source bucket for Marketing Tallies (column letter comes from settings). */
export type LeadSourceBucket = "organic" | "adwords" | "lsa" | "facebook" | "referral" | "repeat" | "other";

/** Map a CHS lead_source value → Marketing Tallies bucket (§4.2). */
export function leadSourceBucket(leadSource: string | null | undefined): LeadSourceBucket {
  switch ((leadSource ?? "").toLowerCase()) {
    case "organic_google":
      return "organic";
    case "google_adwords":
      return "adwords";
    case "google_lsa":
      return "lsa";
    case "facebook":
      return "facebook";
    case "referral":
      return "referral";
    case "repeat_client":
      return "repeat";
    default:
      return "other"; // thumbtack, website, website_form, direct_call, other, null
  }
}

/** @deprecated Use leadSourceBucket — column letters are configured in system_settings. */
export function leadSourceColumn(leadSource: string | null | undefined): "F" | "G" | "I" | "K" | "M" | "N" | "O" {
  const bucket = leadSourceBucket(leadSource);
  const legacy: Record<LeadSourceBucket, "F" | "G" | "I" | "K" | "M" | "N" | "O"> = {
    organic: "F",
    adwords: "G",
    lsa: "I",
    facebook: "K",
    referral: "M",
    repeat: "N",
    other: "O",
  };
  return legacy[bucket];
}

export { MONTHS };

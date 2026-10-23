/** Shared formatting helpers (CHS-Design-System.md §7). */

export function formatCurrency(amount: number | null | undefined): string {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  // Date-only (YYYY-MM-DD) — parse as local calendar day to avoid UTC→Central
  // shifting "Aug 23" back to "Aug 22" in the evening.
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (dayOnly) {
    const y = Number(dayOnly[1]);
    const m = Number(dayOnly[2]);
    const d = Number(dayOnly[3]);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const CENTRAL_DATE_TIME: Intl.DateTimeFormatOptions = {
  timeZone: "America/Chicago",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

/** A stored clock time, not a calendar date alone. */
function hasTimeOfDay(value: string): boolean {
  return /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value.trim());
}

/**
 * Stored instants are UTC. D1 `datetime('now')` is `YYYY-MM-DD HH:MM:SS` with
 * no zone. ISO strings may end in `Z` or an offset. Both mean the same moment.
 */
export function parseStoredUtc(value: string): Date | null {
  const raw = value.trim();
  if (!hasTimeOfDay(raw)) return null;
  let iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso += "Z";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Clock time in America/Chicago, including daylight saving. */
export function formatDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const timed = parseStoredUtc(dateStr);
  if (timed) return timed.toLocaleString("en-US", CENTRAL_DATE_TIME);
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** `datetime-local` input value from an ISO timestamp (local timezone). */
export function isoToDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO timestamp from a `datetime-local` input value, or null when empty. */
export function datetimeLocalToIso(local: string | null | undefined): string | null {
  if (!local?.trim()) return null;
  const d = new Date(local);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function formatStatus(status: string | null | undefined): string {
  if (!status) return "—";
  if (status === "fifty_fifty") return "50/50";
  if (status === "google_lsa") return "Google LSA";
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return "—";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

/** Jobber-style address: "12 Seminole Circle / Austin, Arkansas 72007" */
export function formatPropertySlashLine(opts: {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): string {
  const street = (opts.address ?? "").trim();
  const cityStateZip = [opts.city, [opts.state, opts.zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ")
    .trim();
  if (street && cityStateZip) return `${street} / ${cityStateZip}`;
  return street || cityStateZip;
}

export function initials(first?: string | null, last?: string | null, fallback?: string | null): string {
  const a = (first || "").trim()[0] ?? "";
  const b = (last || "").trim()[0] ?? "";
  const out = (a + b).toUpperCase();
  if (out) return out;
  return (fallback || "?").trim()[0]?.toUpperCase() ?? "?";
}

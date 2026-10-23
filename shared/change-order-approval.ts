/** Off-platform change-order approval. Never an e-signature. */

export const MANUAL_APPROVAL_SOURCE = "manual_owner";

export const MANUAL_METHODS = ["phone", "text", "in_person", "other"] as const;
export type ManualMethod = (typeof MANUAL_METHODS)[number];

const FUTURE_SKEW_MS = 60_000;

export function isManualMethod(value: string | null | undefined): value is ManualMethod {
  return !!value && (MANUAL_METHODS as readonly string[]).includes(value);
}

/** Spoken method, used in badges, the portal line, and the document stamp. */
export function manualMethodPhrase(method: string): string {
  if (method === "in_person") return "in person";
  if (method === "phone" || method === "text" || method === "other") return method;
  return "phone";
}

/** "MMMM D, YYYY" in America/Chicago. Matches document-generator formatDate. */
export function formatCentralLongDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value.includes("T") ? value : value + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  }).format(d);
}

export function manualApprovalBadge(method: string, recorderName: string): string {
  const who = recorderName.trim() || "Owner";
  return `Approved by ${manualMethodPhrase(method)} — recorded by ${who}`;
}

export function portalApprovalLabel(method: string, approvedAtIso: string): string {
  return `Approved by ${manualMethodPhrase(method)} on ${formatCentralLongDate(approvedAtIso)}.`;
}

/**
 * Honest stamp for {{client_signature}}. The live template uses that tag for
 * both the signature line and the printed-name line.
 */
export function manualApprovalStamp(method: string, approvedAtIso: string): string {
  return `Approved by customer via ${manualMethodPhrase(method)} on ${formatCentralLongDate(approvedAtIso)} — recorded by Columbus Home Solutions`;
}

export function centralLocalToUtcIso(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcGuess));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const asCentral = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  const diff = asCentral - utcGuess;
  return new Date(utcGuess - diff).toISOString();
}

/** datetime-local value for "now" on the Central clock. */
export function nowCentralLocalInput(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}

export function manualApprovalError(input: {
  method: string | null;
  approvedAt: string | null;
  note: string | null;
  confirmed: boolean;
  nowMs?: number;
}): string | null {
  if (!input.confirmed) return "Confirmation is required.";
  if (!isManualMethod(input.method)) return "method must be phone, text, in_person, or other.";
  if (!input.approvedAt) return "approved_at is required.";
  const when = Date.parse(input.approvedAt);
  if (!Number.isFinite(when)) return "approved_at must be a UTC timestamp.";
  const now = input.nowMs ?? Date.now();
  if (when > now + FUTURE_SKEW_MS) return "approved_at cannot be in the future.";
  const note = (input.note ?? "").trim();
  if (note.length < 10) return "note must be at least 10 characters.";
  return null;
}

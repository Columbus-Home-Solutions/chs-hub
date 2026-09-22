/**
 * Message Center Unassigned tab helpers.
 *
 * Unknown-caller missed-call logs live in `smart_notes` (job_id IS NULL,
 * entered_via = 'missed_call') and are already listed by GET /api/voice-notes/unmatched.
 * The Unassigned tab filters that existing payload — it does not merge with
 * SMS `communications` threads.
 *
 * Dismiss uses the same localStorage key as Unassigned Voice Notes so the two
 * review surfaces stay in sync.
 */

export const UNASSIGNED_VOICE_NOTES_DISMISS_KEY = "chs_voice_notes_dismissed";

export interface UnassignedVoiceNote {
  id: string;
  raw_content: string;
  entered_via: string;
  callback_phone: string | null;
  created_at: string;
  processing_status?: string | null;
}

/** Same `tel:` construction as Unassigned Voice Notes — reuse, don't invent. */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `tel:+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `tel:+${digits}`;
  if (digits.length >= 10) return `tel:+${digits}`;
  return null;
}

export function parseDismissedIds(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

export function serializeDismissedIds(ids: Iterable<string>): string {
  return JSON.stringify([...ids]);
}

/** Missed-call logs only, most recent first. Voice notes stay on their own page. */
export function missedCallUnassignedNotes<T extends { entered_via: string; created_at: string }>(
  notes: T[],
): T[] {
  return notes
    .filter((n) => n.entered_via === "missed_call")
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

export function countUnreviewedMissedCalls(
  notes: { id: string; entered_via: string }[],
  dismissedIds: Iterable<string>,
): number {
  const dismissed = dismissedIds instanceof Set ? dismissedIds : new Set(dismissedIds);
  return notes.filter((n) => n.entered_via === "missed_call" && !dismissed.has(n.id)).length;
}

export function combinedMessageCenterBadge(smsUnread: number, unassignedUnreviewed: number): number {
  return Math.max(0, smsUnread) + Math.max(0, unassignedUnreviewed);
}

/**
 * Organizational state for SMS conversations (Message Center Clients tab).
 *
 * Conversations are derived by grouping `communications` on client_id — there
 * is no conversation entity. This state hangs off client_id and is created
 * lazily on first Archive / Flag / Pin / Mark-unread action.
 *
 * Flag and Pin are manual/visual only. Nothing in Lead Outreach or quote
 * follow-ups reads these fields.
 */

export interface ConversationState {
  archived_at: string | null;
  flagged_at: string | null;
  pinned_at: string | null;
  unread_override_at: string | null;
}

export interface ConversationStatePatch {
  archived?: boolean;
  flagged?: boolean;
  pinned?: boolean;
  unread?: boolean;
}

export const EMPTY_CONVERSATION_STATE: ConversationState = {
  archived_at: null,
  flagged_at: null,
  pinned_at: null,
  unread_override_at: null,
};

export function applyConversationStatePatch(
  current: ConversationState | null,
  patch: ConversationStatePatch,
  now: string,
): ConversationState {
  const next: ConversationState = { ...(current ?? EMPTY_CONVERSATION_STATE) };
  if (patch.archived === true) next.archived_at = now;
  if (patch.archived === false) next.archived_at = null;
  if (patch.flagged === true) next.flagged_at = now;
  if (patch.flagged === false) next.flagged_at = null;
  if (patch.pinned === true) next.pinned_at = now;
  if (patch.pinned === false) next.pinned_at = null;
  if (patch.unread === true) next.unread_override_at = now;
  if (patch.unread === false) next.unread_override_at = null;
  return next;
}

export function parseConversationStatePatch(
  body: unknown,
): { ok: true; patch: ConversationStatePatch } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid JSON body" };
  }
  const raw = body as Record<string, unknown>;
  const patch: ConversationStatePatch = {};
  for (const key of ["archived", "flagged", "pinned", "unread"] as const) {
    if (!(key in raw)) continue;
    if (typeof raw[key] !== "boolean") {
      return { ok: false, error: `${key} must be a boolean` };
    }
    patch[key] = raw[key];
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "No fields to update" };
  }
  return { ok: true, patch };
}

export function conversationIsUnread(c: {
  unread_count: number;
  unread_override: boolean;
}): boolean {
  return c.unread_count > 0 || c.unread_override;
}

/** Badge contribution: genuine inbound unread, or 1 if only mark-unread is set. */
export function conversationUnreadContribution(c: {
  unread_count: number;
  unread_override: boolean;
}): number {
  if (c.unread_count > 0) return c.unread_count;
  if (c.unread_override) return 1;
  return 0;
}

export function sumConversationUnread(
  rows: { unread_count: number; unread_override: boolean }[],
): number {
  return rows.reduce((sum, c) => sum + conversationUnreadContribution(c), 0);
}

export function filterConversationsByArchive<T extends { archived_at: string | null }>(
  rows: T[],
  archived: boolean,
): T[] {
  return rows.filter((r) => (r.archived_at != null) === archived);
}

/** Pinned first, then recency (newest last_message_at first). */
export function sortConversationsForList<
  T extends { pinned_at: string | null; last_message_at: string },
>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => {
    const ap = a.pinned_at ? 0 : 1;
    const bp = b.pinned_at ? 0 : 1;
    if (ap !== bp) return ap - bp;
    if (a.last_message_at === b.last_message_at) return 0;
    return a.last_message_at < b.last_message_at ? 1 : -1;
  });
}

import type { Env } from "../env.js";
import {
  applyConversationStatePatch,
  type ConversationState,
  type ConversationStatePatch,
} from "../../shared/sms-conversation-state.js";

export {
  applyConversationStatePatch,
  conversationIsUnread,
  conversationUnreadContribution,
  filterConversationsByArchive,
  parseConversationStatePatch,
  sortConversationsForList,
  sumConversationUnread,
  EMPTY_CONVERSATION_STATE,
} from "../../shared/sms-conversation-state.js";
export type { ConversationState, ConversationStatePatch } from "../../shared/sms-conversation-state.js";

export async function loadConversationState(
  env: Env,
  clientId: string,
): Promise<ConversationState | null> {
  const row = await env.DB.prepare(
    `SELECT archived_at, flagged_at, pinned_at, unread_override_at
     FROM sms_conversation_state WHERE client_id = ?`,
  )
    .bind(clientId)
    .first<ConversationState>();
  return row ?? null;
}

export async function upsertConversationState(
  env: Env,
  clientId: string,
  patch: ConversationStatePatch,
): Promise<ConversationState> {
  const nowRow = await env.DB.prepare(`SELECT datetime('now') AS now`).first<{ now: string }>();
  const now = nowRow?.now ?? new Date().toISOString();
  const current = await loadConversationState(env, clientId);
  const next = applyConversationStatePatch(current, patch, now);

  await env.DB.prepare(
    `INSERT INTO sms_conversation_state (
       client_id, archived_at, flagged_at, pinned_at, unread_override_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(client_id) DO UPDATE SET
       archived_at = excluded.archived_at,
       flagged_at = excluded.flagged_at,
       pinned_at = excluded.pinned_at,
       unread_override_at = excluded.unread_override_at,
       updated_at = datetime('now')`,
  )
    .bind(clientId, next.archived_at, next.flagged_at, next.pinned_at, next.unread_override_at)
    .run();

  return next;
}

/** Reply / open-thread side effects: never deletes communications rows. */
export async function clearUnreadOverride(env: Env, clientId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE sms_conversation_state
     SET unread_override_at = NULL, updated_at = datetime('now')
     WHERE client_id = ? AND unread_override_at IS NOT NULL`,
  )
    .bind(clientId)
    .run();
}

export async function unarchiveAndClearUnread(env: Env, clientId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE sms_conversation_state
     SET archived_at = NULL, unread_override_at = NULL, updated_at = datetime('now')
     WHERE client_id = ?`,
  )
    .bind(clientId)
    .run();
}

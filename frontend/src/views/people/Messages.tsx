/**
 * Full-page Messages view under People.
 * Route: /app/people/messages
 *
 * Standard app-shell page (same view-header + content column as Jobs/Clients).
 * Desktop: two-pane list + thread/unassigned detail.
 * Mobile: list → detail with back.
 */
import type { RoutableProps } from "preact-router";
import { route, useRouter } from "preact-router";
import { useEffect, useState, useCallback } from "preact/hooks";
import { api } from "../../api";
import { ConversationList } from "../../components/messages/ConversationList";
import { ThreadView } from "../../components/messages/ThreadView";
import { UnassignedDetail } from "../../components/messages/UnassignedDetail";
import { messagesHref, parseMessagesSearch } from "../../components/messages/href";
import { conversationsUrl } from "../../components/messages/helpers";
import type { Conversation, ConversationsResponse, InboxTab } from "../../components/messages/types";
import { useViewportTier } from "../../hooks/useViewportTier";
import { useMessageCenter } from "../../store/messageCenter";
import {
  countUnreviewedMissedCalls,
  missedCallUnassignedNotes,
  type UnassignedVoiceNote,
} from "@chs/shared/message-center-unassigned";

export function Messages(_props: RoutableProps) {
  const [{ url }] = useRouter();
  const search = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const parsed = parseMessagesSearch(search);
  const tier = useViewportTier();
  const isMobile = tier === "mobile";

  const { dismissedUnassignedIds, dismissUnassigned } = useMessageCenter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [archivedCount, setArchivedCount] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [unassignedNotes, setUnassignedNotes] = useState<UnassignedVoiceNote[]>([]);
  const [loading, setLoading] = useState(true);

  const tab: InboxTab = parsed.tab;
  const selectedClientId = tab === "clients" ? parsed.clientId : null;
  const selectedNoteId = tab === "unassigned" ? parsed.noteId : null;
  const selectedNote = selectedNoteId
    ? unassignedNotes.find((n) => n.id === selectedNoteId) ?? null
    : null;

  const clientsUnread = unreadTotal;
  const unassignedUnreviewed = countUnreviewedMissedCalls(unassignedNotes, dismissedUnassignedIds);

  const loadConversations = useCallback(async (archived: boolean) => {
    try {
      const d = await api.get<ConversationsResponse>(conversationsUrl(archived));
      setConversations(d.conversations ?? []);
      setUnreadTotal(d.unread_total ?? 0);
      setArchivedCount(d.archived_count ?? 0);
    } catch {
      /* stay on last list */
    }
  }, []);

  const navigate = (opts: { tab?: InboxTab; clientId?: string | null; noteId?: string | null }) => {
    route(
      messagesHref({
        tab: opts.tab ?? tab,
        clientId: opts.clientId,
        noteId: opts.noteId,
      }),
      true,
    );
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [sms, unmatched] = await Promise.allSettled([
        api.get<ConversationsResponse>(conversationsUrl(showArchived)),
        api.get<{ notes: UnassignedVoiceNote[] }>("/api/voice-notes/unmatched"),
      ]);
      if (cancelled) return;
      if (sms.status === "fulfilled") {
        setConversations(sms.value.conversations ?? []);
        setUnreadTotal(sms.value.unread_total ?? 0);
        setArchivedCount(sms.value.archived_count ?? 0);
      }
      if (unmatched.status === "fulfilled") {
        setUnassignedNotes(missedCallUnassignedNotes(unmatched.value.notes ?? []));
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [showArchived]);

  const showDetail = Boolean(selectedClientId || selectedNoteId);
  const splitMod =
    isMobile && showDetail
      ? " messages-split--detail-only"
      : isMobile
        ? " messages-split--list-only"
        : "";

  return (
    <div class="messages-page">
      <div class="view-header">
        <div>
          <h1 class="view-title">Messages</h1>
          <p class="view-subtitle">Client SMS threads and unassigned missed-call logs</p>
        </div>
      </div>

      <div class={`messages-split${isMobile ? " messages-split--mobile" : ""}${splitMod}`}>
        <div class="messages-split__list">
          {loading ? (
            <div class="mc-loading">
              <span class="mc-spinner" />
            </div>
          ) : (
            <ConversationList
              variant="page"
              conversations={conversations}
              unassignedNotes={unassignedNotes}
              clientsUnread={clientsUnread}
              unassignedUnreviewed={unassignedUnreviewed}
              dismissedIds={dismissedUnassignedIds}
              onDismissUnassigned={dismissUnassigned}
              onSelect={(clientId) => navigate({ tab: "clients", clientId })}
              tab={tab}
              onTabChange={(next) => navigate({ tab: next })}
              selectedClientId={selectedClientId}
              selectedNoteId={selectedNoteId}
              onSelectUnassigned={(note) =>
                navigate({ tab: "unassigned", noteId: note.id })
              }
              showArchived={showArchived}
              archivedCount={archivedCount}
              onShowArchivedChange={setShowArchived}
              onConversationChanged={() => void loadConversations(showArchived)}
            />
          )}
        </div>

        <div class="messages-split__detail">
          {selectedClientId ? (
            <ThreadView
              clientId={selectedClientId}
              showBack={isMobile}
              showClose={false}
              onBack={() => navigate({ tab: "clients" })}
              onStateChange={() => void loadConversations(showArchived)}
            />
          ) : selectedNote ? (
            <UnassignedDetail
              note={selectedNote}
              dismissedIds={dismissedUnassignedIds}
              onDismiss={(id) => {
                dismissUnassigned(id);
                if (isMobile) navigate({ tab: "unassigned" });
              }}
              onBack={isMobile ? () => navigate({ tab: "unassigned" }) : undefined}
            />
          ) : selectedNoteId && !loading ? (
            <div class="empty-state">
              <div class="empty-state__title">Missed-call log not found</div>
              <div>It may have been assigned or removed.</div>
            </div>
          ) : (
            <div class="empty-state messages-split__placeholder">
              <div class="empty-state__icon">💬</div>
              <div class="empty-state__title">Select a conversation</div>
              <div>Choose a client thread or an unassigned missed-call log.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

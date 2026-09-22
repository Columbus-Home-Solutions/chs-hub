/**
 * MessageCenter — Sprint 24 two-way SMS slide-out panel.
 *
 * Right-anchored drawer, 420px wide on desktop / full-width on mobile.
 * Two states:
 *   State A — Conversation list (default on open) with Clients / Unassigned tabs
 *   State B — Thread view (drill-down to one client)
 *
 * Opens from the 💬 header icon. Can also be opened to a specific client's
 * thread via useMessageCenter().open(clientId).
 *
 * List/thread UI is shared with the full-page Messages view under People.
 */
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { route } from "preact-router";
import { useMessageCenter } from "../store/messageCenter";
import { api } from "../api";
import {
  combinedMessageCenterBadge,
  countUnreviewedMissedCalls,
  missedCallUnassignedNotes,
  type UnassignedVoiceNote,
} from "@chs/shared/message-center-unassigned";
import { ConversationList } from "./messages/ConversationList";
import { ThreadView } from "./messages/ThreadView";
import { NewCompose } from "./messages/NewCompose";
import { messagesHref } from "./messages/href";
import { conversationsUrl } from "./messages/helpers";
import type { Conversation, ConversationsResponse, InboxTab } from "./messages/types";

type PanelState = "list" | "thread" | "compose";

export function MessageCenter() {
  const {
    isOpen,
    activeClientId,
    pendingCompose,
    clearPendingCompose,
    close,
    dismissedUnassignedIds,
    dismissUnassigned,
  } = useMessageCenter();
  const [panelState, setPanelState] = useState<PanelState>("list");
  const [threadClientId, setThreadClientId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [archivedCount, setArchivedCount] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [unassignedNotes, setUnassignedNotes] = useState<UnassignedVoiceNote[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

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

  const expandToFullPage = (opts: { clientId?: string | null; tab?: InboxTab; noteId?: string | null } = {}) => {
    close();
    route(messagesHref(opts));
  };

  useEffect(() => {
    if (!isOpen) return;
    void (async () => {
      const [sms, unmatched] = await Promise.allSettled([
        api.get<ConversationsResponse>(conversationsUrl(showArchived)),
        api.get<{ notes: UnassignedVoiceNote[] }>("/api/voice-notes/unmatched"),
      ]);
      if (sms.status === "fulfilled") {
        setConversations(sms.value.conversations ?? []);
        setUnreadTotal(sms.value.unread_total ?? 0);
        setArchivedCount(sms.value.archived_count ?? 0);
      }
      if (unmatched.status === "fulfilled") {
        setUnassignedNotes(missedCallUnassignedNotes(unmatched.value.notes ?? []));
      }
    })();
  }, [isOpen, showArchived]);

  useEffect(() => {
    if (!isOpen) return;
    if (activeClientId) {
      setThreadClientId(activeClientId);
      setPanelState("thread");
    } else if (pendingCompose) {
      clearPendingCompose();
      setPanelState("compose");
    } else {
      setPanelState("list");
    }
  }, [isOpen, activeClientId, pendingCompose]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, close]);

  const selectClient = (clientId: string) => {
    setThreadClientId(clientId);
    setPanelState("thread");
  };

  const backToList = () => {
    setPanelState("list");
    setThreadClientId(null);
    void loadConversations(showArchived);
  };

  return (
    <>
      {isOpen && (
        <div class="mc-backdrop" onClick={close} aria-hidden="true" />
      )}

      <div
        class={`mc-panel${isOpen ? " mc-panel--open" : ""}`}
        ref={panelRef}
        role="dialog"
        aria-label="Message Center"
        aria-modal="true"
      >
        {isOpen && (
          <>
            {panelState === "list" && (
              <ConversationList
                conversations={conversations}
                unassignedNotes={unassignedNotes}
                clientsUnread={clientsUnread}
                unassignedUnreviewed={unassignedUnreviewed}
                dismissedIds={dismissedUnassignedIds}
                onDismissUnassigned={dismissUnassigned}
                onSelect={selectClient}
                onClose={close}
                onNewCompose={() => setPanelState("compose")}
                onExpand={({ tab }) => expandToFullPage({ tab })}
                showArchived={showArchived}
                archivedCount={archivedCount}
                onShowArchivedChange={setShowArchived}
                onConversationChanged={() => void loadConversations(showArchived)}
              />
            )}
            {panelState === "thread" && threadClientId && (
              <ThreadView
                clientId={threadClientId}
                onBack={backToList}
                onClose={close}
                onExpand={() => expandToFullPage({ clientId: threadClientId })}
                onStateChange={() => void loadConversations(showArchived)}
              />
            )}
            {panelState === "compose" && (
              <NewCompose
                onSent={(clientId) => {
                  setThreadClientId(clientId);
                  setPanelState("thread");
                }}
                onCancel={() => setPanelState("list")}
                onExpand={() => expandToFullPage()}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}

export function MessageCenterButton() {
  const { isOpen, toggle, dismissedUnassignedIds } = useMessageCenter();
  const [smsUnread, setSmsUnread] = useState(0);
  const [unassignedNotes, setUnassignedNotes] = useState<UnassignedVoiceNote[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [sms, unmatched] = await Promise.allSettled([
        api.get<ConversationsResponse>("/api/sms/conversations"),
        api.get<{ notes: UnassignedVoiceNote[] }>("/api/voice-notes/unmatched"),
      ]);
      if (sms.status === "fulfilled") {
        setSmsUnread(sms.value.unread_total ?? (sms.value.conversations ?? []).reduce((sum, c) => sum + c.unread_count, 0));
      }
      if (unmatched.status === "fulfilled") {
        setUnassignedNotes(unmatched.value.notes ?? []);
      }
    } catch {
      /* quiet */
    }
  }, []);

  const totalUnread = combinedMessageCenterBadge(
    smsUnread,
    countUnreviewedMissedCalls(unassignedNotes, dismissedUnassignedIds),
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isOpen) void refresh();
  }, [isOpen, refresh]);

  return (
    <button
      class={`topnav__bell${isOpen ? " topnav__bell--active" : ""}`}
      aria-label="Message Center"
      title="Message Center"
      onClick={toggle}
    >
      💬
      {totalUnread > 0 && (
        <span class="topnav__bell-count">
          {totalUnread > 9 ? "9+" : totalUnread}
        </span>
      )}
    </button>
  );
}

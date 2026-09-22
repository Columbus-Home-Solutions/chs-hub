import { useState } from "preact/hooks";
import type { UnassignedVoiceNote } from "@chs/shared/message-center-unassigned";
import { conversationIsUnread } from "@chs/shared/sms-conversation-state";
import { ConversationMenu } from "./ConversationMenu";
import { relativeTimestamp, truncate } from "./helpers";
import type { Conversation, InboxTab } from "./types";
import { UnassignedList } from "./UnassignedList";

export function ConversationList({
  conversations,
  unassignedNotes,
  clientsUnread,
  unassignedUnreviewed,
  dismissedIds,
  onDismissUnassigned,
  onSelect,
  onClose,
  onNewCompose,
  onExpand,
  variant = "panel",
  tab: tabProp,
  onTabChange,
  selectedClientId,
  selectedNoteId,
  onSelectUnassigned,
  showArchived = false,
  archivedCount = 0,
  onShowArchivedChange,
  onConversationChanged,
}: {
  conversations: Conversation[];
  unassignedNotes: UnassignedVoiceNote[];
  clientsUnread: number;
  unassignedUnreviewed: number;
  dismissedIds: Set<string>;
  onDismissUnassigned: (id: string) => void;
  onSelect: (clientId: string) => void;
  onClose?: () => void;
  onNewCompose?: () => void;
  onExpand?: (ctx: { tab: InboxTab }) => void;
  variant?: "panel" | "page";
  tab?: InboxTab;
  onTabChange?: (tab: InboxTab) => void;
  selectedClientId?: string | null;
  selectedNoteId?: string | null;
  onSelectUnassigned?: (note: UnassignedVoiceNote) => void;
  showArchived?: boolean;
  archivedCount?: number;
  onShowArchivedChange?: (show: boolean) => void;
  onConversationChanged?: () => void;
}) {
  const [internalTab, setInternalTab] = useState<InboxTab>("clients");
  const [search, setSearch] = useState("");
  const tab = tabProp ?? internalTab;
  const setTab = (next: InboxTab) => {
    if (tabProp === undefined) setInternalTab(next);
    onTabChange?.(next);
  };

  const filtered = search.trim()
    ? conversations.filter(
        (c) =>
          c.client_name.toLowerCase().includes(search.toLowerCase()) ||
          (c.client_phone ?? "").includes(search),
      )
    : conversations;

  const isPage = variant === "page";
  const tabPrefix = isPage ? "msg-tab" : "mc-tab";

  return (
    <div class="mc-list">
      {!isPage && (
        <div class="mc-header">
          <span class="mc-header__title">Message Center</span>
          <div class="mc-header__actions">
            {tab === "clients" && onNewCompose && (
              <button
                class="mc-icon-btn"
                title="New message"
                aria-label="Compose new message"
                onClick={onNewCompose}
              >
                ✏️
              </button>
            )}
            {onExpand && (
              <button
                class="mc-icon-btn"
                title="Open full view"
                aria-label="Open full view"
                onClick={() => onExpand({ tab })}
              >
                ⛶
              </button>
            )}
            {onClose && (
              <button class="mc-close" onClick={onClose} aria-label="Close">
                ✕
              </button>
            )}
          </div>
        </div>
      )}

      <div class="mc-tabs" role="tablist" aria-label="Message Center views">
        <button
          type="button"
          role="tab"
          id={`${tabPrefix}-clients`}
          aria-selected={tab === "clients"}
          aria-controls={`${tabPrefix}panel-clients`}
          class={`mc-tabs__tab${tab === "clients" ? " mc-tabs__tab--active" : ""}`}
          onClick={() => setTab("clients")}
        >
          Clients
          {clientsUnread > 0 && (
            <span class="mc-tabs__badge">{clientsUnread > 9 ? "9+" : clientsUnread}</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          id={`${tabPrefix}-unassigned`}
          aria-selected={tab === "unassigned"}
          aria-controls={`${tabPrefix}panel-unassigned`}
          class={`mc-tabs__tab${tab === "unassigned" ? " mc-tabs__tab--active" : ""}`}
          onClick={() => setTab("unassigned")}
        >
          Unassigned
          {unassignedUnreviewed > 0 && (
            <span class="mc-tabs__badge">{unassignedUnreviewed > 9 ? "9+" : unassignedUnreviewed}</span>
          )}
        </button>
      </div>

      {tab === "clients" ? (
        <div id={`${tabPrefix}panel-clients`} role="tabpanel" aria-labelledby={`${tabPrefix}-clients`} class="mc-tabpanel">
          <div class="mc-search">
            <input
              class="form-input mc-search__input"
              type="search"
              placeholder="Search by client or phone number"
              value={search}
              onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            />
          </div>

          {onShowArchivedChange && (
            <div class="mc-list-filter">
              <button
                type="button"
                class="mc-text-link"
                onClick={() => onShowArchivedChange(!showArchived)}
              >
                {showArchived
                  ? "Hide archived"
                  : archivedCount > 0
                    ? `Show archived (${archivedCount})`
                    : "Show archived"}
              </button>
            </div>
          )}

          <div class="mc-conv-list">
            {filtered.length === 0 && (
              <div class="mc-conv-list__empty">
                {search
                  ? "No matches."
                  : showArchived
                    ? "No archived conversations."
                    : "No SMS conversations yet."}
              </div>
            )}
            {filtered.map((c) => {
              const unread = conversationIsUnread(c);
              return (
                <div
                  key={c.client_id}
                  class={`mc-conv-row${unread ? " mc-conv-row--unread" : ""}${c.sms_opt_out ? " mc-conv-row--opted-out" : ""}${selectedClientId === c.client_id ? " mc-conv-row--selected" : ""}${c.pinned_at ? " mc-conv-row--pinned" : ""}`}
                >
                  <button
                    type="button"
                    class="mc-conv-row__main"
                    onClick={() => onSelect(c.client_id)}
                  >
                    <div class="mc-conv-row__top">
                      <span class="mc-conv-row__name">
                        {c.pinned_at && (
                          <span class="mc-conv-row__pin" title="Pinned" aria-hidden="true">
                            📌
                          </span>
                        )}
                        {c.flagged_at && (
                          <span class="mc-conv-row__flag" title="Flagged">
                            ⚑
                          </span>
                        )}
                        {c.client_name}
                      </span>
                      <span class="mc-conv-row__time">{relativeTimestamp(c.last_message_at)}</span>
                    </div>
                    <div class="mc-conv-row__badges">
                      {c.lead_request_id && (
                        <span class="badge badge--lead">Lead</span>
                      )}
                      {c.sms_opt_out && (
                        <span class="badge badge--opted-out">Opted Out</span>
                      )}
                    </div>
                    <div class="mc-conv-row__preview">
                      {c.last_message_direction === "outbound" && (
                        <span class="mc-conv-row__dir">You: </span>
                      )}
                      {truncate(c.last_message_body, 60)}
                    </div>
                  </button>
                  <ConversationMenu
                    clientId={c.client_id}
                    archived={Boolean(c.archived_at)}
                    flagged={Boolean(c.flagged_at)}
                    pinned={Boolean(c.pinned_at)}
                    unreadCount={c.unread_count}
                    unreadOverride={c.unread_override}
                    onChanged={() => onConversationChanged?.()}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div id={`${tabPrefix}panel-unassigned`} role="tabpanel" aria-labelledby={`${tabPrefix}-unassigned`} class="mc-tabpanel">
          <UnassignedList
            notes={unassignedNotes}
            dismissedIds={dismissedIds}
            onDismiss={onDismissUnassigned}
            selectable={isPage}
            selectedId={selectedNoteId}
            onSelect={onSelectUnassigned}
          />
        </div>
      )}
    </div>
  );
}

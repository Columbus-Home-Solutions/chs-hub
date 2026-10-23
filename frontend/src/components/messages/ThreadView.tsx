import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { api, ApiError } from "../../api";
import { useToast } from "../../store/toast";
import { formatDateTime } from "../../lib/format";
import { ConversationMenu } from "./ConversationMenu";
import { segmentCount } from "./helpers";
import type { Conversation, SmsMessage, SmsThread } from "./types";
import type { ConversationStatePatch } from "@chs/shared/sms-conversation-state";

export function ThreadView({
  clientId,
  onBack,
  onClose,
  onExpand,
  onStateChange,
  showBack = true,
  showClose = true,
  conversation = null,
}: {
  clientId: string;
  onBack?: () => void;
  onClose?: () => void;
  onExpand?: () => void;
  onStateChange?: (patch?: ConversationStatePatch) => void;
  showBack?: boolean;
  showClose?: boolean;
  /** List row for this client, when the list currently includes it. Keeps the header menu in step with the row. */
  conversation?: Conversation | null;
}) {
  const toast = useToast();
  const [thread, setThread] = useState<SmsThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [, setIsSimulateMode] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<SmsThread>(`/api/clients/${clientId}/sms-thread`);
      setThread(data);
    } catch {
      /* stay quiet — show placeholder */
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setThread(null);
    void load().then(() => {
      if (!cancelled) onStateChange?.();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    if (!loading && thread) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [thread?.messages.length, loading]);

  const send = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    const body = draft.trim();
    setDraft("");

    const optimistic: SmsMessage = {
      id: `opt-${Date.now()}`,
      direction: "outbound",
      body,
      created_at: new Date().toISOString(),
      sent_via: "twilio",
      job_id: null,
      job_title: null,
      simulated: true,
    };
    const previousUnread = {
      count: thread?.unread_count ?? 0,
      override: thread?.unread_override ?? false,
    };
    setThread((prev) =>
      prev
        ? {
            ...prev,
            unread_count: 0,
            unread_override: false,
            messages: [...prev.messages, optimistic],
          }
        : prev,
    );

    try {
      const result = await api.post<{ simulated: boolean; message_id: string | null }>(
        "/api/sms/reply",
        { client_id: clientId, body },
      );
      setIsSimulateMode(result.simulated);
      if (result.simulated) {
        toast.push("info", "Message logged — will send when A2P is approved");
      } else {
        toast.push("success", "Message sent");
      }
      await load();
      onStateChange?.();
    } catch (err) {
      setThread((prev) =>
        prev
          ? {
              ...prev,
              unread_count: previousUnread.count,
              unread_override: previousUnread.override,
              messages: prev.messages.filter((m) => m.id !== optimistic.id),
            }
          : prev,
      );
      setDraft(body);
      const msg = err instanceof ApiError ? err.message : "Failed to send message";
      toast.push("error", msg);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      void send();
    }
  };

  if (loading) {
    return (
      <div class="mc-loading">
        <span class="mc-spinner" />
      </div>
    );
  }

  if (!thread) {
    return (
      <div class="mc-loading">
        <p class="text--muted">Failed to load thread.</p>
      </div>
    );
  }

  const display = conversation
    ? {
        archived_at: conversation.archived_at,
        flagged_at: conversation.flagged_at,
        pinned_at: conversation.pinned_at,
        unread_count: conversation.unread_count,
        unread_override: conversation.unread_override,
      }
    : {
        archived_at: thread.archived_at,
        flagged_at: thread.flagged_at,
        pinned_at: thread.pinned_at,
        unread_count: thread.unread_count ?? 0,
        unread_override: thread.unread_override,
      };

  return (
    <div class="mc-thread">
      <div class="mc-header">
        {showBack && onBack && (
          <button class="mc-back" onClick={onBack} aria-label="Back to conversations">
            ←
          </button>
        )}
        <div class="mc-header__info">
          <span class="mc-header__name">
            {display.pinned_at && (
              <span class="mc-conv-row__pin" title="Pinned" aria-hidden="true">
                📌
              </span>
            )}
            {display.flagged_at && (
              <span class="mc-conv-row__flag" title="Flagged">
                ⚑
              </span>
            )}
            {thread.client_name}
          </span>
          {thread.client_phone && (
            <span class="mc-header__phone">{thread.client_phone}</span>
          )}
        </div>
        <div class="mc-header__actions">
          {onExpand && (
            <button
              class="mc-icon-btn"
              title="Open full view"
              aria-label="Open full view"
              onClick={onExpand}
            >
              ⛶
            </button>
          )}
          <ConversationMenu
            clientId={clientId}
            archived={Boolean(display.archived_at)}
            flagged={Boolean(display.flagged_at)}
            pinned={Boolean(display.pinned_at)}
            unreadCount={display.unread_count}
            unreadOverride={display.unread_override}
            onChanged={(patch: ConversationStatePatch) => {
              setThread((prev) => {
                if (!prev) return prev;
                return {
                  ...prev,
                  archived_at:
                    patch.archived === true
                      ? prev.archived_at || new Date().toISOString()
                      : patch.archived === false
                        ? null
                        : prev.archived_at,
                  flagged_at:
                    patch.flagged === true
                      ? prev.flagged_at || new Date().toISOString()
                      : patch.flagged === false
                        ? null
                        : prev.flagged_at,
                  pinned_at:
                    patch.pinned === true
                      ? prev.pinned_at || new Date().toISOString()
                      : patch.pinned === false
                        ? null
                        : prev.pinned_at,
                  unread_override:
                    patch.no_reply_needed === true
                      ? false
                      : patch.unread === true
                        ? true
                        : patch.unread === false
                          ? false
                          : prev.unread_override,
                  unread_count: patch.no_reply_needed === true ? 0 : prev.unread_count,
                };
              });
              onStateChange?.(patch);
            }}
          />
          {showClose && onClose && (
            <button class="mc-close" onClick={onClose} aria-label="Close">
              ✕
            </button>
          )}
        </div>
      </div>

      <div class="mc-thread__links">
        <a
          href={`/app/clients/${clientId}`}
          class="mc-thread__client-link"
          onClick={onClose}
        >
          {thread.client_name} →
        </a>
      </div>

      <div class="mc-messages">
        {thread.messages.length === 0 && (
          <div class="mc-messages__empty">No messages yet.</div>
        )}
        {thread.messages.map((msg) => (
          <div
            key={msg.id}
            class={`mc-bubble mc-bubble--${msg.direction}`}
          >
            <div class="mc-bubble__body">{msg.body}</div>
            <div class="mc-bubble__meta">
              {formatDateTime(msg.created_at)}
              {msg.job_title && (
                <span class="mc-bubble__job"> · {msg.job_title}</span>
              )}
            </div>
            {msg.direction === "outbound" && msg.simulated && (
              <div class="mc-bubble__simulated">not sent — A2P pending</div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {thread.sms_opt_out ? (
        <div class="mc-opt-out-banner">
          ⚠️ This client has opted out of SMS. They must text START to re-subscribe.
        </div>
      ) : (
        <div class="mc-compose">
          <textarea
            class="mc-compose__input"
            placeholder="Type a message… (Cmd+Enter to send)"
            rows={1}
            value={draft}
            onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
            onKeyDown={onKeyDown}
            maxLength={1600}
          />
          <div class="mc-compose__footer">
            <span class="mc-compose__counter">{segmentCount(draft.length)}</span>
            <button
              class="btn btn--primary btn--sm mc-compose__send"
              disabled={!draft.trim() || sending}
              onClick={() => void send()}
            >
              {sending ? "…" : "Send"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

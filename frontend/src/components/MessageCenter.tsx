/**
 * MessageCenter — Sprint 24 two-way SMS slide-out panel.
 *
 * Right-anchored drawer, 420px wide on desktop / full-width on mobile.
 * Two states:
 *   State A — Conversation list (default on open)
 *   State B — Thread view (drill-down to one client)
 *
 * Opens from the 💬 header icon. Can also be opened to a specific client's
 * thread via useMessageCenter().open(clientId).
 */
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { useMessageCenter } from "../store/messageCenter";
import { api, ApiError } from "../api";
import { useToast } from "../store/toast";
import { formatDateTime } from "../lib/format";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Conversation {
  client_id: string;
  client_name: string;
  client_phone: string | null;
  sms_opt_out: boolean;
  last_message_body: string;
  last_message_at: string;
  last_message_direction: "inbound" | "outbound";
  unread_count: number;
  lead_request_id: string | null;
  lead_request_number: number | null;
  lead_status: string | null;
}

interface SmsMessage {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  created_at: string;
  sent_via: string | null;
  job_id: string | null;
  job_title: string | null;
  simulated: boolean;
}

interface SmsThread {
  client_id: string;
  client_name: string;
  client_phone: string | null;
  sms_opt_out: boolean;
  messages: SmsMessage[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTimestamp(iso: string): string {
  const d = new Date(iso.includes("T") ? iso : iso + "Z");
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays === 0) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  if (diffDays < 7) {
    return d.toLocaleDateString("en-US", { weekday: "short" });
  }
  if (diffDays < 365) {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function segmentCount(chars: number): string {
  if (chars <= 160) return `${chars} / 160`;
  const segs = Math.ceil(chars / 153);
  return `${chars} chars — ${segs} segments`;
}

// ─── Thread view ──────────────────────────────────────────────────────────────

function ThreadView({
  clientId,
  onBack,
  onClose,
}: {
  clientId: string;
  onBack: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [thread, setThread] = useState<SmsThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [isSimulateMode, setIsSimulateMode] = useState(false);

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
    setLoading(true);
    setThread(null);
    void load();
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

    // Optimistic append
    const optimistic: SmsMessage = {
      id: `opt-${Date.now()}`,
      direction: "outbound",
      body,
      created_at: new Date().toISOString(),
      sent_via: "twilio",
      job_id: null,
      job_title: null,
      simulated: true, // will be corrected on response
    };
    setThread((prev) =>
      prev ? { ...prev, messages: [...prev.messages, optimistic] } : prev,
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
      // Reload for canonical data
      await load();
    } catch (err) {
      // Remove optimistic message and restore draft
      setThread((prev) =>
        prev
          ? { ...prev, messages: prev.messages.filter((m) => m.id !== optimistic.id) }
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

  return (
    <div class="mc-thread">
      {/* Header */}
      <div class="mc-header">
        <button class="mc-back" onClick={onBack} aria-label="Back to conversations">
          ←
        </button>
        <div class="mc-header__info">
          <span class="mc-header__name">{thread.client_name}</span>
          {thread.client_phone && (
            <span class="mc-header__phone">{thread.client_phone}</span>
          )}
        </div>
        <button class="mc-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      {/* Client link row */}
      <div class="mc-thread__links">
        <a
          href={`/app/clients/${clientId}`}
          class="mc-thread__client-link"
          onClick={onClose}
        >
          {thread.client_name} →
        </a>
      </div>

      {/* Messages */}
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

      {/* Opt-out banner OR compose box */}
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

// ─── New Compose (inline form in panel header area) ───────────────────────────

function NewCompose({
  onSent,
  onCancel,
}: {
  onSent: (clientId: string) => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; name: string; phone: string }[]>([]);
  const [selected, setSelected] = useState<{ id: string; name: string; phone: string } | null>(null);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  // Client search
  useEffect(() => {
    if (!query.trim() || selected) {
      setResults([]);
      return;
    }
    const timeout = setTimeout(async () => {
      try {
        const data = await api.get<{ clients: { id: string; first_name: string | null; last_name: string | null; phone: string | null }[] }>(
          `/api/clients?search=${encodeURIComponent(query)}&limit=8`,
        );
        setResults(
          (data.clients ?? []).map((c) => ({
            id: c.id,
            name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Unknown",
            phone: c.phone ?? "",
          })),
        );
      } catch {
        /* silent */
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [query, selected]);

  const send = async () => {
    if (!selected || !body.trim() || sending) return;
    setSending(true);
    try {
      await api.post("/api/sms/reply", { client_id: selected.id, body: body.trim() });
      toast.push("success", "Message sent");
      onSent(selected.id);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to send";
      toast.push("error", msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <div class="mc-new-compose">
      <div class="mc-header">
        <button class="mc-back" onClick={onCancel} aria-label="Cancel">
          ←
        </button>
        <span class="mc-header__name">New Message</span>
        <button class="mc-close" onClick={onCancel} aria-label="Cancel">
          ✕
        </button>
      </div>

      <div class="mc-new-compose__body">
        {!selected ? (
          <div class="mc-new-compose__search">
            <input
              class="form-input"
              placeholder="Search client by name or phone…"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              autoFocus
            />
            {results.length > 0 && (
              <div class="mc-client-results">
                {results.map((r) => (
                  <button
                    key={r.id}
                    class="mc-client-result"
                    onClick={() => { setSelected(r); setQuery(r.name); setResults([]); }}
                  >
                    <span class="mc-client-result__name">{r.name}</span>
                    <span class="mc-client-result__phone">{r.phone}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div class="mc-new-compose__selected">
            <span>{selected.name}</span>
            <button
              class="mc-new-compose__clear"
              onClick={() => { setSelected(null); setQuery(""); }}
            >
              ✕
            </button>
          </div>
        )}

        <textarea
          class="mc-compose__input"
          placeholder="Type a message…"
          rows={3}
          value={body}
          onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
          disabled={!selected}
        />

        <button
          class="btn btn--primary"
          style={{ width: "100%" }}
          disabled={!selected || !body.trim() || sending}
          onClick={() => void send()}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

// ─── Conversation list ────────────────────────────────────────────────────────

function ConversationList({
  conversations,
  onSelect,
  onClose,
  onNewCompose,
}: {
  conversations: Conversation[];
  onSelect: (clientId: string) => void;
  onClose: () => void;
  onNewCompose: () => void;
}) {
  const [search, setSearch] = useState("");

  const filtered = search.trim()
    ? conversations.filter(
        (c) =>
          c.client_name.toLowerCase().includes(search.toLowerCase()) ||
          (c.client_phone ?? "").includes(search),
      )
    : conversations;

  return (
    <div class="mc-list">
      {/* Header */}
      <div class="mc-header">
        <span class="mc-header__title">Message Center</span>
        <div class="mc-header__actions">
          <button
            class="mc-icon-btn"
            title="New message"
            aria-label="Compose new message"
            onClick={onNewCompose}
          >
            ✏️
          </button>
          <button class="mc-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
      </div>

      {/* Search */}
      <div class="mc-search">
        <input
          class="form-input mc-search__input"
          type="search"
          placeholder="Search by client or phone number"
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />
      </div>

      {/* List */}
      <div class="mc-conv-list">
        {filtered.length === 0 && (
          <div class="mc-conv-list__empty">
            {search ? "No matches." : "No SMS conversations yet."}
          </div>
        )}
        {filtered.map((c) => (
          <button
            key={c.client_id}
            class={`mc-conv-row${c.unread_count > 0 ? " mc-conv-row--unread" : ""}${c.sms_opt_out ? " mc-conv-row--opted-out" : ""}`}
            onClick={() => onSelect(c.client_id)}
          >
            <div class="mc-conv-row__top">
              <span class="mc-conv-row__name">{c.client_name}</span>
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
        ))}
      </div>
    </div>
  );
}

// ─── Main MessageCenter panel ─────────────────────────────────────────────────

type PanelState = "list" | "thread" | "compose";

export function MessageCenter() {
  const { isOpen, activeClientId, pendingCompose, clearPendingCompose, close } = useMessageCenter();
  const [panelState, setPanelState] = useState<PanelState>("list");
  const [threadClientId, setThreadClientId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Load conversations whenever panel opens
  useEffect(() => {
    if (!isOpen) return;
    setLoadingConvs(true);
    api
      .get<{ conversations: Conversation[] }>("/api/sms/conversations")
      .then((d) => setConversations(d.conversations ?? []))
      .catch(() => {})
      .finally(() => setLoadingConvs(false));
  }, [isOpen]);

  // Determine initial panel state when opened
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

  // Close on Escape
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
    // Refresh conversation list when going back
    api
      .get<{ conversations: Conversation[] }>("/api/sms/conversations")
      .then((d) => setConversations(d.conversations ?? []))
      .catch(() => {});
  };

  return (
    <>
      {/* Backdrop — closes panel on click */}
      {isOpen && (
        <div class="mc-backdrop" onClick={close} aria-hidden="true" />
      )}

      {/* Slide-out panel */}
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
                onSelect={selectClient}
                onClose={close}
                onNewCompose={() => setPanelState("compose")}
              />
            )}
            {panelState === "thread" && threadClientId && (
              <ThreadView
                clientId={threadClientId}
                onBack={backToList}
                onClose={close}
              />
            )}
            {panelState === "compose" && (
              <NewCompose
                onSent={(clientId) => {
                  setThreadClientId(clientId);
                  setPanelState("thread");
                }}
                onCancel={() => setPanelState("list")}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}

// ─── Header icon button with unread badge ─────────────────────────────────────

export function MessageCenterButton() {
  const { isOpen, toggle } = useMessageCenter();
  const [totalUnread, setTotalUnread] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<{ conversations: Conversation[] }>("/api/sms/conversations");
      const total = (data.conversations ?? []).reduce((sum, c) => sum + c.unread_count, 0);
      setTotalUnread(total);
    } catch {
      /* quiet */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Refresh when panel closes (messages may have been "read" implicitly)
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

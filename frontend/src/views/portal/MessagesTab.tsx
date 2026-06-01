import { useEffect, useRef, useState } from "preact/hooks";
import { formatDateTime } from "../../lib/format";
import { getJson, postJson, type PortalMessage } from "./portalApi";

/** Threaded portal_message view. Inbound = client → contractor. */
export function MessagesTab({ token }: { token: string }) {
  const [messages, setMessages] = useState<PortalMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const reload = async () => {
    const r = await getJson<{ messages: PortalMessage[] }>(`/api/portal/${token}/messages`);
    setMessages(r.messages);
  };

  useEffect(() => {
    reload().catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await postJson(`/api/portal/${token}/messages`, { body });
      setDraft("");
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div class="portal-messages">
      <div class="portal-card portal-thread">
        {!messages ? (
          <div class="quote-muted">Loading messages…</div>
        ) : messages.length === 0 ? (
          <div class="quote-muted portal-thread__empty">
            No messages yet. Send us a note and we'll get back to you.
          </div>
        ) : (
          messages.map((m) => (
            <div
              class={`portal-msg portal-msg--${m.from === "client" ? "out" : "in"}`}
              key={m.id}
            >
              <div class="portal-msg__bubble">{m.body}</div>
              <div class="portal-msg__meta">
                {m.from === "client" ? "You" : "Columbus Home Solutions"} · {formatDateTime(m.created_at)}
              </div>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      {error && <div class="quote-error">{error}</div>}

      <div class="portal-compose">
        <textarea
          class="quote-textarea"
          placeholder="Write a message…"
          maxLength={2000}
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
        />
        <button class="quote-btn quote-btn--primary" disabled={!draft.trim() || sending} onClick={send}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

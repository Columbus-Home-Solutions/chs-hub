import { useState, useEffect } from "preact/hooks";
import { api, ApiError } from "../../api";
import { useToast } from "../../store/toast";

export function NewCompose({
  onSent,
  onCancel,
  onExpand,
}: {
  onSent: (clientId: string) => void;
  onCancel: () => void;
  onExpand?: () => void;
}) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; name: string; phone: string }[]>([]);
  const [selected, setSelected] = useState<{ id: string; name: string; phone: string } | null>(null);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

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

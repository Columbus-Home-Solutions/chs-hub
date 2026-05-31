import { formatDateTime, formatStatus } from "../lib/format";

export interface TimelineEntry {
  id: string;
  channel: string;
  direction: string;
  summary: string;
  body?: string | null;
  sent_via?: string | null;
  created_at: string;
}

const CHANNEL_ICON: Record<string, string> = {
  text_sms: "💬",
  email: "✉️",
  phone_call: "📞",
  portal_message: "🌐",
  in_person: "🤝",
  other: "•",
};

function sourceLabel(sentVia: string | null | undefined): string | null {
  if (sentVia === "system_auto") return "auto";
  if (sentVia === "twilio") return "received";
  return null;
}

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) {
    return <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>No communications logged yet.</p>;
  }
  return (
    <div class="timeline">
      {entries.map((e) => {
        const icon = CHANNEL_ICON[e.channel] ?? "•";
        const src = sourceLabel(e.sent_via);
        return (
          <div key={e.id} class="timeline__item">
            <span class="timeline__dot timeline__dot--icon" aria-hidden="true">{icon}</span>
            <div class="timeline__content">
              <div class="timeline__summary">{e.summary}</div>
              {e.body && (
                <div class="text--muted" style={{ fontSize: "var(--text-sm)", marginTop: "2px" }}>
                  {e.body}
                </div>
              )}
              <div class="timeline__meta">
                {formatStatus(e.channel)} · {formatStatus(e.direction)}
                {src ? ` · ${src}` : ""} · {formatDateTime(e.created_at)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

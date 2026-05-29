import { formatDateTime, formatStatus } from "../lib/format";

export interface TimelineEntry {
  id: string;
  channel: string;
  direction: string;
  summary: string;
  body?: string | null;
  created_at: string;
}

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) {
    return <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>No communications logged yet.</p>;
  }
  return (
    <div class="timeline">
      {entries.map((e) => (
        <div key={e.id} class="timeline__item">
          <span class="timeline__dot" />
          <div class="timeline__content">
            <div class="timeline__summary">{e.summary}</div>
            {e.body && (
              <div class="text--muted" style={{ fontSize: "var(--text-sm)", marginTop: "2px" }}>
                {e.body}
              </div>
            )}
            <div class="timeline__meta">
              {formatStatus(e.channel)} · {formatStatus(e.direction)} · {formatDateTime(e.created_at)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

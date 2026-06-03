import { useState } from "preact/hooks";
import { route } from "preact-router";
import { go } from "../../lib/nav";
import type { ActivityEntry } from "./types";

interface Props {
  entries: ActivityEntry[];
  loading: boolean;
  error: string | null;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
}

export function RecentActivity({ entries, loading, error }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  if (loading) {
    return (
      <div class="dash-card">
        <div class="dash-card__header">
          <h2 class="dash-card__title">Recent Activity</h2>
        </div>
        <div class="dash-card__body">
          {[...Array(4)].map((_, i) => (
            <div key={i} class="activity-row activity-row--skeleton" aria-hidden="true" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div class="dash-card">
        <div class="dash-card__header"><h2 class="dash-card__title">Recent Activity</h2></div>
        <div class="dash-card__body dash-card__body--error">Unable to load activity.</div>
      </div>
    );
  }

  return (
    <div class="dash-card">
      <div class="dash-card__header" style={{ cursor: "pointer" }} onClick={() => setCollapsed((v) => !v)}>
        <h2 class="dash-card__title">Recent Activity</h2>
        <span
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--color-text-muted)",
            userSelect: "none",
            transition: "transform 0.2s",
            display: "inline-block",
            transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
          }}
        >
          ▾
        </span>
      </div>
      {!collapsed && (
        <div class="dash-card__body">
          {entries.length === 0 ? (
            <div class="activity__empty">No recent activity.</div>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.id}
                class="activity-row"
                disabled={!entry.link}
                onClick={(e) => {
                  e.stopPropagation();
                  if (entry.link) route(entry.link);
                }}
              >
                <span class="activity-row__icon">{entry.icon}</span>
                <span class="activity-row__desc">{entry.description}</span>
                <span class="activity-row__time">{relativeTime(entry.createdAt)}</span>
              </button>
            ))
          )}
          <button class="link-btn link-btn--block" onClick={(e) => { e.stopPropagation(); go("/settings?tab=audit"); }}>
            View full activity log →
          </button>
        </div>
      )}
    </div>
  );
}

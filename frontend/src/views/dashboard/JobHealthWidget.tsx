/**
 * Compact Job Health dashboard widget (Sprint 34).
 *
 * Shows only amber/red jobs (needs attention), capped at 3.
 * Empty state: "All jobs on track" — never an empty list.
 * Placement: secondary column, directly below Quick Actions, above Smart Notes.
 */

import { useApi } from "../../hooks/useApi";
import { go } from "../../lib/nav";

type HealthColor = "green" | "amber" | "red" | "neutral";

interface JobHealthItem {
  id: string;
  title: string;
  health: HealthColor;
  days_quiet: number | null;
}

interface JobHealthResponse {
  jobs: JobHealthItem[];
}

const DOT_COLORS: Record<HealthColor, string> = {
  green: "#22c55e",
  amber: "#f59e0b",
  red: "#ef4444",
  neutral: "#94a3b8",
};

function quietLabel(days: number | null): string {
  if (days === null) return "No activity";
  if (days === 0) return "Active today";
  if (days === 1) return "1d quiet";
  return `${days}d quiet`;
}

export function JobHealthWidget() {
  const { data, loading } = useApi<JobHealthResponse>("/api/jobs/health");

  const needsAttention = (data?.jobs ?? []).filter(
    (j) => j.health === "red" || j.health === "amber",
  );
  const displayed = needsAttention.slice(0, 3);
  const hasMore = needsAttention.length > 3;

  return (
    <div class="quick-actions">
      <div class="quick-actions__header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Job health</span>
        <button
          type="button"
          class="link-btn"
          style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-normal)" }}
          onClick={() => go("/jobs?view=health")}
        >
          View all
        </button>
      </div>

      {loading && (
        <div class="text--muted" style={{ fontSize: "var(--text-sm)", padding: "var(--space-sm) 0" }}>
          Loading…
        </div>
      )}

      {!loading && needsAttention.length === 0 && (
        <div class="job-health-widget__empty">
          <span style={{ marginRight: "var(--space-xs)" }}>✓</span>
          All jobs on track
        </div>
      )}

      {!loading && displayed.length > 0 && (
        <div class="job-health-widget__list">
          {displayed.map((job) => (
            <button
              key={job.id}
              type="button"
              class="job-health-widget__row"
              onClick={() => go(`/jobs/${job.id}`)}
            >
              <span
                class="job-health-widget__dot"
                style={{ background: DOT_COLORS[job.health] }}
              />
              <span class="job-health-widget__title">{job.title}</span>
              <span class="job-health-widget__quiet text--muted">
                {quietLabel(job.days_quiet)}
              </span>
            </button>
          ))}
          {hasMore && (
            <button
              type="button"
              class="link-btn"
              style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-xs)" }}
              onClick={() => go("/jobs?view=health")}
            >
              +{needsAttention.length - 3} more — View all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

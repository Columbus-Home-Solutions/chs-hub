/**
 * Open Bid Requests dashboard widget.
 *
 * Shows bid requests with status='open' across all jobs, capped at 3 rows,
 * sorted by staleness (days open descending). Mirrors JobHealthWidget layout
 * exactly — same card class, same CSS tokens, same row/dot pattern.
 */

import { useApi } from "../../hooks/useApi";
import { go } from "../../lib/nav";

interface OpenBidItem {
  id: string;
  title: string;
  job_id: string | null;
  job_title: string | null;
  days_open: number;
  recipient_count: number;
  submission_count: number;
}

interface OpenBidsResponse {
  open_bids: OpenBidItem[];
}

function dotColor(item: OpenBidItem): string {
  if (item.recipient_count === 0) return "#94a3b8"; // neutral — no subs invited yet
  if (item.submission_count === 0) return "#ef4444"; // red — no responses at all
  if (item.submission_count < item.recipient_count) return "#f59e0b"; // amber — partial
  return "#22c55e"; // green — all submitted, awaiting award
}

function quietLabel(days: number): string {
  if (days === 0) return "Opened today";
  if (days === 1) return "1d open";
  return `${days}d open`;
}

function submissionLabel(item: OpenBidItem): string {
  if (item.recipient_count === 0) return "No subs invited";
  return `${item.submission_count}/${item.recipient_count} submitted`;
}

export function OpenBidsWidget() {
  const { data, loading } = useApi<OpenBidsResponse>("/api/bid-requests");

  const items = data?.open_bids ?? [];
  const displayed = items.slice(0, 3);
  const hasMore = items.length > 3;

  return (
    <div class="quick-actions">
      <div
        class="quick-actions__header"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <span>Open bid requests</span>
        <button
          type="button"
          class="link-btn"
          style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-normal)" }}
          onClick={() => go("/jobs")}
        >
          View all
        </button>
      </div>

      {loading && (
        <div
          class="text--muted"
          style={{ fontSize: "var(--text-sm)", padding: "var(--space-sm) 0" }}
        >
          Loading…
        </div>
      )}

      {!loading && items.length === 0 && (
        <div class="job-health-widget__empty">
          <span style={{ marginRight: "var(--space-xs)" }}>✓</span>
          No open bid requests
        </div>
      )}

      {!loading && displayed.length > 0 && (
        <div class="job-health-widget__list">
          {displayed.map((item) => (
            <button
              key={item.id}
              type="button"
              class="job-health-widget__row"
              onClick={() => item.job_id && go(`/jobs/${item.job_id}?tab=bids`)}
            >
              <span
                class="job-health-widget__dot"
                style={{ background: dotColor(item) }}
              />
              <span class="job-health-widget__title">{item.title}</span>
              <span class="job-health-widget__quiet">
                {submissionLabel(item)} · {quietLabel(item.days_open)}
              </span>
            </button>
          ))}
          {hasMore && (
            <button
              type="button"
              class="link-btn"
              style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-xs)" }}
              onClick={() => go("/jobs")}
            >
              +{items.length - 3} more — View all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

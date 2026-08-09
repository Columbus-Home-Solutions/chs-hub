/**
 * Desktop-only Estimate Requests widget.
 *
 * Surfaces leads at Appointment Set or later that have not yet been converted
 * into a full estimate/job. Distinct from Open Bid Requests (subcontractor bids).
 */

import { useApi } from "../../hooks/useApi";
import { go } from "../../lib/nav";
import { formatStatus } from "../../lib/format";

interface EstimateRequestItem {
  id: string;
  client_name: string;
  status: string;
  job_type: string | null;
  appointment_date: string | null;
  appointment_time: string | null;
  property_label: string | null;
  updated_at: string | null;
  created_at: string | null;
}

interface EstimateRequestsResponse {
  requests: EstimateRequestItem[];
}

function quietLabel(item: EstimateRequestItem): string {
  const stage = formatStatus(item.status);
  if (item.appointment_date) {
    // appointment_date is YYYY-MM-DD; keep short for the row.
    const d = item.appointment_date.slice(5).replace("-", "/"); // MM/DD
    return `${stage} · ${d}`;
  }
  return stage;
}

export function EstimateRequestsWidget() {
  const { data, loading } = useApi<EstimateRequestsResponse>("/api/dashboard/estimate-requests");

  const items = data?.requests ?? [];
  const displayed = items.slice(0, 3);
  const hasMore = items.length > 3;

  return (
    <div class="quick-actions">
      <div
        class="quick-actions__header"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <span>Estimate requests</span>
        <button
          type="button"
          class="link-btn"
          style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-normal)" }}
          onClick={() => go("/estimating?tab=chs")}
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
          No open estimate requests
        </div>
      )}

      {!loading && displayed.length > 0 && (
        <div class="job-health-widget__list">
          {displayed.map((item) => (
            <button
              key={item.id}
              type="button"
              class="job-health-widget__row"
              onClick={() => go(`/estimating/${item.id}`)}
            >
              <span
                class="job-health-widget__dot"
                style={{ background: "#3b82f6" }}
              />
              <span class="job-health-widget__title">
                {item.client_name}
                {item.property_label ? ` · ${item.property_label}` : ""}
              </span>
              <span class="job-health-widget__quiet">{quietLabel(item)}</span>
            </button>
          ))}
          {hasMore && (
            <button
              type="button"
              class="link-btn"
              style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-xs)" }}
              onClick={() => go("/estimating?tab=chs")}
            >
              +{items.length - 3} more — View all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

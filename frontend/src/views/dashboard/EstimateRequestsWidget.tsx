/**
 * Estimates in Progress (phone / tablet / desktop Home).
 * Building leads only. A row opens the draft builder, or the pre-filled
 * new-estimate form when no draft exists yet.
 */

import { useApi } from "../../hooks/useApi";
import { go } from "../../lib/nav";
import { formatCurrency, formatStatus } from "../../lib/format";

interface EstimateRequestItem {
  id: string;
  client_name: string;
  job_type: string | null;
  place_label: string | null;
  estimate_id: string | null;
  estimate_total: number | null;
  building_at: string | null;
  days_in_building: number;
  stale: boolean;
}

interface EstimateRequestsResponse {
  requests: EstimateRequestItem[];
}

const VISIBLE = 5;

function daysLabel(days: number): string {
  if (days <= 0) return "Today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

function openEstimate(item: EstimateRequestItem): void {
  if (item.estimate_id) {
    go(`/estimating/${item.id}/estimate`);
    return;
  }
  go(`/estimating/new?request_id=${item.id}&autostart=1`);
}

export function EstimateRequestsWidget() {
  const { data, loading } = useApi<EstimateRequestsResponse>("/api/dashboard/estimate-requests");

  const items = data?.requests ?? [];
  const displayed = items.slice(0, VISIBLE);
  const extra = items.length - displayed.length;

  return (
    <div class="quick-actions">
      <div
        class="quick-actions__header"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <span>Estimates in Progress</span>
        <button
          type="button"
          class="link-btn"
          style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-normal)" }}
          onClick={() => go("/estimating?tab=chs&stage=building")}
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
          No estimates in progress.
        </div>
      )}

      {!loading && displayed.length > 0 && (
        <div class="job-health-widget__list">
          {displayed.map((item) => (
            <button
              key={item.id}
              type="button"
              class={`job-health-widget__row${item.stale ? " job-health-widget__row--stale" : ""}`}
              onClick={() => openEstimate(item)}
            >
              <span
                class="job-health-widget__dot"
                style={{ background: item.stale ? "var(--color-warning)" : "#3b82f6" }}
              />
              <span class="job-health-widget__title">
                {item.client_name}
                {item.place_label ? ` · ${item.place_label}` : ""}
              </span>
              <span class="job-health-widget__quiet">
                {item.job_type ? `${formatStatus(item.job_type)} · ` : ""}
                {daysLabel(item.days_in_building)}
                {item.estimate_total != null ? ` · ${formatCurrency(item.estimate_total)}` : ""}
              </span>
            </button>
          ))}
          {extra > 0 && (
            <button
              type="button"
              class="link-btn"
              style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-xs)" }}
              onClick={() => go("/estimating?tab=chs&stage=building")}
            >
              +{extra} more — View all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

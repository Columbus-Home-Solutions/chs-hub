/**
 * BidsTab — Sprint 38 Run 3 wire-in (CHS-Task-Wire-BidComparisonView).
 *
 * Job Detail "Bids" tab. Lists all bid requests for a job, lets the owner
 * open one to view/award it via BidComparisonView, and provides a
 * "Request Bids" button to create a new bid request in the job context.
 */

import { useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { BidComparisonView } from "../estimating/BidComparisonView";
import { BidRequestModal } from "../estimating/BidRequestModal";
import { formatDate } from "../../lib/format";

interface BidRequestSummary {
  id: string;
  title: string;
  status: string;
  bid_mode: string;
  notify_losers: number;
  awarded_sub_id: string | null;
  awarded_bid_id: string | null;
  created_at: string;
  recipient_count: number;
  submission_count: number;
}

interface ListResponse {
  bid_requests: BidRequestSummary[];
}

function statusBadgeCls(status: string): string {
  if (status === "awarded") return "badge--success";
  if (status === "cancelled") return "badge--neutral";
  return "badge--info";
}

function statusLabel(status: string): string {
  if (status === "awarded") return "Awarded";
  if (status === "cancelled") return "Cancelled";
  return "Open";
}

interface BidsTabProps {
  jobId: string;
}

export function BidsTab({ jobId }: BidsTabProps) {
  const { data, loading, error, refetch } = useApi<ListResponse>(
    `/api/bid-requests?job_id=${jobId}`,
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // When a bid request is created, immediately open it in the comparison view.
  const handleCreated = (bidRequestId: string) => {
    refetch();
    setSelectedId(bidRequestId);
  };

  // Show the comparison view when a bid request is selected.
  if (selectedId) {
    return (
      <BidComparisonView
        bidRequestId={selectedId}
        onBack={() => {
          setSelectedId(null);
          refetch();
        }}
      />
    );
  }

  return (
    <div class="stack">
      <div class="flex items-center justify-between gap-sm">
        <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          {data ? `${data.bid_requests.length} bid request${data.bid_requests.length !== 1 ? "s" : ""}` : ""}
        </span>
        <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
          + Request Bids
        </Button>
      </div>

      {loading && <Spinner center />}

      {error && (
        <div class="callout callout--error">
          <p>{error}</p>
        </div>
      )}

      {!loading && !error && data && data.bid_requests.length === 0 && (
        <div class="empty-state">
          <div class="empty-state__icon">📊</div>
          <div class="empty-state__title">No bid requests yet</div>
          <div>
            Use "Request Bids" to solicit competitive pricing from multiple subs for any
            scope of work on this job.
          </div>
        </div>
      )}

      {!loading && !error && data && data.bid_requests.length > 0 && (
        <div class="card">
          <div class="card__body" style={{ padding: 0 }}>
            <div class="table-wrapper">
              <table class="table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Status</th>
                    <th>Mode</th>
                    <th style={{ textAlign: "right" }}>Subs invited</th>
                    <th style={{ textAlign: "right" }}>Bids received</th>
                    <th>Created</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.bid_requests.map((br) => (
                    <tr key={br.id}>
                      <td>
                        <span class="table-cell--primary">{br.title}</span>
                      </td>
                      <td>
                        <span class={`badge ${statusBadgeCls(br.status)}`}>
                          {statusLabel(br.status)}
                        </span>
                      </td>
                      <td>
                        <span class="badge badge--neutral">
                          {br.bid_mode === "sealed" ? "Sealed" : "Open"}
                        </span>
                      </td>
                      <td style={{ textAlign: "right" }}>{br.recipient_count}</td>
                      <td style={{ textAlign: "right" }}>
                        <span
                          style={{
                            fontWeight: br.submission_count > 0 ? 600 : undefined,
                            color: br.submission_count > 0 ? "var(--color-text)" : "var(--color-text-muted)",
                          }}
                        >
                          {br.submission_count}
                        </span>
                      </td>
                      <td class="table-cell--secondary">{formatDate(br.created_at)}</td>
                      <td style={{ textAlign: "right" }}>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setSelectedId(br.id)}
                        >
                          View →
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <BidRequestModal
        open={createOpen}
        jobId={jobId}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
    </div>
  );
}

/**
 * BidComparisonView — Sprint 38 Run 3.
 *
 * Owner-facing comparison table for a single bid request.
 * Shows all invited subs, their submission status, price, notes.
 * Award button per submitted row — owner always picks manually.
 *
 * Used as a standalone view at /app/bid-requests/:id and also embeddable
 * as a panel inside EstimateDetail or JobDetail.
 */

import { useCallback, useEffect, useState } from "preact/hooks";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Spinner } from "../../components/ui/Spinner";
import { api } from "../../api";

// ── Types ─────────────────────────────────────────────────────────────────────

interface BidSubmission {
  id: string;
  price: number;
  notes: string | null;
  attachment_photo_id: string | null;
  status: string;
  submitted_at: string;
}

interface BidSub {
  recipient_id: string;
  sub_id: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  portal_token: string;
  bid_link: string;
  sent_at: string | null;
  viewed_at: string | null;
  submission: BidSubmission | null;
}

interface BidRequest {
  id: string;
  title: string;
  scope_description: string;
  quantities_notes: string | null;
  needed_by_date: string | null;
  status: string;
  bid_mode: string;
  notify_losers: number;
  awarded_sub_id: string | null;
  awarded_bid_id: string | null;
  created_at: string;
  subs: BidSub[];
  reference_photos?: Array<{
    id: string;
    caption: string | null;
    thumb_url: string;
    original_url: string;
  }>;
}

interface BidComparisonViewProps {
  bidRequestId: string;
  onBack?: () => void;
  onAwarded?: () => void;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function formatCurrency(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch { return iso; }
}

function statusBadge(sub: BidSub, awardedBidId: string | null): { label: string; cls: string } {
  if (!sub.submission) {
    if (!sub.viewed_at) return { label: "Invited", cls: "neutral" };
    return { label: "Viewed — no bid", cls: "warning" };
  }
  if (sub.submission.id === awardedBidId) return { label: "Awarded", cls: "success" };
  if (sub.submission.status === "lost") return { label: "Not selected", cls: "neutral" };
  return { label: "Bid received", cls: "info" };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function BidComparisonView({ bidRequestId, onBack, onAwarded }: BidComparisonViewProps) {
  const [data, setData] = useState<BidRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [confirmAward, setConfirmAward] = useState<BidSub | null>(null);
  const [awarding, setAwarding] = useState(false);
  const [awardError, setAwardError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<BidRequest>(`/api/bid-requests/${bidRequestId}`);
      setData(result);
    } catch (e) {
      setError((e as Error).message || "Could not load bid request.");
    } finally {
      setLoading(false);
    }
  }, [bidRequestId]);

  useEffect(() => { void load(); }, [load]);

  const handleAward = async () => {
    if (!confirmAward?.submission || !data) return;
    setAwarding(true);
    setAwardError(null);
    try {
      await api.post(`/api/bid-requests/${bidRequestId}/award`, {
        submission_id: confirmAward.submission.id,
      });
      setConfirmAward(null);
      await load();
      onAwarded?.();
    } catch (e) {
      setAwardError((e as Error).message || "Award failed.");
    } finally {
      setAwarding(false);
    }
  };

  if (loading) return <div class="view-loading"><Spinner center /></div>;
  if (error || !data) {
    return (
      <div class="view-error">
        <p>{error ?? "Bid request not found."}</p>
        {onBack && <Button variant="secondary" onClick={onBack}>Back</Button>}
      </div>
    );
  }

  const isOpen = data.status === "open";
  const submissions = data.subs.filter((s) => s.submission !== null);
  const lowestPrice = submissions.length > 0
    ? Math.min(...submissions.map((s) => s.submission!.price))
    : null;

  return (
    <div class="view">
      {onBack && (
        <Button variant="ghost" size="sm" onClick={onBack} style={{ marginBottom: "16px" }}>
          ← Back
        </Button>
      )}

      {/* Header */}
      <div class="view-header">
        <div>
          <h1 class="view-title">{data.title}</h1>
          <div style={{ display: "flex", gap: "8px", marginTop: "4px", flexWrap: "wrap" }}>
            <span class={`badge badge--${data.status === "awarded" ? "success" : data.status === "cancelled" ? "neutral" : "info"}`}>
              {data.status === "awarded" ? "Awarded" : data.status === "cancelled" ? "Cancelled" : "Open"}
            </span>
            <span class="badge badge--neutral">
              {data.bid_mode === "sealed" ? "Sealed bidding" : "Open bidding"}
            </span>
            {data.needed_by_date && (
              <span class="badge badge--neutral">Needed by {formatDate(data.needed_by_date)}</span>
            )}
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={load}>Refresh</Button>
      </div>

      {/* Scope summary */}
      <div class="card" style={{ marginBottom: "24px" }}>
        <div class="card__header">
          <h2 class="card__title">Scope of Work</h2>
        </div>
        <div class="card__body">
          <p style={{ whiteSpace: "pre-wrap", lineHeight: "1.6", margin: 0 }}>
            {data.scope_description}
          </p>
          {data.quantities_notes && (
            <p style={{ marginTop: "8px", color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
              {data.quantities_notes}
            </p>
          )}
          {data.reference_photos && data.reference_photos.length > 0 && (
            <div style={{ marginTop: "16px" }}>
              <div class="form-label" style={{ marginBottom: "8px" }}>Reference photos</div>
              <div class="bid-ref-gallery">
                {data.reference_photos.map((p) => (
                  <a
                    key={p.id}
                    href={p.original_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="bid-ref-gallery__item"
                  >
                    <img src={p.thumb_url} alt={p.caption || "Reference photo"} />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Comparison table */}
      <div class="card">
        <div class="card__header">
          <h2 class="card__title">
            Bids ({submissions.length} / {data.subs.length} submitted)
          </h2>
          {lowestPrice !== null && (
            <span class="badge badge--success">Low bid: {formatCurrency(lowestPrice)}</span>
          )}
        </div>
        <div class="card__body" style={{ padding: 0 }}>
          <div class="table-wrapper">
            <table class="table">
              <thead>
                <tr>
                  <th>Sub</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Price</th>
                  <th>Notes</th>
                  <th>Submitted</th>
                  {isOpen && <th style={{ textAlign: "right" }}>Action</th>}
                </tr>
              </thead>
              <tbody>
                {data.subs.map((sub) => {
                  const badge = statusBadge(sub, data.awarded_bid_id);
                  const isLowest = sub.submission && sub.submission.price === lowestPrice && submissions.length > 1;
                  return (
                    <tr key={sub.sub_id} class={sub.submission?.id === data.awarded_bid_id ? "table-row--highlighted" : ""}>
                      <td>
                        <div class="table-cell--primary">{sub.name}</div>
                        {sub.company && sub.name !== sub.company && (
                          <div class="table-cell--secondary">{sub.company}</div>
                        )}
                        {sub.phone && (
                          <div class="table-cell--secondary">{sub.phone}</div>
                        )}
                      </td>
                      <td>
                        <span class={`badge badge--${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td style={{ textAlign: "right", fontWeight: sub.submission ? 600 : 400 }}>
                        {sub.submission ? (
                          <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "6px" }}>
                            {formatCurrency(sub.submission.price)}
                            {isLowest && <span class="badge badge--success" style={{ fontSize: "11px" }}>Low</span>}
                          </span>
                        ) : (
                          <span class="table-cell--secondary">—</span>
                        )}
                      </td>
                      <td style={{ maxWidth: "240px" }}>
                        {sub.submission?.notes ? (
                          <span style={{ fontSize: "var(--text-sm)", lineHeight: "1.4" }}>
                            {sub.submission.notes}
                          </span>
                        ) : (
                          <span class="table-cell--secondary">—</span>
                        )}
                        {sub.submission?.attachment_photo_id ? (
                          <div style={{ marginTop: "4px" }}>
                            <a
                              href={`/api/photos/${sub.submission.attachment_photo_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ fontSize: "var(--text-xs)" }}
                            >
                              View attachment
                            </a>
                          </div>
                        ) : null}
                      </td>
                      <td class="table-cell--secondary">
                        {sub.submission ? formatDate(sub.submission.submitted_at) : "—"}
                      </td>
                      {isOpen && (
                        <td style={{ textAlign: "right" }}>
                          {sub.submission && sub.submission.status === "submitted" ? (
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => setConfirmAward(sub)}
                            >
                              Award
                            </Button>
                          ) : null}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Copy invite links */}
      <details class="collapsible" style={{ marginTop: "16px" }}>
        <summary class="collapsible__trigger">Invite links (resend or copy)</summary>
        <div class="collapsible__body">
          {data.subs.map((sub) => (
            <div key={sub.sub_id} class="bid-link-row">
              <span class="bid-link-row__name">{sub.name}</span>
              <input
                class="form-input bid-link-row__input"
                type="text"
                readOnly
                value={sub.bid_link}
                onFocus={(e) => (e.target as HTMLInputElement).select()}
              />
            </div>
          ))}
        </div>
      </details>

      {/* Award confirmation modal */}
      {confirmAward && (
        <Modal
          open
          title="Award Bid"
          onClose={() => { if (!awarding) setConfirmAward(null); }}
          footer={
            <>
              <Button variant="secondary" disabled={awarding} onClick={() => setConfirmAward(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={awarding} onClick={handleAward}>
                {awarding ? "Awarding…" : "Confirm Award"}
              </Button>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {awardError && <p class="form-error" role="alert">{awardError}</p>}
            <p>
              Award <strong>"{data.title}"</strong> to{" "}
              <strong>{confirmAward.name}</strong> at{" "}
              <strong>{confirmAward.submission ? formatCurrency(confirmAward.submission.price) : "—"}</strong>?
            </p>
            {data.notify_losers === 1 && (
              <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
                Non-winning subs will receive an SMS thanking them for their bid.
              </p>
            )}
            <p style={{ color: "var(--color-text-muted)", fontSize: "var(--text-sm)" }}>
              The winning price will be applied to the estimate line item and vendor pricing catalog.
              This cannot be undone.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

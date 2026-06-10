/**
 * DocReviewQueue — Sprint 20.
 *
 * Renders the "Documents Pending Review" dashboard section.
 * Hidden entirely when the queue is empty (per spec).
 * Reuses dash-card / action-item CSS from the ActionItems widget.
 */

import { useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { api, ApiError } from "../../api";
import { useToast } from "../../store/toast";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { DocViewerModal } from "../../components/DocViewerModal";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ReviewQueueItem {
  id: string;
  job_id: string;
  job_number: string;
  job_title: string;
  client_name: string;
  template_type: string;
  filename: string;
  trigger_event: string | null;
  generated_at: string;
  related_record_id: string | null;
  download_url: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEMPLATE_LABELS: Record<string, string> = {
  service_agreement: "Service Agreement",
  cost_plus_agreement: "Cost-Plus Agreement",
  change_order: "Change Order",
  lien_waiver_conditional: "Conditional Lien Waiver",
  lien_waiver_sub_unconditional: "Sub Unconditional Lien Waiver",
  warranty_certificate: "Warranty Certificate",
};

const TEMPLATE_ICON: Record<string, string> = {
  service_agreement: "📋",
  cost_plus_agreement: "📋",
  change_order: "📄",
  lien_waiver_conditional: "📑",
  lien_waiver_sub_unconditional: "📑",
  warranty_certificate: "🏅",
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
}

// ─── Review Modal ─────────────────────────────────────────────────────────────

interface ReviewModalProps {
  item: ReviewQueueItem;
  onClose: () => void;
  onApprove: () => void;
  onDiscard: () => void;
}

function ReviewModal({ item, onClose, onApprove, onDiscard }: ReviewModalProps) {
  const { push } = useToast();
  const [acting, setActing] = useState<"approve" | "discard" | null>(null);
  const [viewing, setViewing] = useState(false);

  const preview = useApi<{
    job_number: string;
    title: string;
    client_name: string;
    job_address: string;
    contract_amount: string;
  }>(`/api/jobs/${item.job_id}/doc-preview`);

  const [approved, setApproved] = useState(false);

  async function handleApprove() {
    setActing("approve");
    try {
      await api.post(
        `/api/jobs/${item.job_id}/generated-documents/${item.id}/approve`,
        {},
      );
      push("success", "Document approved.");
      setApproved(true);
      onApprove();
    } catch (e) {
      push("error", e instanceof ApiError ? e.message : "Approve failed.");
    } finally {
      setActing(null);
    }
  }

  async function handleDiscard() {
    setActing("discard");
    try {
      await api.post(
        `/api/jobs/${item.job_id}/generated-documents/${item.id}/discard`,
        {},
      );
      push("success", "Document discarded.");
      onDiscard();
    } catch (e) {
      push("error", e instanceof ApiError ? e.message : "Discard failed.");
    } finally {
      setActing(null);
    }
  }

  const label = TEMPLATE_LABELS[item.template_type] ?? item.template_type;
  const p = preview.data;

  return (
    <>
    <Modal
      open
      title={`Review: ${label}`}
      onClose={onClose}
      footer={
        <div class="flex gap-sm">
          <Button size="sm" variant="secondary" onClick={() => setViewing(true)}>View</Button>
          <Button size="sm" variant="danger" disabled={acting !== null} onClick={() => void handleDiscard()}>
            {acting === "discard" ? "Discarding…" : "Discard"}
          </Button>
          {!approved ? (
            <Button size="sm" variant="primary" disabled={acting !== null} onClick={() => void handleApprove()}>
              {acting === "approve" ? "Approving…" : "Approve"}
            </Button>
          ) : (
            <a href={`/app/jobs/${item.job_id}`}>
              <Button size="sm" variant="primary">
                Go to Job → Send for Signature
              </Button>
            </a>
          )}
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: "var(--text-base)" }}>{label}</div>
          <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
            {item.job_number} — {item.job_title}
            {item.client_name ? ` · ${item.client_name}` : ""}
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)", marginTop: "var(--space-xs)" }}>
            Generated {relativeTime(item.generated_at)}
          </div>
        </div>

        {preview.loading && (
          <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>Loading preview data…</div>
        )}

        {p && (
          <table style={{ width: "100%", fontSize: "var(--text-sm)", borderCollapse: "collapse" }}>
            <tbody>
              <tr>
                <td style={{ color: "var(--text-muted)", paddingRight: "var(--space-sm)", paddingBottom: "var(--space-xs)" }}>Job</td>
                <td style={{ paddingBottom: "var(--space-xs)" }}>{p.job_number} — {p.title}</td>
              </tr>
              <tr>
                <td style={{ color: "var(--text-muted)", paddingRight: "var(--space-sm)", paddingBottom: "var(--space-xs)" }}>Client</td>
                <td style={{ paddingBottom: "var(--space-xs)" }}>{p.client_name || "—"}</td>
              </tr>
              <tr>
                <td style={{ color: "var(--text-muted)", paddingRight: "var(--space-sm)", paddingBottom: "var(--space-xs)" }}>Address</td>
                <td style={{ paddingBottom: "var(--space-xs)" }}>{p.job_address || "—"}</td>
              </tr>
              <tr>
                <td style={{ color: "var(--text-muted)", paddingRight: "var(--space-sm)" }}>Contract Amount</td>
                <td>{p.contract_amount || "—"}</td>
              </tr>
            </tbody>
          </table>
        )}

        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", fontFamily: "monospace" }}>
          {item.filename}
        </div>
      </div>
    </Modal>

    {viewing && (
      <DocViewerModal
        jobId={item.job_id}
        docId={item.id}
        filename={item.filename}
        downloadPath={item.download_url}
        onClose={() => setViewing(false)}
      />
    )}
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function DocReviewQueue() {
  const queue = useApi<{ items: ReviewQueueItem[] }>("/api/documents/review-queue");
  const [reviewing, setReviewing] = useState<ReviewQueueItem | null>(null);
  const [acting, setActing] = useState<Record<string, "approve" | "discard">>({});
  const { push } = useToast();

  const items = queue.data?.items ?? [];

  // Hidden entirely when loading (to avoid flash) or empty
  if (queue.loading || queue.error || items.length === 0) return null;

  async function approve(item: ReviewQueueItem) {
    setActing((prev) => ({ ...prev, [item.id]: "approve" }));
    try {
      await api.post(
        `/api/jobs/${item.job_id}/generated-documents/${item.id}/approve`,
        {},
      );
      push("success", "Document approved.");
      queue.refetch();
    } catch (e) {
      push("error", e instanceof ApiError ? e.message : "Approve failed.");
    } finally {
      setActing((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    }
  }

  async function discard(item: ReviewQueueItem) {
    setActing((prev) => ({ ...prev, [item.id]: "discard" }));
    try {
      await api.post(
        `/api/jobs/${item.job_id}/generated-documents/${item.id}/discard`,
        {},
      );
      push("success", "Document discarded.");
      queue.refetch();
    } catch (e) {
      push("error", e instanceof ApiError ? e.message : "Discard failed.");
    } finally {
      setActing((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    }
  }

  function handleModalAction() {
    setReviewing(null);
    queue.refetch();
  }

  return (
    <>
      <div class="dash-card dash-card--highlight">
        <div class="dash-card__header">
          <h2 class="dash-card__title">Documents Pending Review</h2>
          <span class="dash-card__badge dash-card__badge--amber">{items.length}</span>
        </div>
        <div class="dash-card__body">
          {items.map((item) => {
            const label = TEMPLATE_LABELS[item.template_type] ?? item.template_type;
            const icon = TEMPLATE_ICON[item.template_type] ?? "📄";
            const busy = item.id in acting;
            return (
              <div key={item.id} class="action-item action-item--medium doc-review-item">
                <div class="action-item__main" style={{ pointerEvents: "none" }}>
                  <span class="action-item__icon">{icon}</span>
                  <span class="action-item__title">
                    <strong>{label}</strong>
                    {" — "}
                    <span style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>
                      {item.job_number} {item.job_title}
                    </span>
                  </span>
                  <span class="action-item__time">{relativeTime(item.generated_at)}</span>
                </div>
                <div class="doc-review-item__actions">
                  <Button size="sm" variant="secondary" onClick={() => setReviewing(item)}>
                    Review
                  </Button>
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => void approve(item)}>
                    {acting[item.id] === "approve" ? "…" : "Approve"}
                  </Button>
                  <Button size="sm" variant="tertiary" disabled={busy} onClick={() => void discard(item)}>
                    {acting[item.id] === "discard" ? "…" : "Discard"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {reviewing && (
        <ReviewModal
          item={reviewing}
          onClose={() => setReviewing(null)}
          onApprove={handleModalAction}
          onDiscard={handleModalAction}
        />
      )}
    </>
  );
}

/**
 * Receipt Review Queue — step-through UI for confirming processed (extracted
 * but unconfirmed) receipts without hunting through the Photos grid.
 *
 * Fetches GET /api/receipt-photos/queue (optional ?job_id= for per-job scope).
 * Reuses ReceiptConfirm from PhotosTab verbatim; onDone advances the queue
 * instead of closing a modal.
 */

import { useCallback, useEffect, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Spinner } from "../../components/ui/Spinner";
import { Badge } from "../../components/ui/Badge";
import { useToast } from "../../store/toast";
import { go } from "../../lib/nav";
import { formatCurrency, formatDate } from "../../lib/format";
import { ReceiptConfirm, type PhotoReceipt } from "../jobs/PhotosTab";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QueueItem {
  receipt_id: string;
  photo_id: string;
  job_id: string | null;
  job_number: number | null;
  job_title: string | null;
  client_name: string | null;
  thumb_url: string;
  original_url: string;
  ai_vendor: string | null;
  ai_amount: number | null;
  ai_date: string | null;
  ai_category: string | null;
  ai_confidence: number | null;
  expense_id: string | null;
  processing_status: string;
  created_at: string;
}

function jobLabel(item: QueueItem): string {
  const num =
    item.job_number != null
      ? `JOB-${String(item.job_number).padStart(3, "0")}`
      : "Job";
  const name = item.job_title ?? item.client_name ?? "";
  return name ? `${num} — ${name}` : num;
}

function toPhotoReceipt(item: QueueItem): PhotoReceipt {
  return {
    id: item.receipt_id,
    processing_status: item.processing_status,
    ai_vendor: item.ai_vendor,
    ai_amount: item.ai_amount,
    ai_date: item.ai_date,
    ai_category: item.ai_category,
    ai_confidence: item.ai_confidence,
    expense_id: item.expense_id,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ReceiptQueueView({ jobId }: { jobId?: string | null }) {
  const toast = useToast();
  const queueUrl = jobId
    ? `/api/receipt-photos/queue?job_id=${jobId}`
    : `/api/receipt-photos/queue`;

  const { data, loading, error, refetch } = useApi<{
    queue: QueueItem[];
    total: number;
  }>(queueUrl);

  // Local copy so we can remove confirmed items without waiting for a refetch.
  const [items, setItems] = useState<QueueItem[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [imgEnlarged, setImgEnlarged] = useState(false);

  useEffect(() => {
    if (data?.queue) {
      setItems(data.queue);
      setCurrentIdx(0);
    }
  }, [data]);

  const advanceQueue = useCallback(() => {
    setItems((prev) => {
      const next = prev.filter((_, i) => i !== currentIdx);
      if (currentIdx >= next.length) {
        setCurrentIdx(Math.max(0, next.length - 1));
      }
      return next;
    });
    refetch();
  }, [currentIdx, refetch]);

  if (loading) return <Spinner center />;
  if (error) {
    return (
      <div class="empty-state">
        <div class="empty-state__title">Couldn't load receipt queue</div>
        <div>{error}</div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div class="empty-state">
        <div class="empty-state__icon">✅</div>
        <div class="empty-state__title">All caught up</div>
        <div class="text--muted">
          No receipts waiting for review
          {jobId ? " on this job" : ""}.
        </div>
      </div>
    );
  }

  const current = items[currentIdx];
  if (!current) return null;

  return (
    <div class="receipt-queue">
      {/* ── Header ── */}
      <div class="receipt-queue__header">
        <div class="receipt-queue__count">
          <Badge tone="warning">
            {items.length} receipt{items.length !== 1 ? "s" : ""} to review
          </Badge>
          {items.length > 1 && (
            <span class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
              reviewing {currentIdx + 1} of {items.length}
            </span>
          )}
        </div>
        {current.job_id && (
          <button
            type="button"
            class="link-btn"
            style={{ fontSize: "var(--text-sm)" }}
            onClick={() => go(`/jobs/${current.job_id}`)}
          >
            {jobLabel(current)} →
          </button>
        )}
      </div>

      {/* ── Main review area ── */}
      <div class="receipt-queue__body">
        {/* Photo */}
        <div class="receipt-queue__photo-col">
          <img
            class="receipt-queue__img"
            src={current.original_url}
            alt={current.ai_vendor ?? "Receipt photo"}
            onClick={() => setImgEnlarged((v) => !v)}
            title="Click to enlarge"
          />
          {current.ai_date && (
            <div class="text--muted" style={{ fontSize: "var(--text-sm)", marginTop: "var(--space-2xs)" }}>
              {formatDate(current.ai_date)}
            </div>
          )}
          {!jobId && current.job_id && (
            <div style={{ marginTop: "var(--space-2xs)", fontSize: "var(--text-sm)" }}>
              <strong>{jobLabel(current)}</strong>
            </div>
          )}
        </div>

        {/* Confirm form */}
        <div class="receipt-queue__form-col">
          <ReceiptConfirm
            key={current.receipt_id}
            receipt={toPhotoReceipt(current)}
            jobId={current.job_id}
            onConfirmed={refetch}
            onDone={advanceQueue}
            toast={toast}
          />
        </div>
      </div>

      {/* ── Enlarged image overlay ── */}
      {imgEnlarged && (
        <div
          class="photo-zoom-overlay"
          onClick={() => setImgEnlarged(false)}
        >
          <button
            type="button"
            class="photo-zoom-overlay__close"
            aria-label="Close enlarged view"
            onClick={() => setImgEnlarged(false)}
          >
            ✕
          </button>
          <div class="photo-zoom-overlay__stage">
            <img
              class="photo-zoom-overlay__img"
              src={current.original_url}
              alt={current.ai_vendor ?? "Receipt"}
              onClick={(e) => e.stopPropagation()}
              draggable={false}
            />
          </div>
        </div>
      )}

      {/* ── Remaining queue list (compact, clickable) ── */}
      {items.length > 1 && (
        <div class="receipt-queue__list">
          <div class="receipt-queue__list-label text--muted" style={{ fontSize: "var(--text-sm)" }}>
            Remaining
          </div>
          {items.map((item, idx) => (
            <button
              key={item.receipt_id}
              type="button"
              class={`receipt-queue__list-item${idx === currentIdx ? " receipt-queue__list-item--active" : ""}`}
              onClick={() => setCurrentIdx(idx)}
            >
              <img
                class="receipt-queue__list-thumb"
                src={item.thumb_url}
                alt=""
                loading="lazy"
              />
              <div class="receipt-queue__list-meta">
                <div class="receipt-queue__list-vendor">
                  {item.ai_vendor ?? "Unknown vendor"}
                </div>
                <div class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
                  {item.ai_amount != null ? formatCurrency(item.ai_amount) : ""}
                  {item.ai_date ? ` · ${formatDate(item.ai_date)}` : ""}
                  {!jobId && item.job_id ? ` · ${jobLabel(item)}` : ""}
                </div>
              </div>
              {idx === currentIdx && (
                <Badge tone="info">Reviewing</Badge>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

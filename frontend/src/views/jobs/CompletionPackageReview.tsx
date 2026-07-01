import type { RoutableProps } from "preact-router";
import { useCallback, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatCurrency, formatDate, formatDateTime } from "../../lib/format";

const GOOGLE_REVIEW_LINK = "https://g.page/r/CQ_gM4-vOzjFEBM/review";

interface CompletionPackageData {
  job: { id: string; title: string; client_name: string; job_number: string };
  warranty: {
    document_id: string | null;
    r2_key: string | null;
    generated_at: string | null;
    status: "ready" | "pending" | "missing";
  };
  final_invoice: {
    invoice_id: string | null;
    amount: number | null;
    paid_at: string | null;
    status: "ready" | "missing";
  };
  lien_waiver: {
    waiver_id: string | null;
    status: "pending" | "sent" | "signed" | "declined" | "failed" | "missing";
    sent_at: string | null;
    signed_at: string | null;
    document_id: string | null;
  };
  photos: {
    before: Array<{ id: string; r2_thumbnail_key: string | null; r2_url: string | null; caption: string | null }>;
    after: Array<{ id: string; r2_thumbnail_key: string | null; r2_url: string | null; caption: string | null }>;
  };
  package_status: "not_ready" | "ready_to_send" | "sent";
  sent_at: string | null;
  review_enabled: boolean;
  review_received: boolean;
  review_received_at: string | null;
  review_log: Array<{ event: string; sent_at: string }>;
}

interface DetailProps extends RoutableProps {
  id?: string;
}

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : (e as Error).message;
}

function statusBanner(status: CompletionPackageData["package_status"], sentAt: string | null) {
  if (status === "sent") {
    return {
      className: "callout callout--info completion-package-banner",
      text: sentAt
        ? `Sent ${formatDateTime(sentAt)} — package delivered to client`
        : "Sent — package delivered to client",
    };
  }
  if (status === "ready_to_send") {
    return {
      className: "callout callout--success completion-package-banner",
      text: "Ready to send — all items confirmed",
    };
  }
  return {
    className: "callout callout--warning completion-package-banner",
    text: "Package not ready — lien waiver signature pending",
  };
}

function PackageSkeleton() {
  return (
    <div class="completion-package-grid">
      {[1, 2, 3, 4].map((n) => (
        <div key={n} class="completion-package-card completion-package-card--skeleton" aria-hidden="true" />
      ))}
    </div>
  );
}

export function CompletionPackageReview({ id }: DetailProps) {
  const toast = useToast();
  const jobId = id ?? "";
  const { data: jobDetail } = useApi<{ job: { client_email: string | null } }>(
    jobId ? `/api/jobs/${jobId}` : null,
  );
  const { data, loading, error, refetch } = useApi<CompletionPackageData>(
    jobId ? `/api/jobs/${jobId}/completion-package` : null,
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [localStatus, setLocalStatus] = useState<CompletionPackageData["package_status"] | null>(null);
  const [localSentAt, setLocalSentAt] = useState<string | null>(null);
  const [markingReceived, setMarkingReceived] = useState(false);
  const [localReviewReceived, setLocalReviewReceived] = useState<boolean | null>(null);
  const [localReviewEnabled, setLocalReviewEnabled] = useState<boolean | null>(null);
  const [togglingReview, setTogglingReview] = useState(false);

  const markReviewReceived = useCallback(async () => {
    if (!jobId) return;
    setMarkingReceived(true);
    try {
      await api.put(`/api/jobs/${jobId}/review-received`, {});
      setLocalReviewReceived(true);
      toast.push("success", "Review marked as received");
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setMarkingReceived(false);
    }
  }, [jobId, toast]);

  const toggleReviewEnabled = useCallback(async (enabled: boolean) => {
    if (!jobId) return;
    setTogglingReview(true);
    try {
      await api.put(`/api/jobs/${jobId}`, { review_enabled: enabled });
      setLocalReviewEnabled(enabled);
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setTogglingReview(false);
    }
  }, [jobId, toast]);

  const pkg = data;
  const packageStatus = localStatus ?? pkg?.package_status ?? "not_ready";
  const sentAt = localSentAt ?? pkg?.sent_at ?? null;
  const reviewEnabled = localReviewEnabled ?? pkg?.review_enabled ?? true;
  const reviewReceived = localReviewReceived ?? pkg?.review_received ?? false;
  const banner = statusBanner(packageStatus, sentAt);

  const send = useCallback(async () => {
    if (!jobId) return;
    setSending(true);
    try {
      const r = await api.post<{ sent_at: string; package_status: string }>(
        `/api/jobs/${jobId}/completion-package/send`,
        {},
      );
      setLocalStatus("sent");
      setLocalSentAt(r.sent_at);
      setConfirmOpen(false);
      toast.push("success", "Completion package sent to client");
      refetch();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setSending(false);
    }
  }, [jobId, refetch, toast]);

  if (!jobId) {
    return (
      <div class="empty-state">
        <div class="empty-state__title">Job not found</div>
      </div>
    );
  }

  const beforeCount = pkg?.photos.before.length ?? 0;
  const afterCount = pkg?.photos.after.length ?? 0;
  const photoTotal = beforeCount + afterCount;
  const clientEmail = jobDetail?.job.client_email ?? "client email on file";

  return (
    <div class="completion-package-page stack">
      <div class="view-header">
        <div>
          <div class="flex items-center gap-sm">
            <Button variant="tertiary" size="sm" onClick={() => go(`/jobs/${jobId}`)}>
              ← Job
            </Button>
          </div>
          <h1 class="view-title">
            Completion Package — {pkg?.job.title ?? "…"}
          </h1>
          <p class="view-subtitle">
            {pkg?.job.client_name ?? "—"}
            {pkg?.job.job_number ? ` · Job #${pkg.job.job_number}` : ""}
          </p>
        </div>
      </div>

      {loading ? (
        <PackageSkeleton />
      ) : error ? (
        <div class="empty-state">
          <div class="empty-state__title">Couldn't load completion package</div>
          <div>{error}</div>
          <Button variant="secondary" class="mt-md" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : pkg ? (
        <>
          <div class={banner.className} role="status">
            {banner.text}
          </div>

          <section class="stack">
            <h2 class="completion-package-section-title">What's in the package</h2>
            <div class="completion-package-grid">
              <WarrantyCard jobId={jobId} warranty={pkg.warranty} />
              <InvoiceCard invoice={pkg.final_invoice} />
              <LienWaiverCard lien={pkg.lien_waiver} />
              <PhotosCard jobId={jobId} before={pkg.photos.before} after={pkg.photos.after} />
            </div>
          </section>

          <div class="completion-package-send">
            {packageStatus === "sent" ? (
              <div class="completion-package-sent-confirm text--muted">
                ✓ Sent{sentAt ? ` ${formatDateTime(sentAt)}` : ""}
              </div>
            ) : (
              <Button
                variant="primary"
                disabled={packageStatus !== "ready_to_send"}
                title={packageStatus !== "ready_to_send" ? "Lien waiver signature required" : undefined}
                onClick={() => setConfirmOpen(true)}
              >
                Send Completion Package
              </Button>
            )}
          </div>

          <GoogleReviewCard
            jobId={jobId}
            packageStatus={packageStatus}
            sentAt={sentAt}
            reviewEnabled={reviewEnabled}
            reviewReceived={reviewReceived}
            reviewReceivedAt={pkg?.review_received_at ?? null}
            reviewLog={pkg?.review_log ?? []}
            markingReceived={markingReceived}
            togglingReview={togglingReview}
            onMarkReceived={() => void markReviewReceived()}
            onToggleEnabled={(v) => void toggleReviewEnabled(v)}
          />
        </>
      ) : null}

      <Modal
        open={confirmOpen}
        title="Send completion package?"
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={sending} onClick={() => void send()}>
              {sending ? "Sending…" : "Send now"}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          Send completion package to {pkg?.job.client_name ?? "the client"} at {clientEmail}? This will
          email the warranty certificate, final invoice, signed lien waiver, and {photoTotal} photo
          {photoTotal === 1 ? "" : "s"}.
        </p>
      </Modal>
    </div>
  );
}

function WarrantyCard({
  jobId,
  warranty,
}: {
  jobId: string;
  warranty: CompletionPackageData["warranty"];
}) {
  const tone = warranty.status === "ready" ? "success" : warranty.status === "pending" ? "warning" : "error";
  const label =
    warranty.status === "ready" ? "Ready ✓" : warranty.status === "pending" ? "Generating…" : "Missing";
  return (
    <div class="completion-package-card">
      <div class="completion-package-card__head">
        <span class="completion-package-card__icon" aria-hidden="true">🛡️</span>
        <span class="completion-package-card__title">Warranty Certificate</span>
        <Badge tone={tone}>{label}</Badge>
      </div>
      {warranty.status === "ready" && warranty.generated_at && (
        <div class="completion-package-card__body">
          <div>Generated {formatDate(warranty.generated_at)}</div>
          {warranty.document_id && (
            <a
              href={`/api/jobs/${jobId}/documents/${warranty.document_id}/download`}
              target="_blank"
              rel="noreferrer"
            >
              Download
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function InvoiceCard({ invoice }: { invoice: CompletionPackageData["final_invoice"] }) {
  const ready = invoice.status === "ready";
  return (
    <div class="completion-package-card">
      <div class="completion-package-card__head">
        <span class="completion-package-card__icon" aria-hidden="true">🧾</span>
        <span class="completion-package-card__title">Final Invoice</span>
        <Badge tone={ready ? "success" : "error"}>{ready ? "Paid ✓" : "Missing"}</Badge>
      </div>
      {ready && invoice.paid_at != null && invoice.amount != null && (
        <div class="completion-package-card__body">
          Paid {formatDate(invoice.paid_at)} · {formatCurrency(invoice.amount)}
        </div>
      )}
    </div>
  );
}

function LienWaiverCard({ lien }: { lien: CompletionPackageData["lien_waiver"] }) {
  let tone: "success" | "warning" | "neutral" | "error" = "neutral";
  let label = "Not sent";
  if (lien.status === "signed") {
    tone = "success";
    label = "Signed ✓";
  } else if (lien.status === "sent") {
    tone = "warning";
    label = "Awaiting signature";
  } else if (lien.status === "missing") {
    label = "Not sent";
  } else if (lien.status === "failed" || lien.status === "declined") {
    tone = "error";
    label = formatStatusLabel(lien.status);
  }

  return (
    <div class="completion-package-card">
      <div class="completion-package-card__head">
        <span class="completion-package-card__icon" aria-hidden="true">✍️</span>
        <span class="completion-package-card__title">Lien Waiver</span>
        <Badge tone={tone}>{label}</Badge>
      </div>
      <div class="completion-package-card__body">
        {lien.status === "sent" && lien.sent_at && (
          <div>Sent {formatDate(lien.sent_at)} — waiting on client</div>
        )}
        {lien.status === "signed" && lien.signed_at && (
          <>
            <div>Signed {formatDate(lien.signed_at)}</div>
            {lien.document_id && (
              <a href={`/api/documents/${lien.document_id}/file`} target="_blank" rel="noreferrer">
                Download
              </a>
            )}
          </>
        )}
        {lien.status === "missing" && <div class="text--muted">Not sent yet</div>}
      </div>
    </div>
  );
}

function PhotosCard({
  jobId,
  before,
  after,
}: {
  jobId: string;
  before: CompletionPackageData["photos"]["before"];
  after: CompletionPackageData["photos"]["after"];
}) {
  const thumbs = [...before.slice(0, 2), ...after.slice(0, 2)];
  return (
    <div class="completion-package-card">
      <div class="completion-package-card__head">
        <span class="completion-package-card__icon" aria-hidden="true">📷</span>
        <span class="completion-package-card__title">Photos</span>
      </div>
      <div class="completion-package-card__body stack">
        <div>
          {before.length} before · {after.length} after
        </div>
        {before.length === 0 && after.length === 0 ? (
          <div class="callout callout--warning" style={{ fontSize: "var(--text-sm)", padding: "var(--space-xs)" }}>
            No before/after photos tagged —{" "}
            <Button variant="tertiary" size="sm" onClick={() => go(`/jobs/${jobId}`)}>
              Open Photos tab
            </Button>
          </div>
        ) : (
          <div class="completion-package-thumbs">
            {thumbs.map((p) =>
              p.r2_url ? (
                <img key={p.id} src={p.r2_url} alt={p.caption ?? "Project photo"} loading="lazy" />
              ) : null,
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatStatusLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Google Review Card (Sprint 35) ──────────────────────────────────────────

function GoogleReviewCard({
  packageStatus,
  sentAt,
  reviewEnabled,
  reviewReceived,
  reviewReceivedAt,
  reviewLog,
  markingReceived,
  togglingReview,
  onMarkReceived,
  onToggleEnabled,
}: {
  jobId: string;
  packageStatus: CompletionPackageData["package_status"];
  sentAt: string | null;
  reviewEnabled: boolean;
  reviewReceived: boolean;
  reviewReceivedAt: string | null;
  reviewLog: Array<{ event: string; sent_at: string }>;
  markingReceived: boolean;
  togglingReview: boolean;
  onMarkReceived: () => void;
  onToggleEnabled: (v: boolean) => void;
}) {
  const requestRow  = reviewLog.find((r) => r.event === "google_review_request");
  const followup1   = reviewLog.find((r) => r.event === "google_review_followup_1");
  const followup2   = reviewLog.find((r) => r.event === "google_review_followup_2");

  // Build status line.
  const statusParts: string[] = [];
  if (requestRow)  statusParts.push(`Sent ${formatDate(requestRow.sent_at)}`);
  if (followup1)   statusParts.push(`Follow-up sent ${formatDate(followup1.sent_at)}`);
  if (followup2)   statusParts.push(`Final follow-up sent ${formatDate(followup2.sent_at)}`);
  // Show next follow-up only when enabled & not received & sequence not complete.
  if (reviewEnabled && !reviewReceived && requestRow && !followup1) {
    const nextDate = new Date(new Date(requestRow.sent_at).getTime() + 3 * 86_400_000);
    statusParts.push(`Next follow-up ${formatDate(nextDate.toISOString())}`);
  } else if (reviewEnabled && !reviewReceived && followup1 && !followup2) {
    const nextDate = new Date(new Date(requestRow!.sent_at).getTime() + 7 * 86_400_000);
    statusParts.push(`Next follow-up ${formatDate(nextDate.toISOString())}`);
  }

  return (
    <section class="completion-package-card" style={{ marginTop: "var(--space-lg)" }}>
      <div class="completion-package-card__head">
        <span class="completion-package-card__icon" aria-hidden="true">⭐</span>
        <span class="completion-package-card__title">Google Review</span>
      </div>

      <div class="completion-package-card__body stack" style={{ gap: "var(--space-sm)" }}>
        <label class="flex items-center gap-sm" style={{ cursor: togglingReview ? "wait" : "pointer" }}>
          <input
            type="checkbox"
            checked={reviewEnabled}
            disabled={togglingReview}
            onChange={(e) => onToggleEnabled((e.target as HTMLInputElement).checked)}
          />
          <span>Request review on completion</span>
        </label>

        {reviewReceived ? (
          <div style={{ color: "var(--color-success, #16a34a)", fontWeight: 600 }}>
            Review received ✓{reviewReceivedAt ? ` — ${formatDate(reviewReceivedAt)}` : ""}
          </div>
        ) : packageStatus !== "sent" ? (
          <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
            Sends automatically after completion package
          </div>
        ) : (
          <>
            {statusParts.length > 0 && (
              <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
                {statusParts.join(" · ")}
              </div>
            )}
            {reviewEnabled && (
              <Button
                size="sm"
                variant="secondary"
                disabled={markingReceived}
                onClick={onMarkReceived}
              >
                {markingReceived ? "Marking…" : "Mark review received"}
              </Button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

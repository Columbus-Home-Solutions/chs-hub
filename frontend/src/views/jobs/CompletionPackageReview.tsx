import type { RoutableProps } from "preact-router";
import { useCallback, useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Modal } from "../../components/ui/Modal";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { go } from "../../lib/nav";
import { formatCurrency, formatDate, formatDateTime } from "../../lib/format";
import { DocViewerModal } from "../../components/DocViewerModal";

const GOOGLE_REVIEW_LINK = "https://g.page/r/CQ_gM4-vOzjFEBM/review";

interface CompletionPackageData {
  job: { id: string; title: string; client_name: string; job_number: string };
  warranty: {
    document_id: string | null;
    filename: string | null;
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
    document_id: string | null;
    filename: string | null;
    generated_at: string | null;
    status: "ready" | "missing";
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
    text: "Package not ready — missing items below",
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
              <InvoiceCard invoice={pkg.final_invoice} jobId={jobId} onCreated={refetch} />
              <LienWaiverCard lien={pkg.lien_waiver} jobId={jobId} />
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
                title={packageStatus !== "ready_to_send" ? "All items must be ready before sending" : undefined}
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
          Send completion package to {pkg?.job.client_name ?? "the client"} at {clientEmail}?           This will
          email the warranty certificate, final invoice, conditional lien waiver, and {photoTotal} photo
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
  const [viewing, setViewing] = useState(false);
  const tone = warranty.status === "ready" ? "success" : warranty.status === "pending" ? "warning" : "error";
  const label =
    warranty.status === "ready" ? "Ready ✓" : warranty.status === "pending" ? "Generating…" : "Missing";
  return (
    <>
      <div class="completion-package-card">
        <div class="completion-package-card__head">
          <span class="completion-package-card__icon" aria-hidden="true">🛡️</span>
          <span class="completion-package-card__title">Warranty Certificate</span>
          <Badge tone={tone}>{label}</Badge>
        </div>
        {warranty.status === "ready" && warranty.generated_at && (
          <div class="completion-package-card__body">
            <div>Generated {formatDate(warranty.generated_at)}</div>
            <div class="flex gap-sm">
              {warranty.document_id && (
                <Button size="sm" variant="tertiary" onClick={() => setViewing(true)}>
                  View
                </Button>
              )}
              {warranty.document_id && (
                <a
                  href={`/api/jobs/${jobId}/documents/${warranty.document_id}/download`}
                  target="_blank"
                  rel="noreferrer"
                  class="btn btn--sm btn--tertiary"
                >
                  Download
                </a>
              )}
            </div>
          </div>
        )}
      </div>
      {viewing && warranty.document_id && (
        <DocViewerModal
          jobId={jobId}
          docId={warranty.document_id}
          filename={warranty.filename ?? "warranty-certificate.docx"}
          downloadPath={`/api/jobs/${jobId}/documents/${warranty.document_id}/download`}
          onClose={() => setViewing(false)}
        />
      )}
    </>
  );
}

function InvoiceCard({
  invoice,
  jobId,
  onCreated,
}: {
  invoice: CompletionPackageData["final_invoice"];
  jobId: string;
  onCreated: () => void;
}) {
  const toast = useToast();
  const ready = invoice.status === "ready";
  const [generating, setGenerating] = useState(false);
  const [confirmAmount, setConfirmAmount] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const generate = async () => {
    setGenerating(true);
    try {
      const r = await api.get<{
        summary: { contract_total: number; total_invoiced: number };
        suggestions: { final: { amount: number } | null };
      }>(`/api/jobs/${jobId}/invoices`);
      // Prefer the suggestion (it excludes void invoices by spec); fall back to
      // raw summary math if the suggestion engine didn't surface it (e.g. there
      // are still pending milestones shown).
      const amt =
        r.suggestions?.final?.amount ??
        Math.max(0, Math.round((r.summary.contract_total - r.summary.total_invoiced) * 100) / 100);
      if (amt <= 0) {
        toast.push("info", "No remaining balance — all invoiced");
        return;
      }
      setConfirmAmount(amt);
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setGenerating(false);
    }
  };

  const createInvoice = async () => {
    if (confirmAmount == null) return;
    setCreating(true);
    try {
      await api.post(`/api/invoices`, {
        job_id: jobId,
        invoice_type: "final",
        title: "Final Invoice — Remaining Balance",
        amount: confirmAmount,
      });
      toast.push("success", "Final invoice created (draft)");
      setConfirmAmount(null);
      onCreated();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
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
        {!ready && (
          <div class="completion-package-card__body">
            <Button size="sm" variant="primary" disabled={generating} onClick={() => void generate()}>
              {generating ? "Calculating…" : "Generate final invoice"}
            </Button>
          </div>
        )}
      </div>

      <Modal
        open={confirmAmount != null}
        title="Create final invoice"
        onClose={() => setConfirmAmount(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmAmount(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={creating} onClick={() => void createInvoice()}>
              {creating ? "Creating…" : "Create draft"}
            </Button>
          </>
        }
      >
        <p style={{ margin: "0 0 var(--space-md)" }}>
          Calculated remaining balance — this amount is read-only and cannot be edited here.
          Use the Financial tab to create a manual invoice if an adjustment is needed.
        </p>
        <div class="form-input form-input--readonly" style={{ fontSize: "var(--text-lg)", fontWeight: 700 }}>
          {formatCurrency(confirmAmount ?? 0)}
        </div>
      </Modal>
    </>
  );
}

function LienWaiverCard({
  lien,
  jobId,
}: {
  lien: CompletionPackageData["lien_waiver"];
  jobId: string;
}) {
  const [viewing, setViewing] = useState(false);
  const tone: "success" | "neutral" = lien.status === "ready" ? "success" : "neutral";
  const label = lien.status === "ready" ? "Ready ✓" : "Not generated";

  return (
    <>
      <div class="completion-package-card">
        <div class="completion-package-card__head">
          <span class="completion-package-card__icon" aria-hidden="true">✍️</span>
          <span class="completion-package-card__title">Lien Waiver</span>
          <Badge tone={tone}>{label}</Badge>
        </div>
        <div class="completion-package-card__body">
          {lien.status === "ready" && lien.generated_at && (
            <>
              <div>Generated {formatDate(lien.generated_at)} — contractor signed</div>
              <div class="flex gap-sm">
                {lien.document_id && (
                  <Button size="sm" variant="tertiary" onClick={() => setViewing(true)}>
                    View
                  </Button>
                )}
                {lien.document_id && (
                  <a
                    href={`/api/jobs/${jobId}/documents/${lien.document_id}/download`}
                    target="_blank"
                    rel="noreferrer"
                    class="btn btn--sm btn--tertiary"
                  >
                    Download
                  </a>
                )}
              </div>
            </>
          )}
          {lien.status === "missing" && (
            <div class="text--muted">
              Auto-generates when the final invoice is marked paid
            </div>
          )}
        </div>
      </div>
      {viewing && lien.document_id && (
        <DocViewerModal
          jobId={jobId}
          docId={lien.document_id}
          filename={lien.filename ?? "lien-waiver-conditional.docx"}
          downloadPath={`/api/jobs/${jobId}/documents/${lien.document_id}/download`}
          onClose={() => setViewing(false)}
        />
      )}
    </>
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

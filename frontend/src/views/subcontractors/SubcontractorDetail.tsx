import type { RoutableProps } from "preact-router";
import { useState } from "preact/hooks";
import { useApi } from "../../hooks/useApi";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { go, BASE } from "../../lib/nav";
import { formatCurrency, formatDate, formatPhone, formatStatus } from "../../lib/format";
import { useAuth } from "../../store/auth";
import { isOwner } from "../../lib/rbac";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import type { Subcontractor } from "../../types";
import { SubForm, ExpirationBadge, daysUntilExpiration, DeleteSubButton } from "./SubcontractorList";
import { PacketReviewModal } from "./PacketReviewModal";
import type { Packet } from "./PacketReviewModal";

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2, CURRENT_YEAR - 3];

interface PaymentLine {
  id: string;
  amount: number;
  date: string | null;
  description: string | null;
  expense_type: string | null;
  is_1099_reportable: boolean;
  job_id: string | null;
  job_number: number | null;
  job_title: string | null;
}
interface YearTotal {
  year: string;
  total: number;
  total_1099: number;
  count: number;
}
interface SubPayments {
  year: number;
  ytd: number;
  ytd_1099: number;
  lifetime: number;
  count: number;
  by_year: YearTotal[];
  history: PaymentLine[];
}
interface SubDetailResponse {
  subcontractor: Subcontractor;
  payments: SubPayments;
}

export function SubcontractorDetail({ id, path }: RoutableProps & { id?: string }) {
  const { user } = useAuth();
  const { data, loading, error, refetch } = useApi<SubDetailResponse>(
    id ? `/api/subcontractors/${id}` : null,
  );
  const { data: packetsData, refetch: refetchPackets } = useApi<{ packets: Packet[] }>(
    id ? `/api/subcontractors/${id}/packets` : null,
  );
  const [editing, setEditing] = useState(false);
  const [cpaModalOpen, setCpaModalOpen] = useState(false);
  const [cpaYear, setCpaYear] = useState(String(CURRENT_YEAR));
  const [reviewPacket, setReviewPacket] = useState<Packet | null>(null);
  const [sendingPacket, setSendingPacket] = useState(false);
  const [packetSendError, setPacketSendError] = useState<string | null>(null);
  const [packetSendOk, setPacketSendOk] = useState(false);

  const onLaborRoute =
    typeof path === "string"
      ? path.includes("/labor/")
      : typeof window !== "undefined" && window.location.pathname.includes(`${BASE}/labor/`);

  if (loading) return <Spinner center />;
  if (error || !data) {
    return <div class="empty-state">Couldn't load subcontractor: {error ?? "not found"}</div>;
  }

  const s = data.subcontractor;
  const p = data.payments;
  const isLabor =
    onLaborRoute || (s.worker_type ?? "subcontractor") === "day_rate_labor";
  const listPath = isLabor ? "/labor" : "/subcontractors";

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">
            {s.company_name ?? "—"}{" "}
            {!isLabor && s.trade && <Badge tone="info">{s.trade}</Badge>}
            {isLabor && s.day_rate != null && (
              <Badge tone="info">{formatCurrency(s.day_rate)}/day</Badge>
            )}
            {!s.is_active && <Badge>Inactive</Badge>}
          </h1>
          <p class="view-subtitle">
            {s.contact_name ?? "—"} · {formatPhone(s.phone)} · {s.email ?? "—"}
          </p>
        </div>
        <div class="view-header__right">
          <Button variant="tertiary" onClick={() => go(listPath)}>
            ← Back
          </Button>
          {isOwner(user) && id && !isLabor && <ComplianceCheckButton subId={id} />}
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <DeleteSubButton sub={s} listBase={isLabor ? "/labor" : "/subcontractors"} />
        </div>
      </div>

      <div class="detail-grid">
        <div class="stack">
          <Card
            title="Payments"
            actions={
              isOwner(user) ? (
                <Button size="sm" variant="secondary" onClick={() => setCpaModalOpen(true)}>
                  ⬇ CPA Export
                </Button>
              ) : undefined
            }
          >
            <div class="fin-summary">
              <div class="fin-stat fin-stat--success">
                <div class="fin-stat__label">Paid in {p.year}</div>
                <div class="fin-stat__value">{formatCurrency(p.ytd)}</div>
              </div>
              <div class="fin-stat">
                <div class="fin-stat__label">1099-reportable ({p.year})</div>
                <div class="fin-stat__value">{formatCurrency(p.ytd_1099)}</div>
              </div>
              <div class="fin-stat">
                <div class="fin-stat__label">Lifetime paid</div>
                <div class="fin-stat__value">{formatCurrency(p.lifetime)}</div>
              </div>
              <div class="fin-stat">
                <div class="fin-stat__label">Payments</div>
                <div class="fin-stat__value">{p.count}</div>
              </div>
            </div>

            {p.by_year.length > 0 && (
              <div style={{ marginTop: "var(--space-md)" }}>
                <table class="table">
                  <thead>
                    <tr>
                      <th>Year</th>
                      <th class="num">Paid</th>
                      <th class="num">1099</th>
                      <th class="num">Payments</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.by_year.map((y) => (
                      <tr key={y.year}>
                        <td>{y.year}</td>
                        <td class="num">{formatCurrency(y.total)}</td>
                        <td class="num text--muted">{formatCurrency(y.total_1099)}</td>
                        <td class="num text--muted">{y.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Payment history">
            {p.history.length === 0 ? (
              <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
                No payments recorded. Sub payments come from expenses tagged to this sub.
              </p>
            ) : (
              <div class="stack">
                {p.history.map((h) => (
                  <div key={h.id} class="invoice-row">
                    <div class="invoice-row__main">
                      <div class="invoice-row__title">
                        {h.description ?? (h.expense_type ? formatStatus(h.expense_type) : "Payment")}
                        {h.is_1099_reportable && <Badge tone="info">1099</Badge>}
                      </div>
                      <div class="invoice-row__meta">
                        {h.date ? formatDate(h.date) : "—"}
                        {h.job_id
                          ? ` · ${h.job_title ?? `Job #${h.job_number ?? "—"}`}`
                          : " · no job"}
                      </div>
                    </div>
                    <div class="invoice-row__amount">{formatCurrency(h.amount)}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div class="stack">
          <Card title="Details">
            <div class="kv">
              {!isLabor && (
                <div class="kv__row">
                  <span class="kv__label">Trade</span>
                  <span class="kv__value">{s.trade ?? "—"}</span>
                </div>
              )}
              {isLabor && (
                <div class="kv__row">
                  <span class="kv__label">Day rate</span>
                  <span class="kv__value">
                    {s.day_rate == null ? "—" : `${formatCurrency(s.day_rate)}/day`}
                  </span>
                </div>
              )}
              <div class="kv__row">
                <span class="kv__label">Contact</span>
                <span class="kv__value">{s.contact_name ?? "—"}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Phone</span>
                <span class="kv__value">{formatPhone(s.phone)}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">Email</span>
                <span class="kv__value">{s.email ?? "—"}</span>
              </div>
              <div class="kv__row">
                <span class="kv__label">{isLabor ? "SSN" : "Tax ID / EIN"}</span>
                <span class="kv__value">{s.tax_id ?? "—"}</span>
              </div>
              {!isLabor && (
                <>
                  <div class="kv__row">
                    <span class="kv__label">License</span>
                    <span class="kv__value">{s.license_number ?? "—"}</span>
                  </div>
                  <div class="kv__row">
                    <span class="kv__label">Hourly rate</span>
                    <span class="kv__value">
                      {s.hourly_rate == null ? "—" : `${formatCurrency(s.hourly_rate)}/hr`}
                    </span>
                  </div>
                </>
              )}
              <div class="kv__row">
                <span class="kv__label">Rating</span>
                <span class="kv__value">{s.rating == null ? "—" : `${s.rating}/5`}</span>
              </div>
              {!isLabor && (
                <>
                  <div class="kv__row">
                    <span class="kv__label">Insurance</span>
                    <span class="kv__value">
                      {s.insurance_on_file ? <Badge tone="success">On file</Badge> : <Badge>No</Badge>}
                    </span>
                  </div>
                  <div class="kv__row">
                    <span class="kv__label">COI Expiration</span>
                    <span class="kv__value">
                      {s.coi_expiration_date ? (
                        <span class="flex items-center gap-sm">
                          <span>{formatDate(s.coi_expiration_date)}</span>
                          <ExpirationBadge date={s.coi_expiration_date} />
                        </span>
                      ) : (
                        <span class="text--muted">—</span>
                      )}
                    </span>
                  </div>
                </>
              )}
              <div class="kv__row">
                <span class="kv__label">W-9</span>
                <span class="kv__value">
                  {s.w9_on_file ? <Badge tone="success">On file</Badge> : <Badge>No</Badge>}
                </span>
              </div>
              {!isLabor && (
                <div class="kv__row">
                  <span class="kv__label">License Expiration</span>
                  <span class="kv__value">
                    {s.license_expiration_date ? (
                      <span class="flex items-center gap-sm">
                        <span>{formatDate(s.license_expiration_date)}</span>
                        <ExpirationBadge date={s.license_expiration_date} />
                      </span>
                    ) : (
                      <span class="text--muted">—</span>
                    )}
                  </span>
                </div>
              )}
            </div>
          </Card>

          {/* Compliance alert banner when a date is expired or expiring within 30 days */}
          {!isLabor &&
            ((daysUntilExpiration(s.coi_expiration_date) !== null &&
              (daysUntilExpiration(s.coi_expiration_date) ?? 999) <= 30) ||
              (daysUntilExpiration(s.license_expiration_date) !== null &&
                (daysUntilExpiration(s.license_expiration_date) ?? 999) <= 30)) && (
            <div class="alert alert--warning" role="alert">
              <strong>Compliance alert:</strong>{" "}
              {(daysUntilExpiration(s.coi_expiration_date) ?? 999) <= 30 && s.coi_expiration_date && (
                <span>COI expires {(daysUntilExpiration(s.coi_expiration_date) ?? 0) <= 0 ? "TODAY" : `in ${daysUntilExpiration(s.coi_expiration_date)} days`}. </span>
              )}
              {(daysUntilExpiration(s.license_expiration_date) ?? 999) <= 30 && s.license_expiration_date && (
                <span>License expires {(daysUntilExpiration(s.license_expiration_date) ?? 0) <= 0 ? "TODAY" : `in ${daysUntilExpiration(s.license_expiration_date)} days`}.</span>
              )}
              {" "}Update the expiration date once renewed.
            </div>
          )}

          {s.flat_rate_notes && (
            <Card title="Rate notes">
              <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>{s.flat_rate_notes}</p>
            </Card>
          )}

          {s.notes && (
            <Card title="Notes">
              <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>{s.notes}</p>
            </Card>
          )}

          {/* ── Onboarding Packet (Sprint 39) ───────────────────────── */}
          {isOwner(user) && !isLabor && (
            <OnboardingCard
              subId={id ?? ""}
              subName={s.company_name ?? s.contact_name ?? "Sub"}
              packets={packetsData?.packets ?? []}
              sendingPacket={sendingPacket}
              packetSendError={packetSendError}
              packetSendOk={packetSendOk}
              onSendPacket={async () => {
                setSendingPacket(true);
                setPacketSendError(null);
                setPacketSendOk(false);
                try {
                  const res = await fetch(`/api/subcontractors/${id}/packets`, { method: "POST" });
                  const body = await res.json().catch(() => ({}));
                  if (!res.ok) throw new Error((body as { details?: string; error?: string })?.details ?? (body as { error?: string })?.error ?? "Failed to send");
                  setPacketSendOk(true);
                  refetchPackets();
                } catch (e) {
                  setPacketSendError((e as Error).message);
                } finally {
                  setSendingPacket(false);
                }
              }}
              onReviewPacket={setReviewPacket}
            />
          )}
        </div>
      </div>

      {editing && (
        <SubForm
          mode="edit"
          sub={s}
          defaultWorkerType={isLabor ? "day_rate_labor" : "subcontractor"}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refetch();
          }}
        />
      )}

      {reviewPacket && (
        <PacketReviewModal
          packet={reviewPacket}
          subName={s.company_name ?? s.contact_name ?? "Sub"}
          onClose={() => setReviewPacket(null)}
          onApproved={() => {
            setReviewPacket(null);
            refetchPackets();
          }}
        />
      )}

      {cpaModalOpen && (
        <Modal
          open
          title="Download CPA Export"
          onClose={() => setCpaModalOpen(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setCpaModalOpen(false)}>
                Cancel
              </Button>
              <a
                href={`/api/reports/cpa-export?year=${cpaYear}`}
                download
                class="btn btn--primary"
                onClick={() => setCpaModalOpen(false)}
              >
                Download CSV
              </a>
            </>
          }
        >
          <div style={{ marginBottom: "var(--space-sm)" }}>
            <label class="form-label">Tax Year</label>
            <select
              class="form-input"
              value={cpaYear}
              onChange={(e) => setCpaYear((e.target as HTMLSelectElement).value)}
            >
              {YEAR_OPTIONS.map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
            Full-year CPA export (same as Financial → CPA Export).{" "}
            <strong>{s.company_name ?? "This sub"}</strong> appears in Section 3 — 1099
            Candidates — when they have payments in the selected year. Tax ID is included when
            set.
          </p>
        </Modal>
      )}
    </div>
  );
}

// ── OnboardingCard ─────────────────────────────────────────────────────────────
// Shows the most recent packet status + actions. Wires into PacketReviewModal for
// submitted / approved / awaiting_signature / signed packets.

const PACKET_STATUS_LABELS: Record<string, string> = {
  sent: "Link sent — awaiting sub",
  in_progress: "Sub working on it",
  submitted: "Submitted — review needed",
  approved: "Documents approved",
  awaiting_signature: "Agreement sent — awaiting signature",
  signed: "Signed — onboarding complete",
};

const PACKET_STATUS_TONES: Record<string, "success" | "warning" | "info" | "error" | undefined> = {
  sent: undefined,
  in_progress: "info",
  submitted: "warning",
  approved: "info",
  awaiting_signature: "info",
  signed: "success",
};

interface OnboardingCardProps {
  subId: string;
  subName: string;
  packets: Packet[];
  sendingPacket: boolean;
  packetSendError: string | null;
  packetSendOk: boolean;
  onSendPacket: () => void;
  onReviewPacket: (p: Packet) => void;
}

function OnboardingCard({
  packets,
  sendingPacket,
  packetSendError,
  packetSendOk,
  onSendPacket,
  onReviewPacket,
}: OnboardingCardProps) {
  const latest = packets[0] ?? null;
  const isReviewable = latest &&
    ["submitted", "approved", "awaiting_signature", "signed"].includes(latest.status);

  const [sendingAgreement, setSendingAgreement] = useState(false);
  const [agreementError, setAgreementError] = useState<string | null>(null);
  const [agreementSent, setAgreementSent] = useState(false);

  async function handleSendAgreement() {
    if (!latest) return;
    setSendingAgreement(true);
    setAgreementError(null);
    setAgreementSent(false);
    try {
      const res = await fetch(`/api/packets/${latest.id}/send-agreement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (data as { details?: string; error?: string })?.details ??
          (data as { error?: string })?.error ??
          "Failed to send agreement"
        );
      }
      setAgreementSent(true);
    } catch (e) {
      setAgreementError((e as Error).message || "Failed to send agreement.");
    } finally {
      setSendingAgreement(false);
    }
  }

  return (
    <Card
      title="Onboarding Packet"
      actions={
        <Button size="sm" variant="secondary" onClick={onSendPacket} disabled={sendingPacket}>
          {sendingPacket ? "Sending…" : "Send New Packet"}
        </Button>
      }
    >
      {packetSendOk && (
        <p class="text--success" style={{ fontSize: "var(--text-sm)", marginBottom: "var(--space-sm)" }}>
          Packet link sent via SMS + email.
        </p>
      )}
      {packetSendError && (
        <p class="text--danger" style={{ fontSize: "var(--text-sm)", marginBottom: "var(--space-sm)" }}>
          {packetSendError}
        </p>
      )}

      {!latest && (
        <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: 0 }}>
          No packet sent yet. Click "Send New Packet" to email and SMS the sub a secure link.
        </p>
      )}

      {latest && (
        <div class="kv">
          <div class="kv__row">
            <span class="kv__label">Status</span>
            <span class="kv__value">
              <Badge tone={PACKET_STATUS_TONES[latest.status]}>
                {PACKET_STATUS_LABELS[latest.status] ?? latest.status}
              </Badge>
            </span>
          </div>
          {latest.submitted_at && (
            <div class="kv__row">
              <span class="kv__label">Submitted</span>
              <span class="kv__value">{formatDate(latest.submitted_at)}</span>
            </div>
          )}
          {latest.approved_at && (
            <div class="kv__row">
              <span class="kv__label">Docs approved</span>
              <span class="kv__value">{formatDate(latest.approved_at)}</span>
            </div>
          )}
          {latest.signed_at && (
            <div class="kv__row">
              <span class="kv__label">Agreement signed</span>
              <span class="kv__value">{formatDate(latest.signed_at)}</span>
            </div>
          )}
          {isReviewable && (
            <div style={{ marginTop: "var(--space-sm)", display: "flex", flexDirection: "column", gap: "var(--space-xs)" }}>
              <div style={{ display: "flex", gap: "var(--space-xs)", flexWrap: "wrap", alignItems: "center" }}>
                <Button size="sm" variant="primary" onClick={() => onReviewPacket(latest)}>
                  {latest.status === "submitted" ? "Review & Approve" : "View Packet"}
                </Button>
                {latest.status === "approved" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={sendingAgreement}
                    onClick={handleSendAgreement}
                  >
                    {sendingAgreement ? "Sending…" : "Send Agreement for Signature"}
                  </Button>
                )}
              </div>
              {agreementSent && (
                <p class="text--success" style={{ fontSize: "var(--text-xs)", margin: 0 }}>
                  Agreement sent — check BoldSign for the envelope.
                </p>
              )}
              {agreementError && (
                <p class="text--danger" style={{ fontSize: "var(--text-xs)", margin: 0 }}>
                  {agreementError}
                </p>
              )}
            </div>
          )}
          {packets.length > 1 && (
            <p class="text--muted" style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-sm)" }}>
              {packets.length - 1} older packet{packets.length > 2 ? "s" : ""} on file.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Owner-only: manual compliance check trigger ───────────────────────────────
interface ComplianceCheckResponse {
  ok: boolean;
  alerted: boolean;
  sub?: string;
  alerts?: string[];
  sent_to?: string | null;
  reason?: string;
  fields?: Array<{ field: string; expiration_date: string; days_until: number }>;
}

function ComplianceCheckButton({ subId }: { subId: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const fire = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.post<ComplianceCheckResponse>(
        `/api/subcontractors/${subId}/test-compliance-check`,
        {},
      );
      if (res.alerted) {
        toast.push("success", `Compliance reminder sent to ${res.sent_to ?? "owner"}. ${(res.alerts ?? []).join("; ")}`);
      } else {
        toast.push("info", `No reminder needed — ${res.sub ?? "sub"} has no expirations within 31 days.`);
      }
    } catch (err) {
      toast.push("error", err instanceof ApiError ? err.message : "Compliance check failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="primary"
      size="sm"
      onClick={() => void fire()}
      disabled={busy}
      title="Owner only — manually runs the compliance expiration check for this sub"
    >
      {busy ? "Checking…" : "Check Compliance"}
    </Button>
  );
}

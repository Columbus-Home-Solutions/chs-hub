import { useEffect, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { useApi } from "../../hooks/useApi";
import { go } from "../../lib/nav";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatStatus } from "../../lib/format";
import { DocViewerModal } from "../../components/DocViewerModal";

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

const CATEGORIES = [
  "contract", "change_order", "permit", "plan_drawing", "receipt", "invoice",
  "lien_waiver", "insurance", "license", "sop", "photo_report", "completion_package", "other",
];
const WAIVER_TYPES = ["conditional", "unconditional", "partial", "final"];

function fmtSize(n: number | null | undefined): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

interface DocItem {
  id: string;
  title: string;
  file_type?: string | null;
  file_size?: number | null;
  document_category: string;
  is_signed?: number | null;
  mirror_status?: string | null;
  share_token?: string | null;
  source?: string;
  created_at: string;
}

// ─── Job-profile Documents tab (Sprint 15 + 19) ────────────────────────────────
export function DocumentsTab({ jobId }: { jobId: string }) {
  return (
    <div class="stack">
      <CompletionPackageCard jobId={jobId} />
      <GeneratedDocuments jobId={jobId} />
      <JobDocuments jobId={jobId} />
      <LienWaivers jobId={jobId} />
    </div>
  );
}

// ─── Sprint 19: Generated Documents (.docx auto-fill) ─────────────────────────

type TemplateType =
  | "service_agreement"
  | "cost_plus_agreement"
  | "change_order"
  | "lien_waiver_conditional"
  | "lien_waiver_sub_unconditional"
  | "warranty_certificate";

interface GeneratedDoc {
  id: string;
  job_id: string;
  template_type: string;
  filename: string;
  r2_key: string;
  generated_at: string;
  generated_by: string | null;
  notes: string | null;
  review_status: string | null;
  auto_generated: number | null;
  trigger_event: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  // Sprint 21 e-signature fields
  signature_status: string | null;
  boldsign_document_id: string | null;
  signature_sent_at: string | null;
  signature_completed_at: string | null;
  signed_r2_key: string | null;
  signer_email: string | null;
  signer_name: string | null;
}

const TEMPLATE_LABELS: Record<TemplateType, string> = {
  service_agreement: "Service Agreement",
  cost_plus_agreement: "Cost-Plus Billing Agreement",
  change_order: "Change Order",
  lien_waiver_conditional: "Conditional Lien Waiver (Client)",
  lien_waiver_sub_unconditional: "Unconditional Lien Waiver (Sub)",
  warranty_certificate: "Warranty Certificate",
};

const ALL_TYPES = Object.keys(TEMPLATE_LABELS) as TemplateType[];

function fmtDateTime(s: string) {
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(s + "Z"));
  } catch {
    return s;
  }
}

const REVIEW_STATUS_BADGE: Record<string, { label: string; tone: "warning" | "success" | "neutral" | "error" }> = {
  pending_review: { label: "Pending Review", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  manual: { label: "Manual", tone: "neutral" },
  discarded: { label: "Discarded", tone: "error" },
};

const SIG_STATUS_BADGE: Record<string, { label: string; tone: "warning" | "success" | "neutral" | "error" | "info" }> = {
  none: { label: "Not sent", tone: "neutral" },
  sent: { label: "Sent", tone: "info" },
  viewed: { label: "Viewed", tone: "info" },
  signed: { label: "Signed", tone: "success" },
  completed: { label: "Completed", tone: "success" },
  declined: { label: "Declined", tone: "error" },
  expired: { label: "Expired", tone: "error" },
  revoked: { label: "Revoked", tone: "error" },
  failed: { label: "Failed", tone: "error" },
};

function GeneratedDocuments({ jobId }: { jobId: string }) {
  const toast = useToast();
  const [docs, setDocs] = useState<GeneratedDoc[] | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [acting, setActing] = useState<Record<string, "approve" | "discard" | "remind" | "revoke">>({});
  const [viewing, setViewing] = useState<GeneratedDoc | null>(null);
  const [sending, setSending] = useState<GeneratedDoc | null>(null);

  const load = async () => {
    try {
      const r = await api.get<{ documents: GeneratedDoc[] }>(`/api/jobs/${jobId}/generated-documents`);
      setDocs(r.documents ?? []);
    } catch {
      setDocs([]);
    }
  };

  useEffect(() => { void load(); }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (doc: GeneratedDoc) => {
    if (!confirm(`Delete record for "${doc.filename}"? The file in R2 is retained.`)) return;
    try {
      await api.del(`/api/jobs/${jobId}/generated-documents/${doc.id}`);
      toast.push("success", "Document record removed.");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  const approveDoc = async (doc: GeneratedDoc) => {
    setActing((p) => ({ ...p, [doc.id]: "approve" }));
    try {
      await api.post(`/api/jobs/${jobId}/generated-documents/${doc.id}/approve`, {});
      toast.push("success", "Document approved.");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setActing((p) => { const n = { ...p }; delete n[doc.id]; return n; });
    }
  };

  const discardDoc = async (doc: GeneratedDoc) => {
    setActing((p) => ({ ...p, [doc.id]: "discard" }));
    try {
      await api.post(`/api/jobs/${jobId}/generated-documents/${doc.id}/discard`, {});
      toast.push("success", "Document discarded.");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setActing((p) => { const n = { ...p }; delete n[doc.id]; return n; });
    }
  };

  const remindDoc = async (doc: GeneratedDoc) => {
    setActing((p) => ({ ...p, [doc.id]: "remind" }));
    try {
      await api.post(`/api/jobs/${jobId}/generated-documents/${doc.id}/remind`, {});
      toast.push("success", "Reminder sent to signer.");
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setActing((p) => { const n = { ...p }; delete n[doc.id]; return n; });
    }
  };

  const revokeDoc = async (doc: GeneratedDoc) => {
    if (!confirm(`Revoke the signature request for "${doc.filename}"? The signer will no longer be able to sign.`)) return;
    setActing((p) => ({ ...p, [doc.id]: "revoke" }));
    try {
      await api.post(`/api/jobs/${jobId}/generated-documents/${doc.id}/revoke`, {});
      toast.push("success", "Signature request revoked.");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setActing((p) => { const n = { ...p }; delete n[doc.id]; return n; });
    }
  };

  const allDocs = docs ?? [];
  const hasDiscarded = allDocs.some((d) => d.review_status === "discarded");
  const visibleDocs = showDiscarded ? allDocs : allDocs.filter((d) => d.review_status !== "discarded");

  return (
    <Card
      title="Generated Documents"
      actions={
        <div class="flex gap-sm">
          {hasDiscarded && (
            <Button size="sm" variant="tertiary" onClick={() => setShowDiscarded((v) => !v)}>
              {showDiscarded ? "Hide discarded" : "Show discarded"}
            </Button>
          )}
          <Button size="sm" variant="primary" onClick={() => setShowModal(true)}>
            + Generate Document
          </Button>
        </div>
      }
    >
      {!docs ? (
        <Spinner center />
      ) : visibleDocs.length === 0 ? (
        <div class="empty-state">No documents generated yet. Click Generate Document to create your first one.</div>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Filename</th>
              <th>Review</th>
              <th>Signature</th>
              <th>Generated</th>
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleDocs.map((d) => {
              const statusKey = d.review_status ?? "manual";
              const badge = REVIEW_STATUS_BADGE[statusKey] ?? { label: statusKey, tone: "neutral" as const };
              const sigKey = d.signature_status ?? "none";
              const sigBadge = SIG_STATUS_BADGE[sigKey] ?? { label: sigKey, tone: "neutral" as const };
              const isDiscarded = statusKey === "discarded";
              const isPending = statusKey === "pending_review";
              const isApproved = statusKey === "approved";
              // Manual docs (user-generated on demand) skip the review queue
              // and can be sent for signature directly.
              const canSendSig = isApproved || statusKey === "manual";
              const sigNone = sigKey === "none";
              const sigActive = ["sent", "viewed"].includes(sigKey);
              const sigCompleted = sigKey === "completed";
              const sigFailed = ["declined", "expired", "failed"].includes(sigKey);
              const busy = d.id in acting;
              return (
                <tr key={d.id} style={isDiscarded ? { opacity: 0.45 } : undefined}>
                  <td style={isDiscarded ? { textDecoration: "line-through" } : undefined}>
                    {TEMPLATE_LABELS[d.template_type as TemplateType] ?? d.template_type}
                  </td>
                  <td style={{ fontFamily: "monospace", fontSize: "var(--text-xs)" }}>{d.filename}</td>
                  <td>
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                  </td>
                  <td>
                    <div class="flex gap-xs items-center" style={{ flexWrap: "wrap" }}>
                      <Badge tone={sigBadge.tone as "warning" | "success" | "neutral" | "error"}>{sigBadge.label}</Badge>
                      {d.signer_email && sigKey !== "none" && (
                        <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                          → {d.signer_name ?? d.signer_email}
                        </span>
                      )}
                      {sigCompleted && d.signature_completed_at && (
                        <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                          {fmtDateTime(d.signature_completed_at)}
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtDateTime(d.generated_at)}</td>
                  <td style={{ textAlign: "right" }}>
                    <div class="flex gap-sm" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
                      <Button size="sm" variant="secondary" onClick={() => setViewing(d)}>View</Button>
                      {isPending && (
                        <>
                          <Button size="sm" variant="primary" disabled={busy} onClick={() => void approveDoc(d)}>
                            {acting[d.id] === "approve" ? "…" : "Approve"}
                          </Button>
                          <Button size="sm" variant="tertiary" disabled={busy} onClick={() => void discardDoc(d)}>
                            {acting[d.id] === "discard" ? "…" : "Discard"}
                          </Button>
                        </>
                      )}
                      {canSendSig && sigNone && (
                        <Button size="sm" variant="primary" onClick={() => setSending(d)}>
                          Send for Signature
                        </Button>
                      )}
                      {sigActive && (
                        <Button size="sm" variant="tertiary" disabled={busy} onClick={() => void remindDoc(d)}>
                          {acting[d.id] === "remind" ? "…" : "Remind"}
                        </Button>
                      )}
                      {sigActive && (
                        <Button size="sm" variant="danger" disabled={busy} onClick={() => void revokeDoc(d)}>
                          {acting[d.id] === "revoke" ? "…" : "Revoke"}
                        </Button>
                      )}
                      {(sigFailed || sigKey === "revoked" || sigKey === "declined") && canSendSig && (
                        <Button size="sm" variant="secondary" onClick={() => setSending(d)}>
                          Send again
                        </Button>
                      )}
                      {sigCompleted && d.signed_r2_key && (
                        <a href={`/api/jobs/${jobId}/generated-documents/${d.id}/signed-pdf`} download>
                          <Button size="sm" variant="secondary">Download signed PDF</Button>
                        </a>
                      )}
                      <Button size="sm" variant="danger" onClick={() => void remove(d)}>Delete</Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {showModal && (
        <GenerateDocumentModal
          jobId={jobId}
          onClose={() => setShowModal(false)}
          onGenerated={() => {
            setShowModal(false);
            void load();
          }}
        />
      )}

      {viewing && (
        <DocViewerModal
          jobId={jobId}
          docId={viewing.id}
          filename={viewing.filename}
          downloadPath={`/api/jobs/${jobId}/documents/${viewing.id}/download`}
          onClose={() => setViewing(null)}
        />
      )}

      {sending && (
        <SendSignatureModal
          jobId={jobId}
          doc={sending}
          onClose={() => setSending(null)}
          onSent={() => {
            setSending(null);
            void load();
          }}
        />
      )}
    </Card>
  );
}

// ─── Sprint 21: Send for Signature modal ──────────────────────────────────────

function SendSignatureModal({
  jobId,
  doc,
  onClose,
  onSent,
}: {
  jobId: string;
  doc: GeneratedDoc;
  onClose: () => void;
  onSent: () => void;
}) {
  const toast = useToast();
  const [signerEmail, setSignerEmail] = useState(doc.signer_email ?? "");
  const [signerName, setSignerName] = useState(doc.signer_name ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"sandbox" | "live" | null>(null);

  // Resolve signer defaults from job client if not pre-filled.
  useEffect(() => {
    if (!signerEmail || !signerName) {
      api.get<{ client_name: string; client_email: string }>(`/api/jobs/${jobId}/doc-preview`)
        .then((r) => {
          if (!signerName && r.client_name) setSignerName(r.client_name);
          if (!signerEmail && r.client_email) setSignerEmail(r.client_email);
        })
        .catch(() => undefined);
    }
    // Load esignature mode for sandbox badge.
    api.get<{ mode: "sandbox" | "live" }>("/api/esignature/status")
      .then((r) => setMode(r.mode))
      .catch(() => setMode("sandbox"));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    if (!signerEmail.trim()) {
      toast.push("error", "Signer email is required.");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/jobs/${jobId}/generated-documents/${doc.id}/send-for-signature`, {
        signer_email: signerEmail.trim(),
        signer_name: signerName.trim(),
        message: message.trim() || undefined,
      });
      toast.push("success", "Document sent for signature.");
      onSent();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const label = TEMPLATE_LABELS[doc.template_type as TemplateType] ?? doc.template_type;

  return (
    <Modal
      open
      title={`Send for Signature — ${label}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !signerEmail.trim()} onClick={send}>
            {busy ? "Sending…" : "Send"}
          </Button>
        </>
      }
    >
      {mode === "sandbox" && (
        <div style={{
          background: "var(--color-warning-light, #fff3cd)",
          border: "2px solid var(--color-warning, #f59e0b)",
          borderRadius: "var(--radius-sm)",
          padding: "var(--space-sm) var(--space-md)",
          marginBottom: "var(--space-md)",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-sm)",
          fontWeight: 600,
          color: "var(--color-warning-dark, #92400e)",
        }}>
          <span>⚠️</span>
          <span>SANDBOX MODE — not legally binding. Watermarked test document.</span>
        </div>
      )}

      <FormField label="Signer Email" required>
        <input
          class="form-input"
          type="email"
          value={signerEmail}
          onInput={(e) => setSignerEmail((e.target as HTMLInputElement).value)}
          placeholder="client@example.com"
        />
      </FormField>

      <FormField label="Signer Name">
        <input
          class="form-input"
          value={signerName}
          onInput={(e) => setSignerName((e.target as HTMLInputElement).value)}
          placeholder="Jane Maxwell"
        />
      </FormField>

      <FormField label="Message to signer (optional)">
        <textarea
          class="form-input"
          rows={3}
          value={message}
          onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)}
          placeholder="Please review and sign this document at your earliest convenience."
        />
      </FormField>

      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginTop: "var(--space-sm)" }}>
        Document: <span style={{ fontFamily: "monospace" }}>{doc.filename}</span>
      </div>
    </Modal>
  );
}

interface JobPreview {
  job_number: string;
  title: string;
  client_name: string;
  job_address: string;
  contract_amount: string;
}

function GenerateDocumentModal({
  jobId,
  onClose,
  onGenerated,
}: {
  jobId: string;
  onClose: () => void;
  onGenerated: () => void;
}) {
  const toast = useToast();
  const [templateType, setTemplateType] = useState<TemplateType>("service_agreement");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<JobPreview | null>(null);

  // Conditional override fields
  const [coNumber, setCoNumber] = useState("");
  const [coDesc, setCoDesc] = useState("");
  const [coOrigAmount, setCoOrigAmount] = useState("");
  const [coNetChange, setCoNetChange] = useState("");
  const [coRevisedTotal, setCoRevisedTotal] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState("");
  const [throughDate, setThroughDate] = useState("");
  const [subId, setSubId] = useState("");
  const [subCompany, setSubCompany] = useState("");
  const [workDesc, setWorkDesc] = useState("");

  useEffect(() => {
    api.get<JobPreview>(`/api/jobs/${jobId}/doc-preview`).catch(() => null).then((r) => {
      if (r) setPreview(r);
    });
  }, [jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  const buildOverrides = (): Record<string, string> => {
    const o: Record<string, string> = {};
    if (templateType === "change_order") {
      if (coNumber) o.change_order_number = coNumber;
      if (coDesc) o.change_description = coDesc;
      if (coOrigAmount) o.original_contract_amount = coOrigAmount;
      if (coNetChange) o.net_change = coNetChange;
      if (coRevisedTotal) o.revised_total = coRevisedTotal;
    }
    if (templateType === "lien_waiver_conditional" || templateType === "lien_waiver_sub_unconditional") {
      if (payAmount) o.payment_amount = payAmount;
      if (payDate) o.payment_date = payDate;
    }
    if (templateType === "lien_waiver_conditional") {
      if (throughDate) o.through_date = throughDate;
    }
    if (templateType === "lien_waiver_sub_unconditional") {
      if (subId) o.sub_id = subId;
      if (subCompany) o.sub_company_name = subCompany;
    }
    if (templateType === "warranty_certificate") {
      if (workDesc) o.work_description = workDesc;
    }
    return o;
  };

  const generate = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.post(`/api/jobs/${jobId}/documents/generate`, {
        template_type: templateType,
        overrides: buildOverrides(),
      });
      toast.push("success", "Document generated — click Download to save.");
      onGenerated();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Generate Document"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={generate}>{busy ? "Generating…" : "Generate"}</Button>
        </>
      }
    >
      <FormField label="Document Type" required>
        <Select
          value={templateType}
          options={ALL_TYPES.map((t) => ({ value: t, label: TEMPLATE_LABELS[t] }))}
          onChange={(v) => setTemplateType(v as TemplateType)}
        />
      </FormField>

      {/* Conditional fields — Change Order */}
      {templateType === "change_order" && (
        <>
          <FormField label="Change Order #" required>
            <input class="form-input" value={coNumber} onInput={(e) => setCoNumber((e.target as HTMLInputElement).value)} placeholder="e.g. 001" />
          </FormField>
          <FormField label="Description of Change" required>
            <textarea class="form-input" rows={3} value={coDesc} onInput={(e) => setCoDesc((e.target as HTMLTextAreaElement).value)} placeholder="Describe the change…" />
          </FormField>
          <FormField label="Original Contract Amount">
            <input class="form-input" type="number" step="0.01" value={coOrigAmount} onInput={(e) => setCoOrigAmount((e.target as HTMLInputElement).value)} placeholder="Auto-resolved if blank" />
          </FormField>
          <FormField label="Net Change ($)">
            <input class="form-input" type="number" step="0.01" value={coNetChange} onInput={(e) => setCoNetChange((e.target as HTMLInputElement).value)} />
          </FormField>
          <FormField label="Revised Total ($)">
            <input class="form-input" type="number" step="0.01" value={coRevisedTotal} onInput={(e) => setCoRevisedTotal((e.target as HTMLInputElement).value)} />
          </FormField>
        </>
      )}

      {/* Conditional fields — Lien Waivers */}
      {(templateType === "lien_waiver_conditional" || templateType === "lien_waiver_sub_unconditional") && (
        <>
          <FormField label="Payment Amount ($)" required>
            <input class="form-input" type="number" step="0.01" value={payAmount} onInput={(e) => setPayAmount((e.target as HTMLInputElement).value)} />
          </FormField>
          <FormField label="Payment Date" required>
            <input class="form-input" type="date" value={payDate} onInput={(e) => setPayDate((e.target as HTMLInputElement).value)} />
          </FormField>
        </>
      )}

      {/* Conditional fields — Conditional Lien Waiver only */}
      {templateType === "lien_waiver_conditional" && (
        <FormField label="Through Date (lien covers work through)" required>
          <input class="form-input" type="date" value={throughDate} onInput={(e) => setThroughDate((e.target as HTMLInputElement).value)} />
        </FormField>
      )}

      {/* Conditional fields — Sub Lien Waiver */}
      {templateType === "lien_waiver_sub_unconditional" && (
        <>
          <FormField label="Subcontractor Company Name" required>
            <input class="form-input" value={subCompany} onInput={(e) => setSubCompany((e.target as HTMLInputElement).value)} placeholder="Company name" />
          </FormField>
          <FormField label="Subcontractor ID (optional — auto-fills name/trade)">
            <input class="form-input" value={subId} onInput={(e) => setSubId((e.target as HTMLInputElement).value)} placeholder="Sub ID from subcontractors table" />
          </FormField>
        </>
      )}

      {/* Conditional fields — Warranty Certificate */}
      {templateType === "warranty_certificate" && (
        <FormField label="Work Description (defaults to job scope/title)">
          <textarea class="form-input" rows={2} value={workDesc} onInput={(e) => setWorkDesc((e.target as HTMLTextAreaElement).value)} placeholder="Leave blank to use job title/notes" />
        </FormField>
      )}

      {/* Pre-fill preview */}
      {preview && (
        <div style={{ marginTop: "var(--space-md)", padding: "var(--space-sm)", background: "var(--surface-2)", borderRadius: "var(--radius-sm)" }}>
          <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: "var(--space-xs)" }}>
            Pre-fill Preview
          </div>
          <table style={{ width: "100%", fontSize: "var(--text-sm)", borderCollapse: "collapse" }}>
            <tbody>
              <tr><td style={{ color: "var(--text-muted)", paddingRight: "var(--space-sm)" }}>Job #</td><td>{preview.job_number}</td></tr>
              <tr><td style={{ color: "var(--text-muted)", paddingRight: "var(--space-sm)" }}>Job Name</td><td>{preview.title}</td></tr>
              <tr><td style={{ color: "var(--text-muted)", paddingRight: "var(--space-sm)" }}>Client</td><td>{preview.client_name || "—"}</td></tr>
              <tr><td style={{ color: "var(--text-muted)", paddingRight: "var(--space-sm)" }}>Property</td><td>{preview.job_address || "—"}</td></tr>
              <tr><td style={{ color: "var(--text-muted)", paddingRight: "var(--space-sm)" }}>Contract Amount</td><td>{preview.contract_amount || "—"}</td></tr>
              <tr><td style={{ color: "var(--text-muted)", paddingRight: "var(--space-sm)" }}>Contract Date</td><td>{new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(new Date())}</td></tr>
            </tbody>
          </table>
        </div>
      )}

      {error && (
        <div class="form-error" style={{ marginTop: "var(--space-sm)", color: "var(--color-error)" }}>
          {error}
        </div>
      )}
    </Modal>
  );
}

// ─── 1. Documents (grouped) + upload ───────────────────────────────────────────
function JobDocuments({ jobId }: { jobId: string }) {
  const toast = useToast();
  const [groups, setGroups] = useState<Record<string, DocItem[]> | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = async () => {
    setGroups(null);
    try {
      const r = await api.get<{ groups: Record<string, DocItem[]> }>(`/api/jobs/${jobId}/documents`);
      setGroups(r.groups ?? {});
    } catch (e) {
      toast.push("error", errMsg(e));
      setGroups({});
    }
  };
  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener("chs:docs-changed", onChanged);
    return () => window.removeEventListener("chs:docs-changed", onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const share = async (d: DocItem) => {
    try {
      const r = await api.post<{ share_url: string }>(`/api/documents/${d.id}/share`, {});
      await navigator.clipboard?.writeText(r.share_url).catch(() => undefined);
      toast.push("success", `Share link copied (7-day): ${r.share_url}`);
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };
  const remove = async (d: DocItem) => {
    try {
      await api.del(`/api/documents/${d.id}`);
      toast.push("success", "Document removed (file retained)");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  const cats = groups ? Object.keys(groups).sort() : [];

  return (
    <Card
      title="Documents"
      actions={
        <Button size="sm" variant="primary" onClick={() => setUploading(true)}>
          + Upload
        </Button>
      }
    >
      {!groups ? (
        <Spinner center />
      ) : cats.length === 0 ? (
        <div class="empty-state">No documents for this job yet.</div>
      ) : (
        cats.map((cat) => (
          <div key={cat} class="mt-md">
            <div class="text--muted" style={{ fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: "var(--space-xs)" }}>
              {formatStatus(cat)} ({groups[cat].length})
            </div>
            <table class="table">
              <tbody>
                {groups[cat].map((d) => (
                  <tr key={d.id}>
                    <td>
                      {d.source === "photo" ? (
                        d.title
                      ) : (
                        <a href={`/api/documents/${d.id}/file`} target="_blank" rel="noreferrer">{d.title}</a>
                      )}
                      {d.is_signed ? (
                        <Badge tone="success">Signed</Badge>
                      ) : d.document_category === "working_agreement" ? (
                        <Badge tone="neutral">Reference</Badge>
                      ) : null}
                    </td>
                    <td style={{ width: "90px" }}>{fmtSize(d.file_size)}</td>
                    <td style={{ width: "110px" }}>
                      {d.mirror_status ? (
                        <Badge tone={d.mirror_status === "synced" ? "success" : d.mirror_status === "failed" ? "error" : "neutral"}>
                          {d.mirror_status}
                        </Badge>
                      ) : "—"}
                    </td>
                    <td style={{ width: "150px", textAlign: "right" }}>
                      {d.source === "photo" ? null : (
                        <div class="flex gap-sm" style={{ justifyContent: "flex-end" }}>
                          <Button size="sm" variant="secondary" onClick={() => void share(d)}>Share</Button>
                          <Button size="sm" variant="danger" onClick={() => void remove(d)}>Delete</Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      {uploading && (
        <JobUploadModal
          jobId={jobId}
          onClose={() => setUploading(false)}
          onUploaded={() => {
            setUploading(false);
            void load();
          }}
        />
      )}
    </Card>
  );
}

function JobUploadModal({ jobId, onClose, onUploaded }: { jobId: string; onClose: () => void; onUploaded: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("other");
  const [busy, setBusy] = useState(false);

  const upload = async () => {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      toast.push("error", "Files are capped at 50 MB.");
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      if (title.trim()) fd.set("title", title.trim());
      fd.set("document_category", category);
      fd.set("job_id", jobId);
      const res = await fetch("/api/documents", { method: "POST", body: fd });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as { error?: string }).error ?? `Upload failed: ${res.status}`);
      }
      toast.push("success", "Document uploaded");
      onUploaded();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Upload document to this job"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!file || busy} onClick={upload}>{busy ? "Uploading…" : "Upload"}</Button>
        </>
      }
    >
      <FormField label="File" required>
        <input class="form-input" type="file" onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
      </FormField>
      <FormField label="Title (defaults to filename)">
        <input class="form-input" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      </FormField>
      <FormField label="Category">
        <Select value={category} options={CATEGORIES.map((c) => ({ value: c, label: formatStatus(c) }))} onChange={setCategory} />
      </FormField>
    </Modal>
  );
}

// ─── 3. Lien waivers ───────────────────────────────────────────────────────────
interface WaiverRow {
  id: string; sub_id: string; sub_name: string | null; waiver_type: string;
  payment_amount: number; status: string; document_id: string | null;
}
interface SubOption { id: string; company_name: string | null; contact_name: string | null; }

function LienWaivers({ jobId }: { jobId: string }) {
  const toast = useToast();
  const [rows, setRows] = useState<WaiverRow[] | null>(null);
  const [subs, setSubs] = useState<SubOption[]>([]);
  const [subId, setSubId] = useState("");
  const [waiverType, setWaiverType] = useState("conditional");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await api.get<{ lien_waivers: WaiverRow[] }>(`/api/jobs/${jobId}/lien-waivers`);
      setRows(r.lien_waivers ?? []);
    } catch (e) {
      toast.push("error", errMsg(e));
      setRows([]);
    }
  };
  useEffect(() => {
    void load();
    api
      .get<{ subcontractors: SubOption[] }>("/api/subcontractors?active=1")
      .then((r) => {
        setSubs(r.subcontractors ?? []);
        if (r.subcontractors?.[0]) setSubId(r.subcontractors[0].id);
      })
      .catch(() => setSubs([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const create = async () => {
    const amt = Number(amount);
    if (!subId) return toast.push("error", "Pick a subcontractor.");
    if (!Number.isFinite(amt)) return toast.push("error", "Enter a valid payment amount.");
    setBusy(true);
    try {
      await api.post(`/api/lien-waivers`, { job_id: jobId, sub_id: subId, waiver_type: waiverType, payment_amount: amt });
      toast.push("success", "Lien waiver request created");
      setAmount("");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const generate = async (w: WaiverRow) => {
    try {
      const r = await api.post<{ document_id: string }>(`/api/lien-waivers/${w.id}/generate`, {});
      toast.push("success", `Waiver document generated (${r.document_id.slice(0, 8)}). See Documents → Lien Waiver.`);
      void load();
      window.dispatchEvent(new CustomEvent("chs:docs-changed"));
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  const subLabel = (s: SubOption) => s.company_name ?? s.contact_name ?? s.id.slice(0, 8);

  return (
    <Card title="Lien waivers">
      <div class="form-row form-row--align-end">
        <FormField label="Subcontractor">
          <Select value={subId} options={subs.map((s) => ({ value: s.id, label: subLabel(s) }))} onChange={setSubId} />
        </FormField>
        <FormField label="Type">
          <Select value={waiverType} options={WAIVER_TYPES.map((t) => ({ value: t, label: formatStatus(t) }))} onChange={setWaiverType} />
        </FormField>
        <FormField label="Payment amount">
          <input class="form-input" type="number" step="0.01" value={amount} placeholder="0.00" onInput={(e) => setAmount((e.target as HTMLInputElement).value)} />
        </FormField>
        <div class="form-row__action">
          <Button variant="primary" disabled={busy || subs.length === 0} onClick={create}>Create request</Button>
        </div>
      </div>

      {!rows ? (
        <Spinner center />
      ) : rows.length === 0 ? (
        <div class="empty-state mt-md">No lien waivers yet.</div>
      ) : (
        <table class="table mt-md">
          <thead>
            <tr><th>Subcontractor</th><th>Type</th><th>Amount</th><th>Status</th><th>Document</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.id}>
                <td>{w.sub_name ?? "—"}</td>
                <td>{formatStatus(w.waiver_type)}</td>
                <td>{usd(w.payment_amount)}</td>
                <td><Badge tone={w.status === "filed" ? "success" : w.status === "received" ? "info" : "neutral"}>{formatStatus(w.status)}</Badge></td>
                <td>{w.document_id ? <a href={`/api/documents/${w.document_id}/file`} target="_blank" rel="noreferrer">View</a> : "—"}</td>
                <td style={{ textAlign: "right" }}>
                  {!w.document_id && <Button size="sm" variant="secondary" onClick={() => void generate(w)}>Generate document</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ─── Completion package card (Sprint 32) ───────────────────────────────────────

interface CompletionPackageSummary {
  package_status: "not_ready" | "ready_to_send" | "sent";
  sent_at: string | null;
  lien_waiver: { status: string };
}

function packageStatusLabel(status: CompletionPackageSummary["package_status"]): string {
  if (status === "sent") return "Sent";
  if (status === "ready_to_send") return "Ready to send";
  return "In progress";
}

function CompletionPackageCard({ jobId }: { jobId: string }) {
  const job = useApi<{ job: { status: string } }>(`/api/jobs/${jobId}`);
  const pkg = useApi<CompletionPackageSummary>(`/api/jobs/${jobId}/completion-package`);

  const jobStatus = job.data?.job.status;
  const summary = pkg.data;
  const show =
    jobStatus === "complete" ||
    summary?.package_status !== "not_ready" ||
    (summary?.lien_waiver?.status && summary.lien_waiver.status !== "missing");

  if (!show) return null;
  if (pkg.loading && !summary) {
    return (
      <Card title="📦 Completion Package">
        <Spinner center />
      </Card>
    );
  }

  const status = summary?.package_status ?? "not_ready";
  const tone = status === "sent" ? "success" : status === "ready_to_send" ? "info" : "warning";

  return (
    <Card title="📦 Completion Package">
      <div class="flex items-center justify-between gap-sm" style={{ flexWrap: "wrap" }}>
        <div class="flex items-center gap-sm">
          <Badge tone={tone}>{packageStatusLabel(status)}</Badge>
          {summary?.sent_at && (
            <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
              {new Date(summary.sent_at).toLocaleString()}
            </span>
          )}
        </div>
        <Button size="sm" variant="primary" onClick={() => go(`/jobs/${jobId}/completion-package`)}>
          Review →
        </Button>
      </div>
    </Card>
  );
}

// ─── 4. Legacy completion package compile (removed from tab — use review screen) ─

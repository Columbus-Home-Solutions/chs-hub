/**
 * PacketReviewModal — Sprint 39 Run 1.
 *
 * Owner-facing modal for reviewing and approving a submitted subcontractor
 * onboarding packet. Shows all uploaded documents (downloadable links), expiration
 * dates, workers' comp exemption status, and an "Approve" button that copies
 * submitted values into the real subcontractors row.
 *
 * Usage:
 *   <PacketReviewModal
 *     packet={packetObject}
 *     subName="John's Plumbing"
 *     onClose={() => ...}
 *     onApproved={() => ...}
 *   />
 */

import { useState } from "preact/hooks";

// ── types ──────────────────────────────────────────────────────────────────

interface PacketDoc {
  id: string;
  document_type: string;
  document_id: string | null;
  file_type: string | null;
  expiration_date: string | null;
  captured_tax_id: string | null;
  captured_license_number: string | null;
  uploaded_at: string;
}

export interface Packet {
  id: string;
  sub_id: string;
  status: string;
  workers_comp_exempt: boolean;
  workers_comp_exemption_reason: string | null;
  sent_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  signed_at: string | null;
  agreement_document_id: string | null;
  documents: PacketDoc[];
}

interface Props {
  packet: Packet;
  subName: string;
  onClose: () => void;
  onApproved: () => void;
  /** True when system_settings.subcontractor_agreement_template_id is not set */
  agreementTemplateConfigured?: boolean;
}

// ── helpers ────────────────────────────────────────────────────────────────

const DOC_LABELS: Record<string, string> = {
  w9: "W-9",
  coi_general_liability: "GL Certificate of Insurance",
  coi_workers_comp: "WC Certificate of Insurance",
  license: "Contractor / Business License",
};

function docLabel(type: string): string {
  return DOC_LABELS[type] ?? type;
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// ── Component ──────────────────────────────────────────────────────────────

export function PacketReviewModal({ packet, subName, onClose, onApproved, agreementTemplateConfigured = true }: Props) {
  const [approving, setApproving] = useState(false);
  const [sendingAgreement, setSendingAgreement] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const docsByType: Record<string, PacketDoc> = {};
  for (const d of packet.documents) docsByType[d.document_type] = d;

  const w9Doc = docsByType["w9"] ?? null;
  const glDoc = docsByType["coi_general_liability"] ?? null;
  const wcDoc = docsByType["coi_workers_comp"] ?? null;
  const licDoc = docsByType["license"] ?? null;

  async function handleApprove() {
    setApproving(true);
    setError(null);
    try {
      const res = await fetch(`/api/packets/${packet.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string })?.error || "Approval failed");
      onApproved();
    } catch (e) {
      setError((e as Error).message || "Approval failed. Please try again.");
    } finally {
      setApproving(false);
    }
  }

  async function handleSendAgreement() {
    setSendingAgreement(true);
    setError(null);
    try {
      const res = await fetch(`/api/packets/${packet.id}/send-agreement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { details?: string; error?: string })?.details || (data as { error?: string })?.error || "Failed to send agreement");
      onApproved(); // refresh parent state
    } catch (e) {
      setError((e as Error).message || "Failed to send agreement. Please try again.");
    } finally {
      setSendingAgreement(false);
    }
  }

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div
        class="modal-container modal-container--lg"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal__header">
          <h2 class="modal__title">Review Onboarding Packet</h2>
          <div class="modal__subtitle">{subName}</div>
          {packet.submitted_at && (
            <div class="modal__meta">Submitted {fmt(packet.submitted_at)}</div>
          )}
          <button class="modal__close" type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div class="modal__body">
          {/* W-9 */}
          <DocReviewRow
            label="W-9"
            doc={w9Doc}
            extraLabel="Tax ID / EIN"
            extraValue={w9Doc?.captured_tax_id ?? null}
          />

          {/* GL COI */}
          <DocReviewRow
            label="GL Certificate of Insurance"
            doc={glDoc}
            extraLabel="Expiration Date"
            extraValue={glDoc?.expiration_date ? fmt(glDoc.expiration_date) : null}
          />

          {/* WC — COI or exemption */}
          <div class="packet-review-row">
            <div class="packet-review-row__label">WC Certificate of Insurance</div>
            <div class="packet-review-row__body">
              {wcDoc ? (
                <DocReviewRow
                  label=""
                  doc={wcDoc}
                  extraLabel="Expiration Date"
                  extraValue={wcDoc.expiration_date ? fmt(wcDoc.expiration_date) : null}
                />
              ) : packet.workers_comp_exempt ? (
                <div class="packet-review-row__exempt">
                  <span class="badge badge--info">Exempt</span>
                  {packet.workers_comp_exemption_reason && (
                    <span class="packet-review-row__reason">
                      {packet.workers_comp_exemption_reason}
                    </span>
                  )}
                </div>
              ) : (
                <span class="packet-review-row__missing">Not uploaded</span>
              )}
            </div>
          </div>

          {/* License */}
          <div class="packet-review-row">
            <div class="packet-review-row__label">Contractor / Business License</div>
            <div class="packet-review-row__body">
              {licDoc ? (
                <>
                  {licDoc.captured_license_number && (
                    <div class="packet-review-row__extra">
                      <span class="packet-review-row__extra-label">License #</span>
                      <span>{licDoc.captured_license_number}</span>
                    </div>
                  )}
                  {licDoc.expiration_date && (
                    <div class="packet-review-row__extra">
                      <span class="packet-review-row__extra-label">Expires</span>
                      <span>{fmt(licDoc.expiration_date)}</span>
                    </div>
                  )}
                  <DocDownloadLink doc={licDoc} />
                </>
              ) : (
                <span class="packet-review-row__missing">Not uploaded</span>
              )}
            </div>
          </div>

          {error && <p class="form-error" style={{ marginTop: "1rem" }}>{error}</p>}

          {/* ── submitted: owner review + approve ───── */}
          {packet.status === "submitted" && (
            <div class="packet-review-actions">
              <p class="packet-review-actions__note">
                Approving will copy all submitted values (Tax ID, license number, expiration dates, insurance/W-9 flags) into the subcontractor's record. After approval you can send the Subcontractor Agreement for signature.
              </p>
              <div class="packet-review-actions__btns">
                <button
                  type="button"
                  class="btn btn--primary"
                  disabled={approving}
                  onClick={handleApprove}
                >
                  {approving ? "Approving…" : "Approve Documents"}
                </button>
                <button type="button" class="btn btn--ghost" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          )}

          {/* ── approved: send agreement ─────────────── */}
          {packet.status === "approved" && (
            <div class="packet-review-actions">
              <div class="packet-review-actions__status">
                <span class="badge badge--success">Documents Approved {fmt(packet.approved_at)}</span>
              </div>
              <p class="packet-review-actions__note">
                Documents reviewed and approved. Next step: send the Subcontractor Agreement for the sub's e-signature.
              </p>
              <div class="packet-review-actions__btns">
                <button
                  type="button"
                  class="btn btn--primary"
                  disabled={sendingAgreement || !agreementTemplateConfigured}
                  title={!agreementTemplateConfigured ? "Configure the BoldSign Subcontractor Agreement template in System Settings before sending." : undefined}
                  onClick={handleSendAgreement}
                >
                  {sendingAgreement ? "Sending…" : "Send Agreement for Signature"}
                </button>
                {!agreementTemplateConfigured && (
                  <p class="packet-review-actions__note packet-review-actions__note--warn">
                    Agreement template not configured. Set <code>subcontractor_agreement_template_id</code> in System Settings to enable this.
                  </p>
                )}
                <button type="button" class="btn btn--ghost" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          )}

          {/* ── awaiting_signature ────────────────────── */}
          {packet.status === "awaiting_signature" && (
            <div class="packet-review-actions">
              <div class="packet-review-actions__status">
                <span class="badge badge--info">Agreement Sent — Awaiting Signature</span>
              </div>
              <p class="packet-review-actions__note">
                The Subcontractor Agreement has been emailed to the sub via BoldSign. This section will update automatically once they sign.
              </p>
              <button type="button" class="btn btn--ghost" onClick={onClose}>
                Close
              </button>
            </div>
          )}

          {/* ── signed: complete ─────────────────────── */}
          {packet.status === "signed" && (
            <div class="packet-review-actions">
              <div class="packet-review-actions__status">
                <span class="badge badge--success">Onboarding Complete</span>
                {packet.signed_at && (
                  <span class="packet-review-actions__date">Agreement signed {fmt(packet.signed_at)}</span>
                )}
              </div>
              <p class="packet-review-actions__note">
                All documents approved and Subcontractor Agreement signed. This sub is fully onboarded.
              </p>
              <button type="button" class="btn btn--ghost" onClick={onClose}>
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function DocReviewRow({
  label,
  doc,
  extraLabel,
  extraValue,
}: {
  label: string;
  doc: PacketDoc | null;
  extraLabel?: string;
  extraValue?: string | null;
}) {
  if (!doc) {
    return (
      <div class="packet-review-row">
        {label && <div class="packet-review-row__label">{label}</div>}
        <div class="packet-review-row__body">
          <span class="packet-review-row__missing">Not uploaded</span>
        </div>
      </div>
    );
  }

  return (
    <div class="packet-review-row">
      {label && <div class="packet-review-row__label">{label}</div>}
      <div class="packet-review-row__body">
        {extraLabel && extraValue && (
          <div class="packet-review-row__extra">
            <span class="packet-review-row__extra-label">{extraLabel}</span>
            <span>{extraValue}</span>
          </div>
        )}
        <DocDownloadLink doc={doc} />
      </div>
    </div>
  );
}

function DocDownloadLink({ doc }: { doc: PacketDoc }) {
  if (!doc.document_id) return null;
  const fileUrl = `/api/documents/${doc.document_id}/file`;
  const isImage = doc.file_type?.startsWith("image/") ?? false;
  const isPdf = doc.file_type === "application/pdf";
  return (
    <div>
      {isImage && (
        <a href={fileUrl} target="_blank" rel="noopener noreferrer">
          <img src={fileUrl} alt="Document preview" class="packet-review-thumb" />
        </a>
      )}
      {isPdf && !isImage && (
        <div class="packet-review-pdf-icon" aria-hidden="true">PDF</div>
      )}
      <a
        href={fileUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="packet-review-download"
      >
        View / Download →
      </a>
    </div>
  );
}

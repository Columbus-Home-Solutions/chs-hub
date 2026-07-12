/**
 * PacketPage — Sprint 39 Run 1.
 *
 * Sub-facing, no-login onboarding packet form. Token-gated via /packet/:token.
 * Mobile-first — designed for phone completion.
 *
 * Four required sections:
 *  1. W-9 (file + Tax ID / EIN field, which we store in expiration_date)
 *  2. Certificate of Insurance — General Liability (file + expiration date)
 *  3. Workers' Comp COI OR exemption declaration (mutually exclusive)
 *  4. Contractor/Business License (file + license number + expiration date,
 *     encoded as "LICENSE_NUMBER|YYYY-MM-DD" in the expiration_date field)
 *
 * API:
 *   GET  /api/packet/:token
 *   POST /api/packet/:token/documents         (multipart)
 *   POST /api/packet/:token/workers-comp-exempt
 *   POST /api/packet/:token/submit
 */

import { useEffect, useState } from "preact/hooks";

// ── helpers ─────────────────────────────────────────────────────────────────

/** Format digits as XX-XXXXXXX (EIN). Strips non-digits, caps at 9. */
function formatEIN(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 9);
  if (digits.length <= 2) return digits;
  return digits.slice(0, 2) + "-" + digits.slice(2);
}

function packetToken(): string {
  const m = window.location.pathname.match(/\/packet\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.details || data?.error || `Request failed: ${res.status}`);
  return data as T;
}

async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.details || data?.error || `Request failed: ${res.status}`);
  return data as T;
}

async function apiUpload<T>(url: string, formData: FormData): Promise<T> {
  const res = await fetch(url, { method: "POST", body: formData });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data?.details || data?.error || `Upload failed: ${res.status}`);
  return data as T;
}

// ── types ──────────────────────────────────────────────────────────────────

interface PacketDoc {
  id: string;
  document_type: string;
  expiration_date: string | null;
  uploaded_at: string;
}

interface PacketData {
  ok: boolean;
  packet_id: string;
  sub_name: string;
  status: string;
  workers_comp_exempt: boolean;
  workers_comp_exemption_reason: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  documents: PacketDoc[];
}

// ── Section components ────────────────────────────────────────────────────────

interface SectionProps {
  label: string;
  description: string;
  done: boolean;
  children: preact.ComponentChildren;
}

function Section({ label, description, done, children }: SectionProps) {
  return (
    <div class={`packet-section${done ? " packet-section--done" : ""}`}>
      <div class="packet-section__header">
        <span class={`packet-section__check${done ? " packet-section__check--done" : ""}`}>
          {done ? "✓" : "○"}
        </span>
        <div>
          <div class="packet-section__label">{label}</div>
          <div class="packet-section__desc">{description}</div>
        </div>
      </div>
      {!done && <div class="packet-section__body">{children}</div>}
    </div>
  );
}

interface FileUploadFieldProps {
  token: string;
  documentType: string;
  onUploaded: () => void;
  extraFields?: preact.ComponentChildren;
  /** Label for the extra text field (e.g. "Tax ID / EIN") */
  extraTextLabel?: string;
  extraTextName?: string;
}

function FileUploadField({
  token,
  documentType,
  onUploaded,
  extraFields,
  extraTextLabel,
  extraTextName,
}: FileUploadFieldProps) {
  const [file, setFile] = useState<File | null>(null);
  const [extraText, setExtraText] = useState("");
  const [expDate, setExpDate] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsExpDate = ["coi_general_liability", "coi_workers_comp", "license"].includes(documentType);
  const isLicense = documentType === "license";
  const isW9 = documentType === "w9";

  async function handleUpload(e: Event) {
    e.preventDefault();
    if (!file) { setError("Please select a file."); return; }
    if (isW9 && !extraText.trim()) { setError("Please enter your Tax ID / EIN."); return; }
    if (isLicense && !extraText.trim()) { setError("Please enter your license number."); return; }

    const fd = new FormData();
    fd.append("file", file);
    fd.append("document_type", documentType);

    if (isW9) {
      // Tax ID goes into its own column — expiration_date stays null for W-9
      fd.append("captured_tax_id", extraText.trim());
    } else if (isLicense) {
      // License number and expiration date are separate fields — no pipe encoding
      fd.append("captured_license_number", extraText.trim());
      if (expDate) fd.append("expiration_date", expDate);
    } else if (needsExpDate && expDate) {
      fd.append("expiration_date", expDate);
    }

    setUploading(true);
    setError(null);
    try {
      await apiUpload(`/api/packet/${token}/documents`, fd);
      onUploaded();
    } catch (e) {
      setError((e as Error).message || "Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <form class="packet-upload-form" onSubmit={handleUpload}>
      {isW9 && (
        <div class="form-group">
          <label class="form-label">Tax ID / EIN *</label>
          <input
            class="form-input"
            type="text"
            inputMode="numeric"
            placeholder="XX-XXXXXXX"
            value={extraText}
            onInput={(e) => {
              const formatted = formatEIN((e.target as HTMLInputElement).value);
              (e.target as HTMLInputElement).value = formatted;
              setExtraText(formatted);
            }}
          />
        </div>
      )}
      {isLicense && (
        <div class="form-group">
          <label class="form-label">License Number *</label>
          <input
            class="form-input"
            type="text"
            placeholder="e.g. CV-1234"
            value={extraText}
            onInput={(e) => setExtraText((e.target as HTMLInputElement).value)}
          />
        </div>
      )}
      {needsExpDate && !isLicense && (
        <div class="form-group">
          <label class="form-label">Expiration Date *</label>
          <input
            class="form-input"
            type="date"
            value={expDate}
            onInput={(e) => setExpDate((e.target as HTMLInputElement).value)}
          />
        </div>
      )}
      {isLicense && (
        <div class="form-group">
          <label class="form-label">License Expiration Date</label>
          <input
            class="form-input"
            type="date"
            value={expDate}
            onInput={(e) => setExpDate((e.target as HTMLInputElement).value)}
          />
        </div>
      )}
      {extraFields}
      <div class="form-group">
        <label class="form-label">Upload File (PDF, JPG, PNG) *</label>
        <input
          class="form-input"
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          onChange={(e) => {
            const files = (e.target as HTMLInputElement).files;
            setFile(files?.[0] ?? null);
          }}
        />
      </div>
      {error && <p class="form-error">{error}</p>}
      <button type="submit" class="btn btn--primary btn--sm" disabled={uploading || !file}>
        {uploading ? "Uploading…" : "Upload"}
      </button>
    </form>
  );
}

// ── PacketPage ────────────────────────────────────────────────────────────────

export function PacketPage() {
  const token = packetToken();
  const [packet, setPacket] = useState<PacketData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // WC choice state
  const [wcMode, setWcMode] = useState<"upload" | "exempt" | null>(null);
  const [wcReason, setWcReason] = useState("");
  const [wcExempting, setWcExempting] = useState(false);
  const [wcError, setWcError] = useState<string | null>(null);

  // Submit state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitMissing, setSubmitMissing] = useState<string[]>([]);

  async function reload() {
    const data = await apiGet<PacketData>(`/api/packet/${token}`);
    setPacket(data);
    // Sync wcMode from server state
    if (data.workers_comp_exempt) setWcMode("exempt");
    return data;
  }

  useEffect(() => {
    if (!token) { setError("Missing packet link."); setLoading(false); return; }
    reload()
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (loading) {
    return (
      <div class="quote-shell">
        <div class="quote-loading">Loading your onboarding packet…</div>
      </div>
    );
  }

  if (error || !packet) {
    return (
      <div class="quote-shell">
        <div class="quote-card quote-empty">
          <h1>Packet unavailable</h1>
          <p>{error ?? "This link is invalid or no longer active."}</p>
          <p class="quote-muted">Please contact Columbus Home Solutions if you need a new link.</p>
        </div>
      </div>
    );
  }

  if (packet.status === "approved") {
    return (
      <div class="quote-shell">
        <div class="quote-card">
          <div class="packet-header">
            <h1>Onboarding Complete</h1>
            <p>Your documents have been reviewed and approved. You're all set to work with Columbus Home Solutions!</p>
          </div>
        </div>
      </div>
    );
  }

  if (packet.status === "submitted") {
    return (
      <div class="quote-shell">
        <div class="quote-card">
          <div class="packet-header">
            <h1>Packet Submitted</h1>
            <p>Thank you! Your documents have been received and are under review. We'll reach out if anything is needed.</p>
          </div>
        </div>
      </div>
    );
  }

  if (packet.status === "awaiting_signature") {
    return (
      <div class="quote-shell">
        <div class="quote-card">
          <div class="packet-header">
            <h1>Sign Your Subcontractor Agreement</h1>
            <p>
              Your documents have been reviewed and approved by Columbus Home Solutions.
              You should have received an email from BoldSign with a link to review and
              sign the Subcontractor Agreement.
            </p>
            <p class="quote-muted">
              Please check your email inbox (and spam folder) for the signing request.
              If you haven't received it, contact Columbus Home Solutions to resend it.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (packet.status === "signed") {
    return (
      <div class="quote-shell">
        <div class="quote-card">
          <div class="packet-header">
            <h1>Onboarding Complete</h1>
            <p>
              Your documents have been approved and your Subcontractor Agreement has been signed.
              You're fully onboarded with Columbus Home Solutions!
            </p>
          </div>
        </div>
      </div>
    );
  }

  const docsByType: Record<string, PacketDoc> = {};
  for (const d of packet.documents) docsByType[d.document_type] = d;

  const hasW9 = !!docsByType["w9"];
  const hasGLCOI = !!docsByType["coi_general_liability"];
  const hasWCCOI = !!docsByType["coi_workers_comp"];
  const hasLicense = !!docsByType["license"];
  const wcSatisfied = hasWCCOI || packet.workers_comp_exempt;

  const completedCount = [hasW9, hasGLCOI, wcSatisfied, hasLicense].filter(Boolean).length;
  const allComplete = completedCount === 4;

  async function handleDeclareExempt(e: Event) {
    e.preventDefault();
    setWcExempting(true);
    setWcError(null);
    try {
      await apiPost(`/api/packet/${token}/workers-comp-exempt`, { reason: wcReason.trim() || null });
      await reload();
    } catch (e) {
      setWcError((e as Error).message);
    } finally {
      setWcExempting(false);
    }
  }

  async function handleSubmit() {
    setSubmitting(true);
    setSubmitError(null);
    setSubmitMissing([]);
    try {
      await apiPost(`/api/packet/${token}/submit`);
      await reload();
    } catch (e) {
      const msg = (e as Error).message || "Submission failed.";
      // Parse the missing list from the response if available
      try {
        const parsed = JSON.parse(msg) as { missing?: string[] };
        if (parsed.missing) { setSubmitMissing(parsed.missing); return; }
      } catch { /* not JSON */ }
      // If the error body contains missing items from the server 422
      if (msg.includes("incomplete_packet")) {
        setSubmitError("Please complete all required sections before submitting.");
      } else {
        setSubmitError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div class="quote-shell">
      <div class="quote-card">
        {/* Header */}
        <div class="packet-header">
          <div class="packet-company">Columbus Home Solutions</div>
          <h1 class="packet-title">Onboarding Packet</h1>
          {packet.sub_name && (
            <p class="packet-sub">Hi <strong>{packet.sub_name}</strong> — please complete all sections below to get set up as a CHS subcontractor.</p>
          )}
        </div>

        {/* Progress indicator */}
        <div class="packet-progress">
          <div class="packet-progress__bar" style={{ width: `${(completedCount / 4) * 100}%` }} />
          <span class="packet-progress__label">{completedCount} of 4 completed</span>
        </div>

        {/* ── W-9 ─────────────────────────────────────────────────────── */}
        <Section
          label="W-9 (Required for Payments)"
          description="Upload your completed IRS W-9. Also enter your Tax ID / EIN so it can be recorded."
          done={hasW9}
        >
          <FileUploadField
            token={token}
            documentType="w9"
            onUploaded={() => reload().catch(() => {})}
          />
        </Section>

        {/* ── GL COI ──────────────────────────────────────────────────── */}
        <Section
          label="Certificate of Insurance — General Liability"
          description="Upload your GL COI. Must name Columbus Home Solutions as additional insured."
          done={hasGLCOI}
        >
          <FileUploadField
            token={token}
            documentType="coi_general_liability"
            onUploaded={() => reload().catch(() => {})}
          />
        </Section>

        {/* ── Workers' Comp ────────────────────────────────────────────── */}
        <Section
          label="Workers' Compensation"
          description="Upload your WC COI, or declare exemption if you are a sole proprietor with no employees (Arkansas allows this)."
          done={wcSatisfied}
        >
          {/* Mode selector */}
          {!wcMode && (
            <div class="packet-wc-choice">
              <button
                type="button"
                class="btn btn--outline btn--sm"
                onClick={() => setWcMode("upload")}
              >
                Upload WC Certificate
              </button>
              <button
                type="button"
                class="btn btn--ghost btn--sm"
                onClick={() => setWcMode("exempt")}
              >
                I'm Exempt (Sole Proprietor / No Employees)
              </button>
            </div>
          )}

          {wcMode === "upload" && (
            <div>
              <button
                type="button"
                class="packet-wc-switch"
                onClick={() => setWcMode("exempt")}
              >
                Switch to: declare exemption instead
              </button>
              <FileUploadField
                token={token}
                documentType="coi_workers_comp"
                onUploaded={() => { reload().catch(() => {}); setWcMode(null); }}
              />
            </div>
          )}

          {wcMode === "exempt" && (
            <div>
              <button
                type="button"
                class="packet-wc-switch"
                onClick={() => setWcMode("upload")}
              >
                Switch to: upload WC certificate instead
              </button>
              <form class="packet-upload-form" onSubmit={handleDeclareExempt}>
                <div class="form-group">
                  <label class="form-label">Reason for Exemption</label>
                  <input
                    class="form-input"
                    type="text"
                    placeholder="e.g. Sole proprietor, no employees"
                    value={wcReason}
                    onInput={(e) => setWcReason((e.target as HTMLInputElement).value)}
                  />
                </div>
                {wcError && <p class="form-error">{wcError}</p>}
                <button
                  type="submit"
                  class="btn btn--outline btn--sm"
                  disabled={wcExempting}
                >
                  {wcExempting ? "Saving…" : "Declare Exemption"}
                </button>
              </form>
            </div>
          )}
        </Section>

        {/* ── License ─────────────────────────────────────────────────── */}
        <Section
          label="Contractor / Business License"
          description="Upload your current contractor or business license document."
          done={hasLicense}
        >
          <FileUploadField
            token={token}
            documentType="license"
            onUploaded={() => reload().catch(() => {})}
          />
        </Section>

        {/* ── Submit ──────────────────────────────────────────────────── */}
        <div class="packet-submit">
          {submitMissing.length > 0 && (
            <div class="packet-missing">
              <p class="form-error">Please complete the following before submitting:</p>
              <ul>
                {submitMissing.map((m) => <li key={m}>{m}</li>)}
              </ul>
            </div>
          )}
          {submitError && <p class="form-error">{submitError}</p>}
          <button
            type="button"
            class="btn btn--primary btn--lg"
            disabled={!allComplete || submitting}
            onClick={handleSubmit}
          >
            {submitting ? "Submitting…" : "Submit Packet"}
          </button>
          {!allComplete && (
            <p class="packet-submit__hint">
              Complete all {4 - completedCount} remaining section{4 - completedCount !== 1 ? "s" : ""} to enable submission.
            </p>
          )}
        </div>

        <footer class="quote-footer">
          <div>Columbus Home Solutions</div>
          <div class="quote-muted">Licensed &amp; insured in the State of Arkansas</div>
        </footer>
      </div>
    </div>
  );
}

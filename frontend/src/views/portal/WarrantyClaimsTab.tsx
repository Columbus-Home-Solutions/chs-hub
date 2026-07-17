/**
 * Portal: Warranty Claims tab (Sprint 38 Part B).
 * Visible only while the job is within its warranty window.
 * Client can submit a claim (description + optional photo) and view prior submissions.
 */

import { useRef, useState } from "preact/hooks";
import { getJson, portalToken } from "./portalApi";
import { useApi } from "../../hooks/useApi";

interface WarrantyClaim {
  id: string;
  claim_date: string;
  description: string;
  status: string;
  resolution: string | null;
  created_at: string;
}

interface ClaimsResponse {
  ok: boolean;
  within_warranty: boolean;
  claims: WarrantyClaim[];
}

const STATUS_LABELS: Record<string, string> = {
  reported: "Received",
  in_progress: "In Progress",
  resolved: "Resolved",
  closed: "Closed",
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export function WarrantyClaimsTab() {
  const token = portalToken();
  const { data, loading, error, refetch } = useApi<ClaimsResponse>(
    `/api/portal/${encodeURIComponent(token)}/warranty-claims`,
  );

  const [description, setDescription] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async () => {
    if (!description.trim()) {
      setSubmitError("Please describe the issue.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);

    try {
      const form = new FormData();
      form.append("description", description.trim());
      if (photoFile) form.append("photo", photoFile, photoFile.name);

      const res = await fetch(
        `/api/portal/${encodeURIComponent(token)}/warranty-claims`,
        { method: "POST", body: form },
      );
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(
          (body?.details as string) || (body?.error as string) || `Request failed: ${res.status}`,
        );
      }
      setSubmitted(true);
      setDescription("");
      setPhotoFile(null);
      if (fileRef.current) fileRef.current.value = "";
      void refetch();
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div class="portal-card">
        <p class="portal-empty">Loading warranty information…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div class="portal-card">
        <p class="portal-empty">Could not load warranty information. Please try again.</p>
      </div>
    );
  }

  if (!data.within_warranty) {
    return (
      <div class="portal-card">
        <h2 class="portal-card__title">Warranty Claims</h2>
        <p class="portal-empty" style={{ marginTop: "var(--space-md)" }}>
          Your project is no longer within its warranty period. If you have a concern, please{" "}
          <strong>contact us directly</strong>.
        </p>
        {data.claims.length > 0 && <ClaimsList claims={data.claims} />}
      </div>
    );
  }

  return (
    <div class="portal-card">
      <h2 class="portal-card__title">Submit a Warranty Claim</h2>
      <p style={{ fontSize: "var(--text-sm)", color: "var(--color-text-muted)", marginTop: 0 }}>
        Your project is within its warranty period. Use this form to report any issues and we'll
        follow up promptly.
      </p>

      {submitted && (
        <div class="portal-success-banner" role="alert">
          <strong>Claim submitted!</strong> We'll review it and follow up with you soon.
        </div>
      )}

      <div class="portal-warranty-form">
        <label class="quote-field" for="warranty-desc">
          <span>
            Describe the issue <span style={{ color: "var(--color-danger)" }}>*</span>
          </span>
          <textarea
            id="warranty-desc"
            class="quote-textarea"
            rows={5}
            placeholder="Describe what you're seeing — where the issue is, when it started, etc."
            value={description}
            onInput={(e) => {
              setDescription((e.target as HTMLTextAreaElement).value);
              setSubmitError(null);
            }}
            disabled={submitting}
          />
        </label>

        <label class="quote-field" for="warranty-photo">
          <span>Attach a photo (optional)</span>
          <div class="portal-file-picker">
            <input
              id="warranty-photo"
              ref={fileRef}
              class="portal-file-picker__input"
              type="file"
              accept="image/*"
              capture="environment"
              disabled={submitting}
              onChange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0] ?? null;
                setPhotoFile(f);
              }}
            />
            <button
              type="button"
              class="quote-btn quote-btn--secondary portal-file-picker__btn"
              disabled={submitting}
              onClick={() => fileRef.current?.click()}
            >
              {photoFile ? "Change Photo" : "Attach Photo"}
            </button>
          </div>
        </label>
        {photoFile && (
          <p class="quote-muted" style={{ margin: "var(--space-xs) 0 0" }}>
            {photoFile.name} ({Math.round(photoFile.size / 1024)} KB)
          </p>
        )}

        {submitError && (
          <p class="quote-error" role="alert">
            {submitError}
          </p>
        )}

        <button
          type="button"
          class="quote-btn quote-btn--primary portal-warranty-form__submit"
          onClick={() => void handleSubmit()}
          disabled={submitting || !description.trim()}
        >
          {submitting ? "Submitting…" : "Submit Warranty Claim"}
        </button>
      </div>

      {data.claims.length > 0 && (
        <div style={{ marginTop: "var(--space-xl)" }}>
          <h3 style={{ fontSize: "var(--text-base)", fontWeight: 600, marginBottom: "var(--space-sm)" }}>
            Your previous submissions
          </h3>
          <ClaimsList claims={data.claims} />
        </div>
      )}
    </div>
  );
}

function claimStatusTone(status: string): "success" | "warning" | "info" | "danger" {
  if (status === "resolved" || status === "closed") return "success";
  if (status === "in_progress") return "info";
  return "warning";
}

function ClaimsList({ claims }: { claims: WarrantyClaim[] }) {
  return (
    <div class="portal-message-list" style={{ marginTop: "var(--space-md)" }}>
      {claims.map((c) => (
        <div key={c.id} class="portal-message portal-message--inbound" style={{ marginBottom: "var(--space-md)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", marginBottom: "var(--space-xs)" }}>
            <span class={`portal-badge portal-badge--${claimStatusTone(c.status)}`}>
              {STATUS_LABELS[c.status] ?? c.status}
            </span>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>
              Submitted {formatDate(c.created_at)}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>{c.description}</p>
          {c.resolution && (
            <p
              style={{
                marginTop: "var(--space-xs)",
                fontSize: "var(--text-sm)",
                color: "var(--color-text-muted)",
                borderLeft: "3px solid var(--color-success)",
                paddingLeft: "var(--space-sm)",
              }}
            >
              <strong>Response:</strong> {c.resolution}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

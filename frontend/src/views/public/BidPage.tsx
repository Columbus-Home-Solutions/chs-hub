/**
 * Sub-facing bid submission page (Sprint 38 Run 3).
 * Token in URL is the only credential — no Cloudflare Access, no login.
 * Sealed mode: sub sees only their own submission after submitting.
 * Open mode: sub sees current price list (anonymised) after submitting.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Spinner } from "../../components/ui/Spinner";

// ── Types ─────────────────────────────────────────────────────────────────────

interface MySubmission {
  id: string;
  price: number;
  notes: string | null;
  status: string;
  submitted_at: string;
}

interface OtherSubmission {
  price: number;
  submitted_at: string;
}

interface BidPayload {
  bid_request_id: string;
  title: string;
  scope_description: string;
  quantities_notes: string | null;
  needed_by_date: string | null;
  status: string;
  bid_mode: string;
  sub_name: string;
  my_submission: MySubmission | null;
  other_submissions: OtherSubmission[];
}

// ── helpers ───────────────────────────────────────────────────────────────────

function bidToken(): string {
  const m = window.location.pathname.match(/\/bid\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) } });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = new Error((data?.message || data?.error || `Request failed: ${res.status}`) as string);
    (e as Error & { status: number }).status = res.status;
    throw e;
  }
  return data as T;
}

function formatCurrency(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function formatDate(iso: string): string {
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
      month: "long", day: "numeric", year: "numeric",
    });
  } catch { return iso; }
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// ── Component ─────────────────────────────────────────────────────────────────

export function BidPage() {
  const token = useMemo(bidToken, []);
  const [data, setData] = useState<BidPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadErrorStatus, setLoadErrorStatus] = useState<number | null>(null);

  // Submission form state
  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview); }, [photoPreview]);

  const load = useCallback(async () => {
    if (!token) { setLoadError("invalid_link"); setLoadErrorStatus(404); setLoading(false); return; }
    setLoading(true);
    setLoadError(null);
    try {
      const payload = await apiFetch<BidPayload>(`/api/bid/${encodeURIComponent(token)}`);
      setData(payload);
    } catch (e) {
      const err = e as Error & { status?: number };
      setLoadError(err.message);
      setLoadErrorStatus(err.status ?? null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const onPhotoSelected = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoError("Photo too large — please use a smaller image (under 10 MB)");
      return;
    }
    setPhotoError(null);
    setPhoto(file);
    setPhotoPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
  };

  const clearPhoto = () => {
    setPhoto(null);
    setPhotoPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setPhotoError(null);
  };

  const handleSubmit = async () => {
    if (submitting) return;
    const parsedPrice = parseFloat(price.replace(/[^0-9.]/g, ""));
    if (!parsedPrice || parsedPrice <= 0) {
      setSubmitError("Please enter a valid price.");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      const form = new FormData();
      form.append("price", String(parsedPrice));
      if (notes.trim()) form.append("notes", notes.trim());
      if (photo) form.append("photo", photo, photo.name || "attachment.jpg");

      await apiFetch(`/api/bid/${encodeURIComponent(token)}/submit`, { method: "POST", body: form });
      setSubmitted(true);
      await load();
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 409) {
        setSubmitError("You've already submitted a bid for this request.");
        await load();
      } else {
        setSubmitError(err.message || "Submission failed. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  // ── Loading / error states ────────────────────────────────────────────────

  if (loading) {
    return (
      <div class="punch-page">
        <Spinner center />
      </div>
    );
  }

  if (loadError || !data) {
    const notFound = loadErrorStatus === 404 || loadError === "invalid_link";
    return (
      <div class="punch-page">
        <div class="punch-page__error">
          <div class="portal-empty__icon">🔗</div>
          <h1 class="punch-page__title">
            {notFound ? "Link not found" : "Something went wrong"}
          </h1>
          <p>
            {notFound
              ? "This bid link is invalid or has expired. Contact Tony at (501) 551-1814."
              : loadError ?? "Could not load the bid request."}
          </p>
        </div>
      </div>
    );
  }

  const isClosed = data.status !== "open";

  return (
    <div class="punch-page">
      <header class="punch-page__brand">
        <div class="punch-page__company">Columbus Home Solutions LLC</div>
        <h1 class="punch-page__title">Price Quote Request</h1>
      </header>

      <div class="punch-page__greeting">
        <p>Hi {data.sub_name},</p>
        <p>CHS is requesting a price quote for the scope below.</p>
      </div>

      {/* ── Scope details ──────────────────────────────────────────────── */}
      <section class="portal-section">
        <h2 class="portal-section__title">{data.title}</h2>

        <div class="portal-info-grid" style={{ marginTop: "12px" }}>
          {data.needed_by_date && (
            <div class="portal-info-row">
              <span class="portal-info-label">Needed by</span>
              <span class="portal-info-value">{formatDate(data.needed_by_date)}</span>
            </div>
          )}
        </div>

        <div style={{ marginTop: "12px" }}>
          <div class="portal-info-label" style={{ marginBottom: "4px" }}>Scope of work</div>
          <p style={{ whiteSpace: "pre-wrap", lineHeight: "1.6", margin: 0 }}>
            {data.scope_description}
          </p>
        </div>

        {data.quantities_notes && (
          <div style={{ marginTop: "12px" }}>
            <div class="portal-info-label" style={{ marginBottom: "4px" }}>Quantities / notes</div>
            <p style={{ whiteSpace: "pre-wrap", lineHeight: "1.6", margin: 0 }}>
              {data.quantities_notes}
            </p>
          </div>
        )}
      </section>

      {/* ── My existing submission ────────────────────────────────────── */}
      {data.my_submission && (
        <section class="portal-section">
          <h2 class="portal-section__title">Your Submission</h2>
          <div class="portal-info-grid">
            <div class="portal-info-row">
              <span class="portal-info-label">Your price</span>
              <span class="portal-info-value" style={{ fontWeight: 700 }}>
                {formatCurrency(data.my_submission.price)}
              </span>
            </div>
            {data.my_submission.notes && (
              <div class="portal-info-row">
                <span class="portal-info-label">Notes</span>
                <span class="portal-info-value">{data.my_submission.notes}</span>
              </div>
            )}
            <div class="portal-info-row">
              <span class="portal-info-label">Status</span>
              <span class={`badge badge--${data.my_submission.status === "won" ? "success" : data.my_submission.status === "lost" ? "neutral" : "info"}`}>
                {data.my_submission.status === "won"
                  ? "Awarded"
                  : data.my_submission.status === "lost"
                  ? "Not selected"
                  : "Received"}
              </span>
            </div>
          </div>

          {/* Open mode: show other prices after submitting */}
          {data.bid_mode === "open" && data.other_submissions.length > 0 && (
            <div style={{ marginTop: "16px" }}>
              <div class="portal-info-label" style={{ marginBottom: "8px" }}>
                Other submitted prices ({data.other_submissions.length})
              </div>
              <div class="bid-prices-list">
                {data.other_submissions.map((s, i) => (
                  <div key={i} class="bid-price-row">
                    <span class="bid-price-row__label">Bidder {i + 1}</span>
                    <span class="bid-price-row__value">{formatCurrency(s.price)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── Submission form ───────────────────────────────────────────── */}
      {!data.my_submission && !isClosed && (
        <section class="portal-section">
          <h2 class="portal-section__title">Submit Your Price</h2>

          {submitted && (
            <div class="portal-success-banner" style={{ marginBottom: "16px" }}>
              Your bid has been submitted. Thank you!
            </div>
          )}

          {submitError && (
            <p class="form-error" role="alert" style={{ marginBottom: "12px" }}>
              {submitError}
            </p>
          )}

          <FormField label="Your price (total for this scope)" required>
            <div style={{ position: "relative" }}>
              <span style={{
                position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)",
                color: "var(--color-text-muted)", pointerEvents: "none",
              }}>$</span>
              <input
                class="form-input"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                style={{ paddingLeft: "28px" }}
                value={price}
                onInput={(e) => setPrice((e.target as HTMLInputElement).value)}
                disabled={submitting}
              />
            </div>
          </FormField>

          <FormField label="Notes (optional)" style={{ marginTop: "12px" }}>
            <textarea
              class="form-input"
              rows={3}
              placeholder="Breakdown, clarifications, timeline..."
              value={notes}
              onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
              disabled={submitting}
            />
          </FormField>

          <FormField label="Attachment (optional)" style={{ marginTop: "12px" }}>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
              onChange={(e) => { onPhotoSelected((e.target as HTMLInputElement).files?.[0]); (e.target as HTMLInputElement).value = ""; }} />
            <input ref={libraryRef} type="file" accept="image/*" style={{ display: "none" }}
              onChange={(e) => { onPhotoSelected((e.target as HTMLInputElement).files?.[0]); (e.target as HTMLInputElement).value = ""; }} />

            {photoPreview ? (
              <div class="punch-done-photo-preview">
                <img src={photoPreview} alt="Attachment preview" />
                <Button variant="secondary" size="sm" disabled={submitting} onClick={clearPhoto}>
                  Remove
                </Button>
              </div>
            ) : (
              <div class="punch-done-photo-pick">
                <button type="button" class="punch-done-photo-pick__btn" disabled={submitting}
                  onClick={() => cameraRef.current?.click()}>
                  Take photo
                </button>
                <span class="punch-done-photo-pick__or">or</span>
                <button type="button" class="punch-done-photo-pick__btn" disabled={submitting}
                  onClick={() => libraryRef.current?.click()}>
                  Choose from library
                </button>
              </div>
            )}
            {photoError && <p class="form-error" role="alert">{photoError}</p>}
          </FormField>

          <Button
            variant="primary"
            style={{ marginTop: "20px", width: "100%" }}
            disabled={submitting || !price}
            onClick={handleSubmit}
          >
            {submitting ? "Submitting…" : "Submit My Price"}
          </Button>
        </section>
      )}

      {isClosed && !data.my_submission && (
        <section class="portal-section">
          <p style={{ color: "var(--color-text-muted)", textAlign: "center" }}>
            This bid request is no longer accepting submissions.
          </p>
        </section>
      )}

      <footer class="punch-page__footer">
        Questions? Call Tony: <a href="tel:+15015511814">(501) 551-1814</a>
      </footer>
    </div>
  );
}

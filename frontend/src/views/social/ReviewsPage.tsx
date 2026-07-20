import type { RoutableProps } from "preact-router";
import { useState } from "preact/hooks";
import { useUrlTab } from "../../hooks/useUrlTab";
import { useApi } from "../../hooks/useApi";
import { api, ApiError } from "../../api";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { formatDate } from "../../lib/format";
import { go } from "../../lib/nav";

// ─── Types ────────────────────────────────────────────────────────────────────

interface GoogleReview {
  id: string;
  google_review_id: string | null;
  reviewer_name: string;
  star_rating: number;
  comment_text: string | null;
  review_created_at: string;
  reply_text: string | null;
  reply_sent_at: string | null;
  reply_source: string | null;
  matched_client_id: string | null;
  matched_client_name: string | null;
  match_confidence: string | null;
  entry_source: string;
}

interface ReviewListResponse {
  reviews: GoogleReview[];
  gbp_live: boolean;
}

interface ReviewStats {
  total: number;
  avg_rating: number | null;
  unanswered: number;
  positive: number;
  critical: number;
  gbp_live: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StarRating({ rating }: { rating: number }) {
  return (
    <span style={{ color: "#f59e0b", letterSpacing: "1px" }}>
      {"★".repeat(rating)}
      <span style={{ opacity: 0.25 }}>{"★".repeat(5 - rating)}</span>
    </span>
  );
}

// ─── Add Review Modal ─────────────────────────────────────────────────────────

function AddReviewModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    reviewer_name: "",
    star_rating: "5",
    comment_text: "",
    review_created_at: new Date().toISOString().slice(0, 10),
  });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!form.reviewer_name.trim()) {
      toast.push("error", "Reviewer name is required");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/google-reviews", {
        reviewer_name: form.reviewer_name,
        star_rating: parseInt(form.star_rating, 10),
        comment_text: form.comment_text || null,
        review_created_at: form.review_created_at,
      });
      toast.push("success", "Review added");
      onSaved();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title="Add Review"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "Saving…" : "Add Review"}
          </Button>
        </>
      }
    >
      <p class="text--muted" style={{ fontSize: "var(--text-sm)", margin: "0 0 var(--space-md)" }}>
        Manually tracking reviews until Google integration goes live.
      </p>
      <FormField
        label="Reviewer name"
        required
        inputProps={{
          value: form.reviewer_name,
          placeholder: "e.g. Jane Smith",
          onInput: (e) => setForm((p) => ({ ...p, reviewer_name: (e.target as HTMLInputElement).value })),
        }}
      />
      <FormField label="Star rating" required>
        <Select
          value={form.star_rating}
          onChange={(v) => setForm((p) => ({ ...p, star_rating: v }))}
          options={[5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: `${"★".repeat(n)} ${n} star${n !== 1 ? "s" : ""}` }))}
        />
      </FormField>
      <FormField label="Review text">
        <textarea
          class="form-textarea"
          placeholder="Review content (optional — some reviewers leave stars only)"
          value={form.comment_text}
          onInput={(e) => setForm((p) => ({ ...p, comment_text: (e.target as HTMLTextAreaElement).value }))}
        />
      </FormField>
      <FormField
        label="Review date"
        inputProps={{
          type: "date",
          value: form.review_created_at,
          onInput: (e) => setForm((p) => ({ ...p, review_created_at: (e.target as HTMLInputElement).value })),
        }}
      />
    </Modal>
  );
}

// ─── Reply Composer ───────────────────────────────────────────────────────────

function ReplyComposer({
  review,
  gbpLive,
  onReplied,
}: {
  review: GoogleReview;
  gbpLive: boolean;
  onReplied: () => void;
}) {
  const toast = useToast();
  const [replyText, setReplyText] = useState(review.reply_text ?? "");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(!!review.reply_text);

  const generate = async () => {
    setGenerating(true);
    try {
      const res = await api.post<{ draft: string | null; error?: string }>(
        `/api/google-reviews/${review.id}/generate-response`,
        {},
      );
      if (res.draft) {
        setReplyText(res.draft);
        setSaved(false);
      } else {
        toast.push("error", res.error ?? "AI unavailable — write your reply manually.");
      }
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const save = async () => {
    if (!replyText.trim()) {
      toast.push("error", "Reply text is required");
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<{ posted_to_google?: boolean }>(
        `/api/google-reviews/${review.id}/reply`,
        { reply_text: replyText },
      );
      setSaved(true);
      toast.push(
        "success",
        res.posted_to_google ? "Reply posted to Google" : "Reply saved",
      );
      onReplied();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: "var(--space-md)" }}>
      {saved && gbpLive && (
        <div class="callout callout--success" role="status" style={{ marginBottom: "var(--space-sm)" }}>
          <strong>Posted to Google Business Profile.</strong>
        </div>
      )}
      {saved && !gbpLive && (
        <div class="callout callout--warning" role="status" style={{ marginBottom: "var(--space-sm)" }}>
          <strong>Saved here — not yet posted to Google.</strong> Copy this reply to your{" "}
          <a href="https://business.google.com" target="_blank" rel="noreferrer" style={{ color: "var(--color-primary)" }}>
            Google Business Profile
          </a>{" "}
          manually for now.
        </div>
      )}
      <textarea
        class="form-textarea"
        placeholder="Write a reply…"
        value={replyText}
        rows={4}
        onInput={(e) => {
          setReplyText((e.target as HTMLTextAreaElement).value);
          setSaved(false);
        }}
      />
      <div class="flex gap-xs" style={{ marginTop: "var(--space-xs)" }}>
        <Button
          size="sm"
          variant="secondary"
          disabled={generating}
          onClick={() => void generate()}
        >
          {generating ? "Generating…" : "Generate Response"}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={saving || !replyText.trim()}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : saved ? "Update Reply" : "Reply"}
        </Button>
      </div>
    </div>
  );
}

// ─── Client Match Badge ───────────────────────────────────────────────────────

function ClientMatchBadge({
  review,
  onMatched,
}: {
  review: GoogleReview;
  onMatched: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<"confirm" | "dismiss" | null>(null);

  if (review.match_confidence === "confirmed" && review.matched_client_id) {
    return (
      <span
        style={{ fontSize: "var(--text-xs)", cursor: "pointer", color: "var(--color-primary)" }}
        onClick={() => go(`/clients/${review.matched_client_id}`)}
      >
        ✓ {review.matched_client_name ?? "Matched client"}
      </span>
    );
  }

  if (review.match_confidence === "suggested" && review.matched_client_id) {
    const confirm = async () => {
      setBusy("confirm");
      try {
        await api.put(`/api/google-reviews/${review.id}/match`, {
          action: "confirm",
          client_id: review.matched_client_id,
        });
        onMatched();
      } catch (e) {
        toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
      } finally {
        setBusy(null);
      }
    };

    const dismiss = async () => {
      setBusy("dismiss");
      try {
        await api.put(`/api/google-reviews/${review.id}/match`, { action: "dismiss" });
        onMatched();
      } catch (e) {
        toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
      } finally {
        setBusy(null);
      }
    };

    return (
      <div style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-xs)" }}>
        <span class="text--muted">Possible match: </span>
        <span style={{ fontWeight: 500 }}>{review.matched_client_name ?? "Unknown"}</span>
        {" — "}
        <button
          type="button"
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-success, #16a34a)", fontWeight: 500, padding: 0 }}
          disabled={!!busy}
          onClick={() => void confirm()}
        >
          {busy === "confirm" ? "…" : "Confirm"}
        </button>
        {" · "}
        <button
          type="button"
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-text-muted)", padding: 0 }}
          disabled={!!busy}
          onClick={() => void dismiss()}
        >
          {busy === "dismiss" ? "…" : "Not this client"}
        </button>
      </div>
    );
  }

  return null;
}

// ─── Review Card ─────────────────────────────────────────────────────────────

function ReviewCard({
  review,
  gbpLive,
  onRefresh,
}: {
  review: GoogleReview;
  gbpLive: boolean;
  onRefresh: () => void;
}) {
  const toast = useToast();
  const [replyOpen, setReplyOpen] = useState(false);
  const [featureBusy, setFeatureBusy] = useState(false);
  const [featured, setFeatured] = useState(false);

  const toggleFeature = async () => {
    setFeatureBusy(true);
    try {
      const res = await api.post<{ featured: boolean }>(`/api/google-reviews/${review.id}/feature`, {
        featured: !featured,
      });
      setFeatured(res.featured);
      toast.push("success", res.featured ? "Featured on quote page" : "Removed from quote page");
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setFeatureBusy(false);
    }
  };

  return (
    <Card>
      <div class="flex items-start justify-between gap-sm">
        <div style={{ flex: 1 }}>
          <div class="flex items-center gap-sm flex-wrap">
            <StarRating rating={review.star_rating} />
            <strong style={{ fontSize: "var(--text-sm)" }}>{review.reviewer_name}</strong>
            <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
              {formatDate(review.review_created_at)}
            </span>
            {review.entry_source === "manual" && (
              <span style={{ fontSize: "11px" }}><Badge tone="neutral">Manual entry</Badge></span>
            )}
            {review.reply_text && (
              <span style={{ fontSize: "11px" }}><Badge tone="success">Replied</Badge></span>
            )}
          </div>

          {review.comment_text ? (
            <p style={{ margin: "var(--space-xs) 0 0", fontSize: "var(--text-sm)", lineHeight: 1.5 }}>
              {review.comment_text}
            </p>
          ) : (
            <p class="text--muted" style={{ margin: "var(--space-xs) 0 0", fontSize: "var(--text-sm)", fontStyle: "italic" }}>
              No comment — stars only.
            </p>
          )}

          <ClientMatchBadge review={review} onMatched={onRefresh} />

          {review.reply_text && !replyOpen && (
            <div style={{ marginTop: "var(--space-sm)", borderLeft: "3px solid var(--color-border)", paddingLeft: "var(--space-sm)", fontSize: "var(--text-sm)" }}>
              <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>Your reply:</span>
              <p style={{ margin: "2px 0 0" }}>{review.reply_text}</p>
              {!gbpLive && (
                <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
                  ⚠ Not yet posted to Google
                </span>
              )}
            </div>
          )}

          {replyOpen && (
            <ReplyComposer
              review={review}
              gbpLive={gbpLive}
              onReplied={() => { onRefresh(); setReplyOpen(false); }}
            />
          )}
        </div>

        <div class="flex flex-col gap-xs" style={{ flexShrink: 0 }}>
          <Button
            size="sm"
            variant={replyOpen ? "tertiary" : "secondary"}
            onClick={() => setReplyOpen((v) => !v)}
          >
            {replyOpen ? "Cancel" : review.reply_text ? "Edit Reply" : "Reply"}
          </Button>
          <Button
            size="sm"
            variant="tertiary"
            disabled={featureBusy}
            onClick={() => void toggleFeature()}
            title="Feature this review on estimate quote pages"
          >
            {featured ? "★ Featured" : "☆ Feature"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ─── Google G mark (original SVG, Google brand colors, not their trademarked logo) ──

export function GoogleGMark({ size = 22 }: { size?: number } = {}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 22 22"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {/* Blue arc (top-left) */}
      <path d="M11 4.5A6.5 6.5 0 0 0 5.14 14.1L2.5 16.74A10 10 0 0 1 1 11 10 10 0 0 1 11 1v3.5Z" fill="#4285F4" />
      {/* Red arc (bottom-left) */}
      <path d="M1 11A10 10 0 0 0 4.5 18.33L7.14 15.7A6.5 6.5 0 0 1 4.5 11H1Z" fill="#EA4335" />
      {/* Yellow arc (bottom-right) */}
      <path d="M11 17.5A6.5 6.5 0 0 1 5.14 14.1L2.5 16.74A10 10 0 0 0 11 21v-3.5Z" fill="#FBBC05" />
      {/* Green arc (right half) */}
      <path d="M21 11c0-.83-.1-1.63-.28-2.4H11v4.55h5.64A4.82 4.82 0 0 1 14.6 15.7l2.64 2.63A9.97 9.97 0 0 0 21 11Z" fill="#34A853" />
      {/* White center cutout for the "G" negative space */}
      <circle cx="11" cy="11" r="4" fill="white" />
    </svg>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type Filter = "all" | "unanswered";

export function ReviewsPage(_props: RoutableProps) {
  const [filter, setFilter] = useUrlTab(["all", "unanswered"] as const, "all", "filter");
  const [addOpen, setAddOpen] = useState(false);

  const { data: statsData, refetch: refetchStats } = useApi<ReviewStats>("/api/google-reviews/stats");
  const { data, loading, refetch } = useApi<ReviewListResponse>(
    `/api/google-reviews?filter=${filter}`,
  );

  const refresh = () => {
    refetch();
    refetchStats();
  };

  const reviews = data?.reviews ?? [];
  const gbpLive = data?.gbp_live ?? false;
  const stats = statsData;

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title" style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
            <GoogleGMark />
            Google Reviews
          </h1>
          <p class="view-subtitle">
            {gbpLive
              ? "Live sync from Google Business Profile every 30 minutes. Replies post to Google."
              : "Manual tracking until Google Business Profile is connected and live sync is enabled."}
          </p>
        </div>
        <div class="view-header__right flex items-center gap-sm">
          <Button
            variant={gbpLive ? "tertiary" : "secondary"}
            onClick={() => setAddOpen(true)}
          >
            + Add Review
          </Button>
        </div>
      </div>

      {gbpLive && (
        <div class="callout callout--success" role="status" style={{ marginBottom: "var(--space-md)" }}>
          <strong>GBP live sync is on.</strong> New Google reviews appear here automatically; posting a reply
          sends it to Google first.
        </div>
      )}

      {/* ── Summary strip ─────────────────────────────────────────── */}
      {stats && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: "var(--space-md)",
            marginBottom: "var(--space-lg)",
          }}
        >
          {[
            { label: "Total Reviews", value: String(stats.total) },
            {
              label: "Average Rating",
              value: stats.avg_rating != null ? `${stats.avg_rating.toFixed(1)} ★` : "—",
            },
            { label: "Unanswered", value: String(stats.unanswered) },
            { label: "Positive (4–5★)", value: String(stats.positive) },
          ].map((s) => (
            <Card key={s.label}>
              <div style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)", marginBottom: "4px" }}>
                {s.label}
              </div>
              <div style={{ fontSize: "var(--text-xl, 1.5rem)", fontWeight: 700 }}>{s.value}</div>
            </Card>
          ))}
        </div>
      )}

      {/* ── Filter tabs ───────────────────────────────────────────── */}
      <div class="pipeline-tab-bar" style={{ marginBottom: "var(--space-md)" }}>
        {(["all", "unanswered"] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            class={`pipeline-tab-bar__tab${filter === f ? " pipeline-tab-bar__tab--active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "All" : "Unanswered"}
            {f === "unanswered" && stats && stats.unanswered > 0 && (
              <span class="pipeline-tab-bar__badge" style={{ marginLeft: "4px", background: "var(--color-error, #dc2626)", color: "#fff", fontSize: "11px" }}>
                {stats.unanswered}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Review feed ───────────────────────────────────────────── */}
      {loading ? (
        <Spinner center />
      ) : reviews.length === 0 ? (
        <div class="empty-state">
          {filter === "unanswered" ? "All reviews have been replied to." : "No reviews yet. Add your first review above."}
        </div>
      ) : (
        <div class="stack">
          {reviews.map((r) => (
            <ReviewCard key={r.id} review={r} gbpLive={gbpLive} onRefresh={refresh} />
          ))}
        </div>
      )}

      {addOpen && (
        <AddReviewModal
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

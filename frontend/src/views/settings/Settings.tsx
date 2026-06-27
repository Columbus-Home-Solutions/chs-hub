import type { RoutableProps } from "preact-router";
import { useEffect, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Modal } from "../../components/ui/Modal";
import { FormField } from "../../components/ui/FormField";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatStatus } from "../../lib/format";
import { REVIEW_SOURCES, type SavedReview } from "../../types";
import { useAuth } from "../../store/auth";
import { isOwner, ROLE_LABELS } from "../../lib/rbac";
import { UsersTab } from "./UsersTab";
import { AuditLogTab, DlqTab, BackupTab, HealthTab } from "./ReliabilityTabs";
import { CompanyTab, FinancialSettingsTab, NotificationsTab, QuoteFollowUpsTab } from "./SettingsEditors";
import { IntegrationsTab } from "./IntegrationsTab";

type TabKey =
  | "company"
  | "financial"
  | "integrations"
  | "notifications"
  | "quote_follow_ups"
  | "users"
  | "audit"
  | "dlq"
  | "backup"
  | "health"
  | "mobile";

const TABS: { key: TabKey; label: string }[] = [
  { key: "company", label: "Company" },
  { key: "financial", label: "Financial" },
  { key: "integrations", label: "Integrations" },
  { key: "notifications", label: "Notifications" },
  { key: "quote_follow_ups", label: "Quote Follow-Ups" },
  { key: "users", label: "Users" },
  { key: "audit", label: "Audit Log" },
  { key: "dlq", label: "Failure Queue" },
  { key: "backup", label: "Backup" },
  { key: "health", label: "Health" },
  { key: "mobile", label: "Mobile App" },
];

export function Settings(_props: RoutableProps) {
  const { user, loading } = useAuth();
  const [tab, setTab] = useState<TabKey>("company");

  if (loading) return <Spinner center />;

  // Owner-only surface (business rule 1). The server also returns 403 on every
  // System Admin route — this is the UI half of the same gate.
  if (!isOwner(user)) {
    return (
      <div>
        <div class="view-header">
          <h1 class="view-title">Settings</h1>
        </div>
        <Card title="Owner only">
          <p class="text--muted">
            System Settings are restricted to the Owner role. You're signed in as{" "}
            <strong>{user ? ROLE_LABELS[user.role] : "an unknown role"}</strong>.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div class="view-header">
        <div>
          <h1 class="view-title">System Settings</h1>
          <p class="view-subtitle">Owner administration — {user?.email}</p>
        </div>
      </div>

      <div class="job-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            class={`job-tab${tab === t.key ? " job-tab--active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div class="mt-lg" />

      {tab === "company" && (
        <>
          <CompanyTab />
          <div class="mt-lg" />
          <ReviewsSection />
        </>
      )}
      {tab === "financial" && <FinancialSettingsTab />}
      {tab === "integrations" && <IntegrationsTab />}
      {tab === "notifications" && <NotificationsTab />}
      {tab === "quote_follow_ups" && <QuoteFollowUpsTab />}
      {tab === "users" && <UsersTab />}
      {tab === "audit" && <AuditLogTab />}
      {tab === "dlq" && <DlqTab />}
      {tab === "backup" && <BackupTab />}
      {tab === "health" && <HealthTab />}
      {tab === "mobile" && (
        <Card title="Mobile App">
          <div class="empty-state">
            <p>📱 Native mobile app (Capacitor / App Store) is coming in a later build (Sprint 18).</p>
            <p class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
              This is a placeholder seam — no mobile infrastructure ships this sprint.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── Saved reviews CRUD (feeds the estimate quote page in Sprint 5) ───────────

function ReviewsSection() {
  const toast = useToast();
  const [reviews, setReviews] = useState<SavedReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<SavedReview | null>(null);
  const [creating, setCreating] = useState(false);

  const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ reviews: SavedReview[] }>("/api/reviews");
      setReviews(r.reviews);
    } catch (e) {
      toast.push("error", errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const toggle = async (r: SavedReview) => {
    try {
      await api.put(`/api/reviews/${r.id}`, { is_active: !r.is_active });
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };
  const remove = async (r: SavedReview) => {
    try {
      await api.del(`/api/reviews/${r.id}`);
      toast.push("success", "Review removed");
      void load();
    } catch (e) {
      toast.push("error", errMsg(e));
    }
  };

  return (
    <Card
      title="Saved Reviews"
      actions={
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
          + Add Review
        </Button>
      }
    >
      {loading ? (
        <Spinner center />
      ) : reviews.length === 0 ? (
        <div class="text--muted" style={{ fontSize: "var(--text-sm)" }}>
          No reviews yet. Add your best reviews to feature them on estimates.
        </div>
      ) : (
        <div class="review-list">
          {reviews.map((r) => (
            <div class="review-row" key={r.id}>
              <div class="review-row__main">
                <div class="flex items-center gap-sm">
                  <span class="review-row__stars">{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</span>
                  <span class="review-row__name">{r.reviewer_name}</span>
                  <Badge tone="neutral">{formatStatus(r.source)}</Badge>
                  {!r.is_active && <Badge tone="warning">Hidden</Badge>}
                </div>
                <div class="review-row__text">{r.review_text}</div>
              </div>
              <div class="flex gap-sm">
                <Button size="sm" variant="secondary" onClick={() => setEditing(r)}>
                  Edit
                </Button>
                <Button size="sm" variant="tertiary" onClick={() => toggle(r)}>
                  {r.is_active ? "Hide" : "Show"}
                </Button>
                <Button size="sm" variant="danger" onClick={() => remove(r)}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <ReviewModal
          review={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            void load();
          }}
        />
      )}
    </Card>
  );
}

function ReviewModal({
  review,
  onClose,
  onSaved,
}: {
  review: SavedReview | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(review?.reviewer_name ?? "");
  const [rating, setRating] = useState(String(review?.rating ?? 5));
  const [text, setText] = useState(review?.review_text ?? "");
  const [source, setSource] = useState(review?.source ?? "google");
  const [reviewDate, setReviewDate] = useState(review?.review_date ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        reviewer_name: name,
        rating: Number(rating),
        review_text: text,
        source,
        review_date: reviewDate || null,
      };
      if (review) {
        await api.put(`/api/reviews/${review.id}`, body);
        toast.push("success", "Review updated");
      } else {
        await api.post("/api/reviews", body);
        toast.push("success", "Review added");
      }
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
      title={review ? "Edit review" : "Add review"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name || !text || busy} onClick={save}>
            {review ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <FormField label="Reviewer name" required>
        <input class="form-input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </FormField>
      <div class="form-row">
        <FormField label="Rating" required>
          <Select
            value={rating}
            options={[5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: `${n} ★` }))}
            onChange={setRating}
          />
        </FormField>
        <FormField label="Source">
          <Select
            value={source}
            options={REVIEW_SOURCES.map((s) => ({ value: s, label: formatStatus(s) }))}
            onChange={setSource}
          />
        </FormField>
      </div>
      <FormField label="Review date">
        <input
          class="form-input"
          type="date"
          value={reviewDate ?? ""}
          onInput={(e) => setReviewDate((e.target as HTMLInputElement).value)}
        />
      </FormField>
      <FormField label="Review text" required>
        <textarea class="form-textarea" value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
      </FormField>
    </Modal>
  );
}

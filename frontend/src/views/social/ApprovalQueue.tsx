import { useEffect, useRef, useState } from "preact/hooks";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Spinner } from "../../components/ui/Spinner";
import { Select } from "../../components/ui/Select";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatStatus, formatDateTime } from "../../lib/format";
import { SOCIAL_POST_TYPES, SOCIAL_TYPE_COLORS, type SocialPost } from "../../types";

interface Props {
  onEdit: (id: string, intent?: "default" | "approve") => void;
  /** Bumped by the parent to force a reload after external changes. */
  refreshKey: number;
}

/** Approval queue (spec §5.3): cards with preview, inline caption/hashtag edit,
 *  Approve / Edit&Approve / Reject / Delete, type+date filters, batch approve,
 *  and a mobile swipe interface (right = approve, left = reject). */
export function ApprovalQueue({ onEdit, refreshKey }: Props) {
  const toast = useToast();
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, { caption: string; hashtags: string }>>({});

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ posts: SocialPost[] }>("/api/social-posts/queue");
      setPosts(r.posts);
      const d: Record<string, { caption: string; hashtags: string }> = {};
      for (const p of r.posts) d[p.id] = { caption: p.caption, hashtags: (p.hashtags ?? []).join(" ") };
      setDrafts(d);
      setSelected(new Set());
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const visible = posts.filter((p) => !typeFilter || p.post_type === typeFilter);

  const act = async (p: SocialPost, action: "approve" | "reject" | "delete") => {
    try {
      if (action === "delete") {
        await api.del(`/api/social-posts/${p.id}`);
        toast.push("success", "Deleted.");
      } else if (action === "reject") {
        const reason = prompt("Reason for rejection?") ?? "";
        await api.post(`/api/social-posts/${p.id}/reject`, { rejection_reason: reason });
        toast.push("success", "Rejected.");
      } else {
        await api.post(`/api/social-posts/${p.id}/approve`, {});
        toast.push("success", "Approved.");
      }
      void load();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  const batchApprove = async () => {
    if (selected.size === 0) return;
    try {
      const r = await api.post<{ approved: number; total: number }>("/api/social-posts/approve-batch", {
        ids: [...selected],
      });
      toast.push("success", `Approved ${r.approved} of ${r.total}.`);
      void load();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Card>
      <div class="flex gap-md items-end mb-md flex-wrap">
        <div style={{ minWidth: 180 }}>
          <label class="form-label">Type</label>
          <Select
            value={typeFilter}
            placeholder="All types"
            onChange={setTypeFilter}
            options={SOCIAL_POST_TYPES}
          />
        </div>
        <Button variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
        {selected.size > 0 && (
          <Button variant="primary" onClick={batchApprove}>
            Approve {selected.size} selected
          </Button>
        )}
      </div>

      {loading && <Spinner center />}
      {!loading && visible.length === 0 && (
        <div class="empty-state">
          <div class="empty-state__title">Nothing waiting for approval 🎉</div>
        </div>
      )}

      <div class="flex flex-col gap-md">
        {visible.map((p) => (
          <QueueCard
            key={p.id}
            post={p}
            checked={selected.has(p.id)}
            draft={drafts[p.id]}
            onToggle={() => toggle(p.id)}
            onDraft={(d) => setDrafts((prev) => ({ ...prev, [p.id]: d }))}
            onEdit={() => onEdit(p.id)}
            onApprove={() => act(p, "approve")}
            onEditApprove={() => onEdit(p.id, "approve")}
            onReject={() => act(p, "reject")}
            onDelete={() => act(p, "delete")}
          />
        ))}
      </div>
    </Card>
  );
}

function QueueCard(props: {
  post: SocialPost;
  checked: boolean;
  draft: { caption: string; hashtags: string } | undefined;
  onToggle: () => void;
  onDraft: (d: { caption: string; hashtags: string }) => void;
  onEdit: () => void;
  onApprove: () => void;
  onEditApprove: () => void;
  onReject: () => void;
  onDelete: () => void;
}) {
  const { post: p, draft } = props;
  const startX = useRef<number | null>(null);
  const [dx, setDx] = useState(0);

  const onTouchStart = (e: TouchEvent) => {
    startX.current = e.touches[0].clientX;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (startX.current == null) return;
    setDx(e.touches[0].clientX - startX.current);
  };
  const onTouchEnd = () => {
    if (dx > 90) props.onApprove();
    else if (dx < -90) props.onReject();
    setDx(0);
    startX.current = null;
  };

  const hero =
    p.ai_generated_image_url ??
    (p.photos && p.photos.length > 0 ? p.photos[p.photos.length - 1].thumb_url : null);

  return (
    <div
      class="social-queue-card"
      style={{ transform: dx ? `translateX(${dx}px)` : undefined }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div class="social-queue-card__media">
        <input
          type="checkbox"
          checked={props.checked}
          onChange={props.onToggle}
          aria-label="Select for batch approve"
          class="social-queue-card__check"
        />
        {hero ? (
          <img src={hero} alt="" class="social-queue-card__thumb" />
        ) : (
          <div class="social-queue-card__thumb social-queue-card__thumb--empty">No image</div>
        )}
      </div>

      <div class="social-queue-card__body">
        <div class="flex gap-sm items-center flex-wrap mb-sm">
          <span class="social-dot" style={{ background: SOCIAL_TYPE_COLORS[p.post_type] }} />
          <Badge tone="neutral">{formatStatus(p.post_type)}</Badge>
          <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
            {p.scheduled_date ? formatDateTime(p.scheduled_date) : "unscheduled"}
          </span>
        </div>

        <textarea
          class="form-input"
          rows={3}
          value={draft?.caption ?? p.caption}
          onInput={(e) =>
            props.onDraft({ caption: (e.target as HTMLTextAreaElement).value, hashtags: draft?.hashtags ?? "" })
          }
        />
        <input
          class="form-input mt-sm"
          value={draft?.hashtags ?? ""}
          placeholder="#hashtags"
          onInput={(e) =>
            props.onDraft({ caption: draft?.caption ?? p.caption, hashtags: (e.target as HTMLInputElement).value })
          }
        />

        <div class="flex gap-sm flex-wrap mt-md">
          <Button size="sm" variant="secondary" onClick={props.onApprove}>
            Approve
          </Button>
          <Button size="sm" variant="primary" onClick={props.onEditApprove}>
            Edit &amp; Approve
          </Button>
          <Button size="sm" variant="tertiary" onClick={props.onEdit}>
            Open editor
          </Button>
          <Button size="sm" variant="tertiary" onClick={props.onReject}>
            Reject
          </Button>
          <Button size="sm" variant="danger" onClick={props.onDelete}>
            Delete
          </Button>
        </div>
        <div class="social-swipe-hint text--muted">Swipe right to approve · left to reject</div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "preact/hooks";
import { Modal } from "../../components/ui/Modal";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { Select } from "../../components/ui/Select";
import { Spinner } from "../../components/ui/Spinner";
import { useToast } from "../../store/toast";
import { api, ApiError } from "../../api";
import { formatStatus } from "../../lib/format";
import {
  SOCIAL_PLATFORMS,
  type SocialPost,
  type SocialPlatform,
} from "../../types";

interface Props {
  postId: string;
  onClose: () => void;
  /** Called after any persisted change so the parent list can refresh. */
  onChanged: () => void;
}

/** Post editor (spec §5.4): preview, caption + char count, hashtags, platform,
 *  schedule picker, regenerate caption/image, per-platform preview. */
export function PostEditor({ postId, onClose, onChanged }: Props) {
  const toast = useToast();
  const [post, setPost] = useState<SocialPost | null>(null);
  const [loading, setLoading] = useState(true);
  const [caption, setCaption] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [platform, setPlatform] = useState<SocialPlatform>("both");
  const [scheduled, setScheduled] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ post: SocialPost }>(`/api/social-posts/${postId}`);
      setPost(r.post);
      setCaption(r.post.caption ?? "");
      setHashtags((r.post.hashtags ?? []).join(" "));
      setPlatform(r.post.platform);
      setScheduled(toLocalInput(r.post.scheduled_date));
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  const published = post?.status === "published";

  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/api/social-posts/${postId}`, {
        caption,
        hashtags: hashtags.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean),
        platform,
        scheduled_date: scheduled ? fromLocalInput(scheduled) : null,
      });
      toast.push("success", "Saved.");
      onChanged();
      void load();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const regenCaption = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; unavailable?: boolean; applied?: string; message?: string }>(
        `/api/social-posts/${postId}/regenerate`,
        {},
      );
      if (!r.ok) {
        toast.push("warning", r.message ?? "AI unavailable — edit manually.");
      } else if (r.applied) {
        setCaption(r.applied);
        toast.push("success", "Caption regenerated.");
        onChanged();
      }
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const regenImage = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; unconfigured?: boolean; message?: string }>(
        `/api/social-posts/${postId}/generate-image`,
        {},
      );
      if (!r.ok) {
        toast.push("warning", r.message ?? "Image generation unavailable.");
      } else {
        toast.push("success", "Image generated.");
        onChanged();
        void load();
      }
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doAction = async (action: "approve" | "reject" | "publish") => {
    setBusy(true);
    try {
      const bodyReason =
        action === "reject" ? { rejection_reason: prompt("Reason for rejection?") ?? "" } : {};
      await api.post(`/api/social-posts/${postId}/${action}`, bodyReason);
      toast.push("success", `Post ${action === "publish" ? "published (simulated)" : action + "d"}.`);
      onChanged();
      if (action === "publish") onClose();
      else void load();
    } catch (e) {
      toast.push("error", e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const heroUrl =
    post?.ai_generated_image_url ??
    (post?.photos && post.photos.length > 0 ? post.photos[post.photos.length - 1].original_url : null);

  return (
    <Modal
      open
      title={post ? `${formatStatus(post.post_type)} post` : "Post"}
      onClose={onClose}
      footer={
        post && (
          <div class="flex gap-sm flex-wrap" style={{ justifyContent: "flex-end", width: "100%" }}>
            {!published && (
              <Button variant="secondary" onClick={save} disabled={busy}>
                Save
              </Button>
            )}
            {(post.status === "pending_approval" || post.status === "draft" || post.status === "rejected") && (
              <Button variant="primary" onClick={() => doAction("approve")} disabled={busy}>
                Approve
              </Button>
            )}
            {post.status === "pending_approval" && (
              <Button variant="danger" onClick={() => doAction("reject")} disabled={busy}>
                Reject
              </Button>
            )}
            {(post.status === "approved" || post.status === "failed") && (
              <Button variant="primary" onClick={() => doAction("publish")} disabled={busy}>
                Publish now (SIMULATE)
              </Button>
            )}
          </div>
        )
      }
    >
      {loading || !post ? (
        <Spinner center />
      ) : (
        <div class="flex flex-col gap-md">
          <div class="flex gap-sm items-center flex-wrap">
            <Badge status={post.status}>{formatStatus(post.status)}</Badge>
            <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
              via {formatStatus(post.generated_by)}
            </span>
            {post.rejection_reason && (
              <span class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
                · rejected: {post.rejection_reason}
              </span>
            )}
          </div>

          {/* Large preview */}
          <div class="social-preview">
            {heroUrl ? (
              <img src={heroUrl} alt="preview" class="social-preview__img" />
            ) : (
              <div class="social-preview__empty">
                No image yet.
                {(post.post_type === "seasonal_tips" || post.post_type === "tips_tricks") && (
                  <div class="text--muted" style={{ fontSize: "var(--text-xs)", marginTop: 4 }}>
                    Generate one or attach a photo.
                  </div>
                )}
              </div>
            )}
          </div>

          {!published && (
            <div class="flex gap-sm flex-wrap">
              <Button size="sm" variant="tertiary" onClick={regenCaption} disabled={busy}>
                ✨ Regenerate Caption
              </Button>
              <Button size="sm" variant="tertiary" onClick={regenImage} disabled={busy}>
                🖼 Regenerate Image
              </Button>
            </div>
          )}

          <div>
            <label class="form-label">
              Caption{" "}
              <span class="text--muted" style={{ fontWeight: 400 }}>
                ({caption.length} chars)
              </span>
            </label>
            <textarea
              class="form-input"
              rows={5}
              value={caption}
              disabled={published}
              onInput={(e) => setCaption((e.target as HTMLTextAreaElement).value)}
            />
          </div>

          <div>
            <label class="form-label">Hashtags</label>
            <textarea
              class="form-input"
              rows={2}
              value={hashtags}
              disabled={published}
              onInput={(e) => setHashtags((e.target as HTMLTextAreaElement).value)}
              placeholder="#LittleRock #HomeRemodel ..."
            />
          </div>

          <div class="flex gap-md flex-wrap">
            <div style={{ minWidth: 200 }}>
              <label class="form-label">Platform</label>
              <Select
                value={platform}
                disabled={published}
                onChange={(v) => setPlatform(v as SocialPlatform)}
                options={SOCIAL_PLATFORMS}
              />
            </div>
            <div style={{ minWidth: 220 }}>
              <label class="form-label">Scheduled date</label>
              <input
                class="form-input"
                type="datetime-local"
                value={scheduled}
                disabled={published}
                onInput={(e) => setScheduled((e.target as HTMLInputElement).value)}
              />
            </div>
          </div>

          {/* Per-platform preview hint */}
          <div class="text--muted" style={{ fontSize: "var(--text-xs)" }}>
            {platform === "both"
              ? "Will post to Facebook and Instagram."
              : platform === "facebook_only"
                ? "Facebook only."
                : "Instagram only."}
            {post.facebook_url && (
              <>
                {" · "}
                <a href={post.facebook_url} target="_blank" rel="noreferrer">
                  Facebook ↗
                </a>
              </>
            )}
            {post.instagram_url && (
              <>
                {" · "}
                <a href={post.instagram_url} target="_blank" rel="noreferrer">
                  Instagram ↗
                </a>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(local: string): string {
  const d = new Date(local);
  return isNaN(d.getTime()) ? local : d.toISOString();
}
